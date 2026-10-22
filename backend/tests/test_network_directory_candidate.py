from datetime import date
from io import BytesIO
from xml.sax.saxutils import escape
import zipfile

import pytest
from sqlalchemy import text

from app.services.data_foundation.network_directory_candidate import (
    ALL_UNIT_TYPES, HEADERS, OPERATIONAL_BASE_TYPES, SHEET_NAME,
    audit_candidate, build_candidate_resolver, parse_network_directory,
)
from app.services.data_foundation.repository import load_mapping_resolver
from app.services.data_foundation.xlsx_parser import WorkbookValidationError, _resolve_mapping
from app.services.data_foundation.queries import _query_plan
from test_collection_monitoring_v2_queries import _create_engine, _insert_day, ADMIN_MATRIX, ADMIN_REGIONAL, MAPPING_ID


def workbook(rows, *, dimension="A1:A1", headers=HEADERS, sheet=SHEET_NAME, numeric_code=False):
    def row_xml(index, values):
        cells = []
        for col, value in enumerate(values):
            if value is None:
                continue
            reference = f"{chr(65 + col)}{index}"
            if numeric_code and index > 1 and col == 0:
                cells.append(f'<c r="{reference}"><v>{value}</v></c>')
            else:
                cells.append(f'<c r="{reference}" t="inlineStr"><is><t xml:space="preserve">{escape(str(value))}</t></is></c>')
        return f'<row r="{index}">{"".join(cells)}</row>'
    content = BytesIO()
    with zipfile.ZipFile(content, "w") as z:
        z.writestr("xl/workbook.xml", f'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="{sheet}" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="{dimension}"/><sheetData>{row_xml(1, headers)}'+ "".join(row_xml(i, r) for i, r in enumerate(rows, 2)) + '</sheetData></worksheet>')
    return content.getvalue()


def unit(code="001", name="Base", region="SR", kind="Próprio 自营", status="启用"):
    return [code, name, region, None, None, None, None, None, kind, None, None, status, "2026-10-21"]


def test_real_cells_override_wrong_dimensions_and_codes_keep_case_and_leading_zeroes():
    candidate = parse_network_directory(workbook([unit("001"), unit("abc", "Second"), unit("ABC", "Third"), [None] * 12 + ["2026-10-21"]]))
    assert not candidate.errors
    assert [u["base_code"] for u in candidate.units] == ["001", "abc", "ABC"]
    assert len(candidate.excluded_rows) == 1
    assert all(u["regional_name"] == "SR" for u in candidate.units)
    assert candidate.as_dict()["canPublish"] is False
    assert candidate.as_dict()["mapVersionId"] is None
    assert all(u["rm_responsible"] is None for u in candidate.units)


@pytest.mark.parametrize("raw,normalized,operational", [
    ("Próprio 自营", "OWN", True), ("Franquia 加盟", "FRANCHISE", True),
    ("PA", "PA", False), ("DC", "DC", False), ("SC", "SC", False),
])
def test_unit_categories_remain_distinct_and_originals_are_preserved(raw, normalized, operational):
    u = parse_network_directory(workbook([unit(kind=raw)])).units[0]
    assert (u["unit_type_raw"], u["unit_type"], u["is_operational_base"]) == (raw, normalized, operational)


@pytest.mark.parametrize("rows,numeric", [
    ([unit("001"), unit("001")], False),
    ([unit(None)], False), ([unit(" 001")], False), ([unit("001")], True),
    ([unit(kind="Other")], False), ([unit(status="停用")], False),
])
def test_unconfirmed_identifiers_duplicates_types_and_statuses_block_simulation(rows, numeric):
    candidate = parse_network_directory(workbook(rows, numeric_code=numeric))
    assert candidate.errors
    with pytest.raises(WorkbookValidationError):
        build_candidate_resolver(candidate, included_types=ALL_UNIT_TYPES)


def test_strict_real_header_and_sheet_do_not_fall_back_to_legacy():
    with pytest.raises(WorkbookValidationError):
        parse_network_directory(workbook([unit()], headers=HEADERS[:-1]))
    with pytest.raises(WorkbookValidationError):
        parse_network_directory(workbook([unit()], sheet="Ativas"))


