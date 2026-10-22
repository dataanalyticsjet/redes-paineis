from pathlib import Path
import hashlib
import json

import pytest
from sqlalchemy import event, text
from app.services.data_foundation.contracts import NETWORK_DIRECTORY_CONTRACT, contract_sha256
from app.services.data_foundation.network_directory_candidate import preview_network_directory, parse_network_directory, audit_candidate
from app.services.data_foundation.network_directory_versioning import prepare_network_directory_candidate
from app.services.data_foundation.repository import DataFoundationError
from test_network_directory_candidate import workbook, unit
from test_collection_monitoring_v2_queries import _create_engine, MAPPING_ID, ADMIN_MATRIX


def prepared_schema():
    engine, contract, table = _create_engine()
    with engine.begin() as c:
        for definition in (
            "version_no INTEGER DEFAULT 1", "source_id TEXT DEFAULT 'base_mapping_official'",
            "source_job_id BLOB", "contract_version INTEGER DEFAULT 1", "original_file_name TEXT",
            "file_sha256 BLOB", "mapping_row_count INTEGER", "published_by_user_id INTEGER",
            "published_at TEXT", "candidate_metadata TEXT",
        ):
            c.exec_driver_sql("ALTER TABLE base_mapping_versions ADD COLUMN " + definition)
        c.execute(text("UPDATE base_mapping_versions SET file_sha256=:sha,published_by_user_id=1,published_at='2026-10-01'"),{"sha":b"h"*32})
        c.exec_driver_sql("ALTER TABLE base_mapping_entries ADD COLUMN base_description TEXT")
        c.exec_driver_sql("ALTER TABLE base_mapping_entries ADD COLUMN source_row_no INTEGER")
        c.exec_driver_sql("ALTER TABLE base_mapping_entries ADD COLUMN unit_metadata TEXT")
        c.exec_driver_sql("ALTER TABLE base_mapping_current ADD COLUMN changed_at TEXT DEFAULT '2026-10-01'")
        c.exec_driver_sql("CREATE TABLE data_source_registry (source_id TEXT PRIMARY KEY,source_state TEXT)")
        c.exec_driver_sql("INSERT INTO data_source_registry VALUES ('base_mapping_official','ACTIVE')")
        c.exec_driver_sql("CREATE TABLE source_contract_versions (source_id TEXT,contract_version INTEGER,contract_state TEXT,contract_sha256 BLOB)")
        c.execute(text("INSERT INTO source_contract_versions VALUES ('base_mapping_official',2,'DISCOVERED',:sha)"),{"sha":contract_sha256(NETWORK_DIRECTORY_CONTRACT)})
        c.exec_driver_sql("""CREATE TABLE import_jobs (job_id BLOB PRIMARY KEY,source_id TEXT,contract_version INTEGER,
            validation_map_version_id BLOB,submitted_by_user_id INTEGER,job_state TEXT,original_file_name TEXT,
            stored_file_key TEXT,file_size_bytes INTEGER,file_sha256 BLOB,input_row_count INTEGER,valid_row_count INTEGER,
            error_count INTEGER,request_id TEXT,validated_at TEXT)""")
        c.exec_driver_sql("""CREATE TABLE data_audit_events (actor_user_id INTEGER,action_code TEXT,object_type TEXT,
            object_id BLOB,request_id TEXT,event_context TEXT)""")
    return engine, contract, table


def arguments(engine, directory, content=None, **updates):
    content = content or workbook([unit("001","One"),unit("002","Sorting",kind="SC")])
    preview = preview_network_directory(engine,content)
    return dict(engine=engine,content=content,file_name="official.xlsx",actor_user_id=1,staging_directory=directory,
                expected_map_version_id=preview["previousMapVersionId"],review_sha256=preview["reviewSha256"],
                idempotency_key="candidate-request-1",**updates)