def test_name_resolution_uses_existing_exact_and_conservative_rules_and_never_region_fallback():
    candidate = parse_network_directory(workbook([
        unit("001", "Base One"), unit("002", "DUP"), unit("003", "dup", kind="PA")
    ]))
    resolver = build_candidate_resolver(candidate, included_types=ALL_UNIT_TYPES)
    assert _resolve_mapping("collection_monitoring", {"source_base_name": "base  ONE"}, resolver, 2) == ("001", "NAME_APPROVED")
    assert _resolve_mapping("collection_monitoring", {"source_base_name": "DUP"}, resolver, 2) == ("002", "NAME_APPROVED")
    assert _resolve_mapping("collection_monitoring", {"source_base_name": " Dup "}, resolver, 2) == (None, "AMBIGUOUS")
    assert _resolve_mapping("collection_monitoring", {"source_base_name": "Missing", "reported_origin_region": "SR"}, resolver, 2) == (None, "UNMAPPED")
    assert _resolve_mapping("pdd_collection_failure", {"source_base_code": "missing", "source_base_name": "Base One"}, resolver, 2) == (None, "UNMAPPED")
    bases = build_candidate_resolver(candidate, included_types=OPERATIONAL_BASE_TYPES)
    assert bases.base_codes == frozenset({"001", "002"})


def test_audit_preserves_removed_units_and_flags_manual_decisions_without_copying_them():
    old = [{"base_code": "001", "base_name": "Old", "regional_name": "CE", "rm_region": "CE-X", "rm_responsible": "Before"},
           {"base_code": "gone", "base_name": "Gone", "regional_name": "CE"}]
    candidate = parse_network_directory(workbook([unit("001", "New", "SR"), unit("new", "New")]))
    decision = {"source_id": "collection_monitoring", "source_base_name": "Old", "resolution_state": "LINKED", "target_base_code": "gone"}
    audit = audit_candidate(candidate, old, previous_sha256="oldhash", manual_decisions=[decision])
    assert audit["commonCodes"] == 1
    assert audit["missingUnits"][0]["base_code"] == "gone"
    assert audit["changes"]["regional_name"] == [{"base_code": "001", "before": "CE", "after": "SR"}]
    assert audit["duplicateNamesExact"] == {"New": ["001", "new"]}
    assert audit["manualDecisionReview"][0]["candidateTargetPresent"] is False
    assert not build_candidate_resolver(candidate, included_types=ALL_UNIT_TYPES).name_decisions


def test_map_switch_redistributes_only_authorized_rows_and_keeps_history_facts_and_exports():
    engine, contract, table = _create_engine()
    _insert_day(engine, contract, table, day=22, rows=[(1, True), (2, False), (3, False)])
    candidate = parse_network_directory(workbook([unit("MATCHED-001", "Mapped base", "CE")]))
    new_id = b"n" * 16
    with engine.begin() as conn:
        conn.execute(text(f"UPDATE `{table}` SET source_base_name='Removed base', resolved_base_code='REMOVED', mapping_resolution='NAME_APPROVED' WHERE source_row_no=2"))
        conn.execute(text("INSERT INTO base_mapping_entries VALUES (:id,'REMOVED','SPE','Removed base','SP','SPE','RM Old')"), {"id": MAPPING_ID})
        conn.execute(text("INSERT INTO base_mapping_versions VALUES (:id,'PREPARED')"), {"id": new_id})
        for u in candidate.units:
            conn.execute(text("INSERT INTO base_mapping_entries VALUES (:id,:base_code,:regional_name,:base_name,NULL,:rm_region,:rm_responsible)"), {"id": new_id, **u})
    def records(identity):
        plan = _query_plan("collection_monitoring", identity, contract_version=2, date_from=date(2026,10,22), date_to=date(2026,10,22), sql_dialect="sqlite")
        with engine.connect() as conn:
            return list(conn.execute(text(f"SELECT {plan.select_sql} {plan.from_sql} WHERE {plan.where_sql}"), plan.parameters).mappings())
    base = {"role":"regional","organizational_scope":"base","home_base":"MATCHED-001"}
    before = records(ADMIN_MATRIX)
    assert len(records(ADMIN_REGIONAL)) == 2
    # Preparation never changes the pointer.
    assert len(before) == 3 and len(records(base)) == 1
    with engine.begin() as conn:
        conn.execute(text("UPDATE base_mapping_versions SET version_state='PUBLISHED' WHERE map_version_id=:id"), {"id":new_id})
        conn.execute(text("UPDATE base_mapping_current SET map_version_id=:id"), {"id":new_id})
    after = records(ADMIN_MATRIX)
    assert len(after) == len(before) == 3
    assert sum(r["expected_dropoff"] for r in before) == sum(r["expected_dropoff"] for r in after)
    assert len(records(ADMIN_REGIONAL)) == 0  # ADMIN does not imply national access.
    ce = {**ADMIN_REGIONAL,"effective_regions":["CE"]}
    assert len(records(ce)) == 1 and len(records(base)) == 1
    assert [r["effective_base_code"] for r in after].count(None) == 2
    # Raw exported contract fields and persisted facts are unchanged.
    assert [[r[c.key] for c in contract.columns] for r in before] == [[r[c.key] for c in contract.columns] for r in after]
    with engine.connect() as conn:
        historical = load_mapping_resolver(conn,source_id="collection_monitoring",map_version_id=MAPPING_ID)
        current = load_mapping_resolver(conn,source_id="collection_monitoring")
    assert "REMOVED" in historical.base_codes and "REMOVED" not in current.base_codes
    # Controlled rollback in the isolated test restores scope; no published row is edited.
    with engine.begin() as conn:
        conn.execute(text("UPDATE base_mapping_current SET map_version_id=:id"), {"id":MAPPING_ID})
    assert len(records(ADMIN_REGIONAL)) == 2