def test_prepare_is_immutable_candidate_with_all_metadata_no_decisions_and_unchanged_current(tmp_path):
    engine,_,_=prepared_schema()
    args=arguments(engine,tmp_path)
    statements=[]
    event.listen(engine,"before_cursor_execute",lambda _c,_cu,sql,_p,_ctx,_m:statements.append(sql))
    result=prepare_network_directory_candidate(**args)
    assert result["state"]=="PREPARED" and result["canPublish"] is False and result["version"]==2
    assert not any("UPDATE base_mapping_current" in sql for sql in statements)
    with engine.connect() as c:
        assert c.execute(text("SELECT map_version_id FROM base_mapping_current")).scalar_one()==MAPPING_ID
        v=c.execute(text("SELECT * FROM base_mapping_versions WHERE version_state='PREPARED'")).mappings().one()
        assert v["published_at"] is None and v["published_by_user_id"] is None
        meta=json.loads(v["candidate_metadata"]);assert meta["approvalState"]=="PENDING"
        rows=c.execute(text("SELECT unit_metadata FROM base_mapping_entries WHERE map_version_id=:id ORDER BY base_code"),{"id":v["map_version_id"]}).scalars().all()
        units=[json.loads(s) for s in rows]
        assert len(units)==2 and len([u for u in units if u["is_operational_base"]])==1
        assert units[1]["unit_type"]=="SC"
        assert len(c.execute(text("SELECT * FROM base_mapping_name_decisions")).all())==0
        job=c.execute(text("SELECT * FROM import_jobs")).mappings().one()
        assert job["job_state"]=="VALIDATED" and hashlib.sha256((tmp_path/job["stored_file_key"]).read_bytes()).digest()==job["file_sha256"]
        for column in NETWORK_DIRECTORY_CONTRACT.columns:
            assert column.key in units[0]
    assert prepare_network_directory_candidate(**args)["reused"] is True
    assert len(list(tmp_path.glob("*.xlsx")))==1


def test_changed_file_review_decisions_and_aborted_candidate_cannot_reuse_request(tmp_path):
    engine,_,_=prepared_schema();args=arguments(engine,tmp_path)
    result=prepare_network_directory_candidate(**args)
    with pytest.raises(DataFoundationError,match="idempotency_conflict"):
        prepare_network_directory_candidate(**{**args,"content":workbook([unit("009")])})
    with engine.begin() as c:
        c.execute(text("UPDATE base_mapping_versions SET version_state='ABORTED' WHERE version_no=:v"),{"v":result["version"]})
    with pytest.raises(DataFoundationError,match="idempotency_conflict"):
        prepare_network_directory_candidate(**args)


@pytest.mark.parametrize("cause",["revision","decision","invalid_file"])
def test_stale_or_invalid_review_creates_no_job_or_candidate(tmp_path,cause):
    engine,_,_=prepared_schema();args=arguments(engine,tmp_path)
    if cause=="revision":
        args["expected_map_version_id"]="00000000-0000-0000-0000-000000000001"
    elif cause=="invalid_file":
        args["content"]=workbook([unit("001"),unit("001")])
    else:
        with engine.begin() as c:
            c.execute(text("INSERT INTO base_mapping_name_decisions VALUES (:id,'collection_monitoring','Mapped base','LINKED','MATCHED-001')"),{"id":MAPPING_ID})
    with pytest.raises(DataFoundationError):
        prepare_network_directory_candidate(**args)
    with engine.connect() as c:
        assert c.execute(text("SELECT COUNT(*) FROM base_mapping_versions")).scalar_one()==1
        assert c.execute(text("SELECT COUNT(*) FROM import_jobs")).scalar_one()==0


def test_failure_rolls_back_whole_candidate_and_preserves_private_source_for_audit(tmp_path,monkeypatch):
    engine,_,_=prepared_schema();args=arguments(engine,tmp_path)
    monkeypatch.setattr("app.services.data_foundation.network_directory_versioning._write_audit",lambda *_a,**_k:(_ for _ in ()).throw(RuntimeError("forced failure")))
    with pytest.raises(RuntimeError):
        prepare_network_directory_candidate(**args)
    with engine.connect() as c:
        assert c.execute(text("SELECT COUNT(*) FROM base_mapping_versions")).scalar_one()==1
        assert c.execute(text("SELECT COUNT(*) FROM import_jobs")).scalar_one()==0
        assert c.execute(text("SELECT COUNT(*) FROM base_mapping_entries")).scalar_one()==1
        assert c.execute(text("SELECT map_version_id FROM base_mapping_current")).scalar_one()==MAPPING_ID
    assert len(list(tmp_path.glob("*.xlsx")))==1


def test_manual_decision_compatibility_and_new_ambiguity_are_explicit():
    old=[{"base_code":"001","base_name":"Base","regional_name":"SR","rm_region":None,"rm_responsible":None}]
    new=parse_network_directory(workbook([unit("001","Base"),unit("002","Base",kind="DC")]))
    result=audit_candidate(new,old,previous_sha256="x",manual_decisions=[{"source_base_name":"Base","resolution_state":"LINKED","target_base_code":"001"}])
    review=result["manualDecisionReview"][0]
    assert review["compatibleTarget"] is True and review["becameAmbiguous"] is True
    assert review["reviewRequired"] is True


def test_metadata_base_counter_excludes_non_operational_units_without_excluding_facts(monkeypatch):
    from app.core.config import get_settings
    from app.services.data_foundation.queries import get_current_mapping_status,get_records
    from test_collection_monitoring_v2_queries import _insert_day
    engine,contract,table=prepared_schema()
    monkeypatch.setattr(get_settings(),"data_mapping_unit_metadata_enabled",True)
    with engine.begin() as c:
        c.execute(text("UPDATE base_mapping_entries SET unit_metadata=:meta"),{"meta":json.dumps({"unit_type":"PA"})})
    _insert_day(engine,contract,table,day=22,rows=[(1,True),(2,False)])
    status=get_current_mapping_status(engine,identity=ADMIN_MATRIX)
    assert status["visibleBaseCount"]==0
    records=get_records(engine,source_id="collection_monitoring",identity=ADMIN_MATRIX,contract_version=2,limit=250,offset=0)
    assert records["total"]==2 and len(records["records"])==2
    assert records["records"][0]["mapped_unit_type"]=="PA"


def test_revision_change_during_records_cannot_return_mixed_counts_and_mapping(monkeypatch):
    from app.services.data_foundation.mapping_revision import revision_token
    from test_collection_monitoring_v2_queries import _insert_day
    engine,contract,table=prepared_schema()
    _insert_day(engine,contract,table,day=22,rows=[(1,True)])
    changed_id=b"z"*16
    monkeypatch.setattr("app.api.data_foundation._engine",lambda:engine)
    monkeypatch.setattr("app.api.data_foundation._require_feature",lambda **_kw:None)
    monkeypatch.setattr("app.services.data_foundation.mapping_revision.read_revision",lambda _engine:{"revision":revision_token(changed_id),"mappingVersionId":"new"})
    # SQLite in-memory connection belongs to this test; exercise the service request context
    # directly to avoid cross-thread fixture connection rules.
    from app.services.data_foundation.mapping_revision import request_revision
    from app.services.data_foundation.queries import get_records
    token=request_revision.set({"expected":revision_token(MAPPING_ID),"observed":None})
    try:
        with pytest.raises(DataFoundationError,match="mapping_revision_changed"):
            get_records(engine,source_id="collection_monitoring",identity=ADMIN_MATRIX,contract_version=2,limit=250,offset=0)
    finally:
        request_revision.reset(token)


def test_guard_pins_expected_current_map_and_stale_browser_header_never_selects_history():
    from app.services.data_foundation.mapping_revision import request_revision,revision_token
    from app.services.data_foundation.queries import get_records,_query_plan
    engine,contract,table=prepared_schema()
    from test_collection_monitoring_v2_queries import _insert_day
    _insert_day(engine,contract,table,day=22,rows=[(1,True)])
    token=request_revision.set({"expected":revision_token(b"x"*16),"observed":None})
    try:
        plan=_query_plan("collection_monitoring",ADMIN_MATRIX,contract_version=2,sql_dialect="sqlite")
        assert "ON current_map.current_key = 'OFFICIAL' AND current_map.map_version_id = :requested_map_version" in plan.mapping_from_sql
        with pytest.raises(DataFoundationError,match="mapping_revision_changed"):
            get_records(engine,source_id="collection_monitoring",identity=ADMIN_MATRIX,contract_version=2,limit=250,offset=0)
    finally:request_revision.reset(token)


def test_revision_token_changes_when_pointer_returns_to_same_map():
    from app.services.data_foundation.mapping_revision import revision_token
    assert revision_token(MAPPING_ID,"2026-10-22 10:00:00.000001") != revision_token(MAPPING_ID,"2026-10-22 10:00:00.000002")


def test_http_response_guard_rejects_changed_revision_and_exposes_current_token(monkeypatch):
    from fastapi.testclient import TestClient
    from types import SimpleNamespace
    from app.main import app
    from app.api.dependencies import get_current_viewer
    from app.services.data_foundation.mapping_revision import observe_revision,revision_token
    def fake_records(_engine,**_kwargs):
        observe_revision(MAPPING_ID)
        return {"sourceId":"collection_monitoring","records":[],"total":0,"limit":250,"offset":0}
    monkeypatch.setattr("app.api.data_foundation.get_records",fake_records)
    monkeypatch.setattr("app.api.data_foundation._engine",lambda:object())
    monkeypatch.setattr("app.api.data_foundation._require_feature",lambda **_kw:None)
    current={"revision":revision_token(MAPPING_ID)}
    monkeypatch.setattr("app.services.data_foundation.mapping_revision.read_revision",lambda _e:current)
    app.dependency_overrides[get_current_viewer]=lambda:SimpleNamespace(identity=ADMIN_MATRIX)
    path="/api/v2/data-sources/collection_monitoring/records?contract_version=2"
    with TestClient(app) as client:
        response=client.get(path)
        assert response.status_code==200 and response.headers["X-Doomsday-Revision"]==revision_token(MAPPING_ID)
        current["revision"]=revision_token(b"z"*16)
        response=client.get(path)
        assert response.status_code==409 and response.json()["detail"]=="mapping_revision_changed"
        assert response.headers["X-Doomsday-Revision"]==current["revision"]