def test_admin_preview_reads_current_version_and_decisions_without_writing_or_activating():
    from sqlalchemy import event
    from app.services.data_foundation.network_directory_candidate import preview_network_directory
    engine, _, _ = _create_engine()
    with engine.begin() as conn:
        conn.exec_driver_sql("ALTER TABLE base_mapping_versions ADD COLUMN file_sha256 BLOB")
        conn.execute(text("UPDATE base_mapping_versions SET file_sha256=:sha"), {"sha": b"h"*32})
        conn.execute(text("INSERT INTO base_mapping_name_decisions VALUES (:id,'collection_monitoring','Former','LINKED','REMOVED')"), {"id":MAPPING_ID})
    statements = []
    event.listen(engine,"before_cursor_execute",lambda _c,_cu,sql,_p,_ctx,_m:statements.append(sql))
    preview = preview_network_directory(engine,workbook([unit("MATCHED-001","Mapped base","CE")]))
    assert preview["canPublish"] is False and preview["requiresSchemaApproval"] is True
    assert preview["previousMapVersionId"] is not None
    assert preview["audit"]["manualDecisionReview"][0]["candidateTargetPresent"] is False
    assert preview["audit"]["changes"]["regional_name"][0]["after"] == "CE"
    assert all(sql.strip().upper().startswith("SELECT") for sql in statements)
    with engine.connect() as conn:
        assert conn.execute(text("SELECT map_version_id FROM base_mapping_current")).scalar_one() == MAPPING_ID


def test_preview_endpoint_requires_explicit_platform_matrix_admin_and_has_no_publish_action(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.api.dependencies import get_current_viewer
    from types import SimpleNamespace
    seen = []
    monkeypatch.setattr("app.api.data_foundation._require_feature",lambda **_kw:None)
    monkeypatch.setattr("app.api.data_foundation._same_origin",lambda _r:None)
    monkeypatch.setattr("app.api.data_foundation._engine",lambda:object())
    monkeypatch.setattr("app.api.data_foundation.preview_network_directory",lambda _e,content:seen.append(content) or {"canPublish":False})
    path="/api/v2/base-mapping/network-directory/preview"
    with TestClient(app) as client:
        assert client.post(path,files={"file":("official.xlsx",workbook([unit()]))}).status_code == 401
        assert seen == []
        for role, scope in (("USER","matrix"),("ADMIN","regional")):
            app.dependency_overrides[get_current_viewer]=lambda role=role, scope=scope:SimpleNamespace(user=SimpleNamespace(id=1,platform_role=role),identity={"administrative_scope":scope})
            assert client.post(path,files={"file":("official.xlsx",workbook([unit()]))}).status_code == 403
        assert seen == []
        app.dependency_overrides[get_current_viewer]=lambda:SimpleNamespace(user=SimpleNamespace(id=1,platform_role="ADMIN"),identity={"administrative_scope":"matrix"})
        response=client.post(path,files={"file":("official.xlsx",workbook([unit()]))})
        assert response.status_code == 200 and response.json()["canPublish"] is False
        assert client.post("/api/v2/base-mapping/network-directory/publish").status_code == 404
    assert len(seen)==1