def test_missing_manual_schema_blocks_candidate_before_staging(tmp_path):
    engine,_,_=_create_engine()
    with pytest.raises(DataFoundationError,match="mapping_candidate_schema_not_ready"):
        prepare_network_directory_candidate(engine,content=workbook([unit()]),file_name="official.xlsx",actor_user_id=1,
            staging_directory=tmp_path,expected_map_version_id="old",review_sha256="x"*64,idempotency_key="request-123")
    assert not list(tmp_path.iterdir())


def test_actual_official_workbook_prepares_all_units_and_metadata_only_in_isolated_sqlite(tmp_path):
    source=Path(r"C:\Users\phelippe.cardoso\Downloads\网络管理通讯录 Lista de contatos da Gestão de Rede.xlsx")
    if not source.exists():
        pytest.skip("Official local workbook is not available on this machine")
    content=source.read_bytes()
    candidate=parse_network_directory(content)
    assert not candidate.errors
    engine,_,_=prepared_schema()
    args=arguments(engine,tmp_path,content=content)
    result=prepare_network_directory_candidate(**args)
    assert result["state"]=="PREPARED" and result["rowCount"]==len(candidate.units)
    with engine.connect() as c:
        new_id=c.execute(text("SELECT map_version_id FROM base_mapping_versions WHERE version_state='PREPARED'")).scalar_one()
        payloads=[json.loads(v) for v in c.execute(text("SELECT unit_metadata FROM base_mapping_entries WHERE map_version_id=:id ORDER BY source_row_no"),{"id":new_id}).scalars()]
        assert payloads==list(candidate.units)
        assert {u["unit_type"] for u in payloads}=={"OWN","FRANCHISE","PA","DC","SC"}
        assert c.execute(text("SELECT map_version_id FROM base_mapping_current")).scalar_one()==MAPPING_ID
        assert c.execute(text("SELECT COUNT(*) FROM base_mapping_versions WHERE version_state='PUBLISHED'")).scalar_one()==1


def test_new_official_unit_is_visible_only_within_its_authorized_region_and_exact_base():
    from app.services.data_foundation.queries import get_records
    from test_collection_monitoring_v2_queries import _insert_day, ADMIN_REGIONAL
    engine,contract,table=prepared_schema()
    _insert_day(engine,contract,table,day=22,rows=[(1,True),(2,False)])
    new_id=b"q"*16
    with engine.begin() as c:
        c.execute(text("INSERT INTO base_mapping_versions (map_version_id,version_state,version_no) VALUES (:id,'PUBLISHED',2)"),{"id":new_id})
        c.execute(text("""INSERT INTO base_mapping_entries
            (map_version_id,base_code,regional_name,base_name,rm_region,rm_responsible,unit_metadata)
            VALUES (:id,'MATCHED-001','SPE','Mapped base','NEW-RM','NEW PERSON',NULL),
                   (:id,'NEW-001','CE','Unmapped source name',NULL,NULL,:meta)"""),
            {"id":new_id,"meta":json.dumps({"unit_type":"PA"})})
        c.execute(text("UPDATE base_mapping_current SET map_version_id=:id"),{"id":new_id})
    def rows(identity):
        return get_records(engine,source_id="collection_monitoring",identity=identity,contract_version=2,limit=250,offset=0)["records"]
    national=rows(ADMIN_MATRIX)
    assert len(national)==2 and sum(r["expected_dropoff"] for r in national)==3
    assert len(rows(ADMIN_REGIONAL))==1
    assert len(rows({**ADMIN_REGIONAL,"effective_regions":["CE"]}))==1
    assert len(rows({"role":"regional","organizational_scope":"base","home_base":"NEW-001"}))==1
    assert rows({"role":"regional","organizational_scope":"base","home_base":"MISSING"})==[]
