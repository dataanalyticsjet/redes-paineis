from __future__ import annotations

import os
import tempfile
import uuid
import zipfile
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from sqlalchemy import Engine, text
from sqlalchemy.engine import Connection

from app.services.data_foundation.contracts import get_contract
from app.services.data_foundation.queries import _assert_map_available, _query_plan
from app.services.data_foundation.repository import DataFoundationError


SOURCE_ID = "collection_monitoring_t4_t5"
CONTRACT_VERSION = 1
MAX_PAGE_SIZE = 250
MAX_GROUP_PAGE_SIZE = 200
MAX_XLSX_DATA_ROWS = 1_048_575

STATUS_COLUMNS = (
    "awaiting_collection",
    "received_at_dropoff",
    "collected",
    "received",
    "received_at_base",
    "in_base_dispatch_flow",
    "arrived_at_sc",
)

GROUP_COLUMNS: dict[str, tuple[tuple[str, str], ...]] = {
    "region": (("COALESCE(effective_entry.regional_name, 'Sem regional')", "regional_name"),),
    "rm": (
        ("COALESCE(effective_entry.regional_name, 'Sem regional')", "regional_name"),
        ("COALESCE(effective_entry.rm_region, 'Sem região do RM')", "rm_region"),
        ("COALESCE(effective_entry.rm_responsible, 'Sem RM')", "rm_responsible"),
    ),
    "pdd": (
        ("COALESCE(effective_entry.regional_name, 'Sem regional')", "regional_name"),
        ("COALESCE(fact.source_base_name, 'Sem PDD')", "source_base_name"),
        ("COALESCE(effective_entry.rm_region, 'Sem região do RM')", "rm_region"),
        ("COALESCE(effective_entry.rm_responsible, 'Sem RM')", "rm_responsible"),
    ),
    "customer": (("COALESCE(fact.customer_name, 'Sem cliente')", "customer_name"),),
    "store": (
        ("COALESCE(fact.store_name, 'Sem loja')", "store_name"),
        ("COALESCE(fact.seller_id, '')", "seller_id"),
    ),
    "driver": (("COALESCE(fact.assigned_driver, 'Sem motorista')", "assigned_driver"),),
}


@dataclass(frozen=True)
class T4T5Filters:
    region: str | None = None
    rm_regional: str | None = None
    base_code: str | None = None
    source_base_name: str | None = None
    rm_region: str | None = None
    rm_responsible: str | None = None
    customer_name: str | None = None
    store_name: str | None = None
    seller_id: str | None = None
    assigned_driver: str | None = None
    order_origin: str | None = None
    search: str | None = None


def _active(value: str | None) -> bool:
    return value is not None and value != ""


def _validated_filters(filters: T4T5Filters) -> T4T5Filters:
    for value in filters.__dict__.values():
        if value is not None and len(value) > 191:
            raise DataFoundationError("filter_value_too_long", 422)
    return filters


def _query(
    engine: Engine,
    identity: dict[str, Any],
    filters: T4T5Filters,
    *,
    date_from: date | None = None,
    date_to: date | None = None,
):
    filters = _validated_filters(filters)
    if date_from and date_to and date_from > date_to:
        raise DataFoundationError("date_range_invalid", 422)
    plan = _query_plan(
        SOURCE_ID,
        identity,
        contract_version=CONTRACT_VERSION,
        date_from=date_from,
        date_to=date_to,
        base_code=filters.base_code,
        region=filters.region,
        sql_dialect=engine.dialect.name,
    )
    predicates: list[str] = []
    parameters = dict(plan.parameters)
    exact_fields = (
        ("fact.source_base_name", filters.source_base_name),
        ("fact.order_origin", filters.order_origin),
    )
    for index, (field, value) in enumerate(exact_fields):
        if _active(value):
            key = f"t4t5_exact_{index}"
            predicates.append(f"{field} = :{key}")
            parameters[key] = value
    for field, value, missing_label in (
        ("effective_entry.regional_name", filters.rm_regional, "Sem regional"),
        ("effective_entry.rm_region", filters.rm_region, "Sem região do RM"),
        ("effective_entry.rm_responsible", filters.rm_responsible, "Sem RM"),
    ):
        if _active(value):
            if value == missing_label:
                predicates.append(f"{field} IS NULL")
            else:
                key = f"t4t5_rm_{len(predicates)}"
                predicates.append(f"{field} = :{key}")
                parameters[key] = value
    text_fields = (
        ("fact.customer_name", filters.customer_name),
        ("fact.assigned_driver", filters.assigned_driver),
    )
    for index, (field, value) in enumerate(text_fields):
        if _active(value):
            key = f"t4t5_text_{index}"
            predicates.append(f"INSTR(LOWER(COALESCE({field}, '')), LOWER(:{key})) > 0")
            parameters[key] = value
    if _active(filters.store_name):
        predicates.append(
            "(INSTR(LOWER(COALESCE(fact.store_name, '')), LOWER(:t4t5_store_search)) > 0 "
            "OR INSTR(LOWER(COALESCE(fact.seller_id, '')), LOWER(:t4t5_store_search)) > 0)"
        )
        parameters["t4t5_store_search"] = filters.store_name
    if _active(filters.seller_id):
        predicates.append("INSTR(LOWER(COALESCE(fact.seller_id, '')), LOWER(:t4t5_seller_search)) > 0")
        parameters["t4t5_seller_search"] = filters.seller_id
    if _active(filters.search):
        search_fields = (
            "fact.reported_origin_region", "fact.source_base_name", "fact.customer_name",
            "fact.store_name", "fact.seller_id", "fact.assigned_driver", "fact.order_origin",
        )
        search_key = "t4t5_search"
        predicates.append("(" + " OR ".join(
            f"INSTR(LOWER(COALESCE({field}, '')), LOWER(:{search_key})) > 0"
            for field in search_fields
        ) + ")")
        parameters[search_key] = filters.search
    where = plan.where_sql
    if predicates:
        where += " AND " + " AND ".join(predicates)
    return plan, where, parameters


def _latest_date(
    engine: Engine,
    identity: dict[str, Any],
    filters: T4T5Filters,
    date_from: date | None,
    date_to: date | None,
) -> date | None:
    plan, where, parameters = _query(engine, identity, filters, date_from=date_from, date_to=date_to)
    _assert_map_available(engine)
    with engine.connect() as connection:
        value = connection.execute(text(f"SELECT MAX(fact.data_date) {plan.from_sql} WHERE {where}"), parameters).scalar_one_or_none()
    return value


def _snapshot_metadata(connection: Connection, snapshot_date: date) -> dict[str, object] | None:
    row = connection.execute(text("""
        SELECT head.publication_id, publication.published_at, publication.snapshot_as_of,
               publication_dates.row_count
        FROM source_daily_head AS head
        JOIN source_publication_dates AS publication_dates
          ON publication_dates.source_id = head.source_id
         AND publication_dates.data_date = head.data_date
         AND publication_dates.publication_id = head.publication_id
        JOIN source_publications AS publication
          ON publication.source_id = head.source_id
         AND publication.publication_id = head.publication_id
         AND publication.publication_state = 'PUBLISHED'
        WHERE head.source_id = :source_id
          AND head.data_date = :snapshot_date
          AND publication.contract_version = :contract_version
        LIMIT 1
    """), {
        "source_id": SOURCE_ID,
        "contract_version": CONTRACT_VERSION,
        "snapshot_date": snapshot_date,
    }).mappings().first()
    if row is None:
        return None
    return {
        "publicationId": str(uuid.UUID(bytes=bytes(row["publication_id"]))),
        "publishedAt": row["published_at"],
        "snapshotAsOf": row["snapshot_as_of"],
        "publishedRowCount": int(row["row_count"]),
    }


def get_dashboard_summary(
    engine: Engine,
    *,
    identity: dict[str, Any],
    filters: T4T5Filters,
    date_from: date | None,
    date_to: date | None,
) -> dict[str, object]:
    snapshot_date = _latest_date(engine, identity, filters, date_from, date_to)
    if snapshot_date is None:
        return {
            "sourceId": SOURCE_ID, "contractVersion": CONTRACT_VERSION,
            "hasData": False, "snapshotDate": None, "metadata": None,
            "totals": None,
        }
    plan, where, parameters = _query(
        engine, identity, filters, date_from=snapshot_date, date_to=snapshot_date,
    )
    status_sql = ", ".join(
        f"COALESCE(SUM(fact.`{field}`), 0) AS `{field}`" for field in STATUS_COLUMNS
    )
    with engine.connect() as connection:
        row = connection.execute(text(f"""
            SELECT COUNT(*) AS record_count,
                   COUNT(DISTINCT effective_entry.regional_name) AS region_count,
                   COUNT(DISTINCT fact.source_base_name) AS pdd_count,
                   COUNT(DISTINCT fact.seller_id) AS store_count,
                   SUM(CASE WHEN effective_entry.base_code IS NULL THEN 1 ELSE 0 END) AS unmapped_record_count,
                   {status_sql}
            {plan.from_sql}
            WHERE {where}
        """), parameters).mappings().one()
        metadata = _snapshot_metadata(connection, snapshot_date)
    if metadata is None:
        raise DataFoundationError("published_snapshot_metadata_inconsistent", 503)
    totals = {
        "records": int(row["record_count"]),
        "regions": int(row["region_count"]),
        "pdds": int(row["pdd_count"]),
        "stores": int(row["store_count"]),
        "unmappedRecords": int(row["unmapped_record_count"] or 0),
        "statuses": {field: int(row[field] or 0) for field in STATUS_COLUMNS},
    }
    return {
        "sourceId": SOURCE_ID,
        "contractVersion": CONTRACT_VERSION,
        "hasData": totals["records"] > 0,
        "snapshotDate": snapshot_date,
        "metadata": metadata,
        "totals": totals,
        "statusSumsAreIndependent": True,
    }


def get_group_page(
    engine: Engine,
    *,
    identity: dict[str, Any],
    dimension: str,
    filters: T4T5Filters,
    snapshot_date: date,
    limit: int,
    offset: int,
) -> dict[str, object]:
    if dimension not in GROUP_COLUMNS:
        raise DataFoundationError("group_dimension_invalid", 422)
    if limit < 1 or limit > MAX_GROUP_PAGE_SIZE or offset < 0:
        raise DataFoundationError("pagination_invalid", 422)
    plan, where, parameters = _query(
        engine, identity, filters, date_from=snapshot_date, date_to=snapshot_date,
    )
    group_columns = GROUP_COLUMNS[dimension]
    selected = [f"{expression} AS `{field}`" for expression, field in group_columns]
    # Keep tuple-valued grouping keys explicit; no join can multiply the fact rows.
    group_by = ", ".join(expression for expression, _field in group_columns)
    status_sql = ", ".join(
        f"COALESCE(SUM(fact.`{field}`), 0) AS `{field}`" for field in STATUS_COLUMNS
    )
    extra_sql = ""
    if dimension == "customer":
        extra_sql = ", COUNT(DISTINCT fact.seller_id) AS distinct_stores"
    elif dimension == "store":
        extra_sql = ", COUNT(DISTINCT fact.customer_name) AS distinct_customers"
    elif dimension == "driver":
        extra_sql = ", COUNT(DISTINCT fact.seller_id) AS distinct_stores"
    elif dimension == "region":
        extra_sql = (
            ", COUNT(DISTINCT fact.source_base_name) AS distinct_pdds"
            ", COUNT(DISTINCT fact.seller_id) AS distinct_stores"
        )
    with engine.connect() as connection:
        total = int(connection.execute(text(f"""
            SELECT COUNT(*) FROM (
                SELECT 1 {plan.from_sql} WHERE {where} GROUP BY {group_by}
            ) AS grouped_rows
        """), parameters).scalar_one())
        rows = connection.execute(text(f"""
            SELECT {', '.join(selected)}, COUNT(*) AS record_count
                   {extra_sql}, {status_sql}
            {plan.from_sql}
            WHERE {where}
            GROUP BY {group_by}
            ORDER BY record_count DESC, {group_by}
            LIMIT :group_limit OFFSET :group_offset
        """), {**parameters, "group_limit": limit, "group_offset": offset}).mappings()
        output = []
        for row in rows:
            output.append({
                **dict(row),
                "record_count": int(row["record_count"]),
                **{field: int(row[field] or 0) for field in STATUS_COLUMNS},
            })
    return {
        "sourceId": SOURCE_ID, "dimension": dimension, "snapshotDate": snapshot_date,
        "rows": output, "total": total, "limit": limit, "offset": offset,
    }


def get_filter_options(
    engine: Engine,
    *,
    identity: dict[str, Any],
    filters: T4T5Filters,
    date_from: date | None,
    date_to: date | None,
) -> dict[str, object]:
    snapshot_date = _latest_date(engine, identity, filters, date_from, date_to)
    if snapshot_date is None:
        return {"sourceId": SOURCE_ID, "snapshotDate": None, "regions": [], "rms": [], "pdds": [], "origins": []}
    plan, where, parameters = _query(
        engine, identity, filters, date_from=snapshot_date, date_to=snapshot_date,
    )
    with engine.connect() as connection:
        regions = connection.execute(text(f"""
            SELECT DISTINCT COALESCE(effective_entry.regional_name, 'Sem regional') AS value
            {plan.from_sql} WHERE {where}
            ORDER BY value LIMIT 500
        """), parameters).scalars().all()
        rms = connection.execute(text(f"""
            SELECT DISTINCT COALESCE(effective_entry.regional_name, 'Sem regional') AS regional_name,
                            COALESCE(effective_entry.rm_region, 'Sem região do RM') AS rm_region,
                            COALESCE(effective_entry.rm_responsible, 'Sem RM') AS rm_responsible
            {plan.from_sql} WHERE {where}
            ORDER BY regional_name, rm_region, rm_responsible LIMIT 1000
        """), parameters).mappings().all()
        pdds = connection.execute(text(f"""
            SELECT DISTINCT fact.source_base_name AS value
            {plan.from_sql} WHERE {where} AND fact.source_base_name IS NOT NULL
            ORDER BY value LIMIT 3000
        """), parameters).scalars().all()
        origins = connection.execute(text(f"""
            SELECT DISTINCT fact.order_origin AS value
            {plan.from_sql} WHERE {where}
            ORDER BY value LIMIT 1000
        """), parameters).scalars().all()
    return {
        "sourceId": SOURCE_ID,
        "snapshotDate": snapshot_date,
        "regions": [str(value) for value in regions],
        "rms": [{"regional": str(row["regional_name"]), "region": str(row["rm_region"]), "responsible": str(row["rm_responsible"])} for row in rms],
        "pdds": [str(value) for value in pdds],
        "origins": [str(value) for value in origins],
    }


def get_detail_page(
    engine: Engine,
    *,
    identity: dict[str, Any],
    filters: T4T5Filters,
    date_from: date | None,
    date_to: date | None,
    limit: int,
    offset: int,
) -> dict[str, object]:
    if limit < 1 or limit > MAX_PAGE_SIZE or offset < 0:
        raise DataFoundationError("pagination_invalid", 422)
    plan, where, parameters = _query(engine, identity, filters, date_from=date_from, date_to=date_to)
    contract = get_contract(SOURCE_ID, CONTRACT_VERSION)
    selected_columns = ", ".join(f"fact.`{column.key}` AS `{column.key}`" for column in contract.columns)
    order = "fact.data_date DESC, fact.source_row_no ASC"
    with engine.connect() as connection:
        total = int(connection.execute(text(f"SELECT COUNT(*) {plan.from_sql} WHERE {where}"), parameters).scalar_one())
        result = connection.execute(text(f"""
            SELECT {selected_columns}, fact.publication_id AS publication_id,
                   fact.source_row_no AS source_row_no,
                   effective_entry.base_code AS effective_base_code,
                   effective_entry.base_name AS mapped_base_name,
                   effective_entry.regional_name AS mapped_region,
                   effective_entry.rm_region AS mapped_rm_area,
                   effective_entry.rm_responsible AS mapped_rm,
                   fact.mapping_resolution AS mapping_resolution
            {plan.from_sql}
            WHERE {where}
            ORDER BY {order}
            LIMIT :page_limit OFFSET :page_offset
        """), {**parameters, "page_limit": limit, "page_offset": offset})
        output = []
        for row in result.mappings():
            record = dict(row)
            record["publication_id"] = str(uuid.UUID(bytes=bytes(record["publication_id"])))
            for key, value in list(record.items()):
                if isinstance(value, Decimal):
                    record[key] = format(value, "f")
                elif isinstance(value, date):
                    record[key] = value.isoformat()
            output.append(record)
    return {"sourceId": SOURCE_ID, "records": output, "total": total, "limit": limit, "offset": offset}


def _excel_column(index: int) -> str:
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _xml_safe(value: str) -> str:
    for character in value:
        code = ord(character)
        if code < 32 and character not in "\t\n\r" or 0xD800 <= code <= 0xDFFF or code in {0xFFFE, 0xFFFF}:
            raise DataFoundationError("xlsx_contains_unsupported_control_character", 422)
    return escape(value, {"\"": "&quot;"})


def _cell_xml(reference: str, value: object, *, date_cell: bool = False) -> str:
    if value is None:
        return f'<c r="{reference}"/>'
    if date_cell:
        if isinstance(value, datetime):
            serial = (value.date() - date(1899, 12, 30)).days
        elif isinstance(value, date):
            serial = (value - date(1899, 12, 30)).days
        elif isinstance(value, str):
            try:
                serial = (date.fromisoformat(value[:10]) - date(1899, 12, 30)).days
            except ValueError:
                return f'<c r="{reference}" t="inlineStr"><is><t>{_xml_safe(value)}</t></is></c>'
        else:
            return f'<c r="{reference}" t="inlineStr"><is><t>{_xml_safe(str(value))}</t></is></c>'
        return f'<c r="{reference}" s="1"><v>{serial}</v></c>'
    if isinstance(value, bool):
        return f'<c r="{reference}" t="b"><v>{1 if value else 0}</v></c>'
    if isinstance(value, (int, float, Decimal)):
        return f'<c r="{reference}" t="n"><v>{value}</v></c>'
    return f'<c r="{reference}" t="inlineStr"><is><t xml:space="preserve">{_xml_safe(str(value))}</t></is></c>'


def _write_xlsx(path: Path, rows: Any) -> None:
    headers = [column.header for column in get_contract(SOURCE_ID, CONTRACT_VERSION).columns]
    contract_keys = [column.key for column in get_contract(SOURCE_ID, CONTRACT_VERSION).columns]
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.writestr("[Content_Types].xml", '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>''')
        archive.writestr("_rels/.rels", '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>''')
        archive.writestr("xl/workbook.xml", '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dados" sheetId="1" r:id="rId1"/></sheets></workbook>''')
        archive.writestr("xl/_rels/workbook.xml.rels", '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>''')
        archive.writestr("xl/styles.xml", '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>''')
        with archive.open("xl/worksheets/sheet1.xml", "w") as sheet:
            sheet.write(b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
            sheet.write(b'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>')
            sheet.write(b'<row r="1">')
            for index, header in enumerate(headers, 1):
                sheet.write(_cell_xml(f"{_excel_column(index)}1", header).encode("utf-8"))
            sheet.write(b"</row>")
            row_no = 2
            for row in rows:
                sheet.write(f'<row r="{row_no}">'.encode("ascii"))
                for index, key in enumerate(contract_keys, 1):
                    sheet.write(_cell_xml(
                        f"{_excel_column(index)}{row_no}", row[key], date_cell=key == "data_date",
                    ).encode("utf-8"))
                sheet.write(b"</row>")
                row_no += 1
            sheet.write(b"</sheetData></worksheet>")


def create_xlsx_export(
    engine: Engine,
    *,
    identity: dict[str, Any],
    filters: T4T5Filters,
    date_from: date | None,
    date_to: date | None,
) -> Path:
    plan, where, parameters = _query(engine, identity, filters, date_from=date_from, date_to=date_to)
    contract = get_contract(SOURCE_ID, CONTRACT_VERSION)
    selected_columns = ", ".join(f"fact.`{column.key}` AS `{column.key}`" for column in contract.columns)
    with engine.connect() as connection:
        count = int(connection.execute(text(f"SELECT COUNT(*) {plan.from_sql} WHERE {where}"), parameters).scalar_one())
        if count > MAX_XLSX_DATA_ROWS:
            raise DataFoundationError("xlsx_row_limit_exceeded", 413)
        descriptor, filename = tempfile.mkstemp(prefix="new-bi-t4t5-", suffix=".xlsx")
        os.close(descriptor)
        path = Path(filename)
        try:
            result = connection.execution_options(stream_results=True).execute(text(f"""
                SELECT {selected_columns}
                {plan.from_sql}
                WHERE {where}
                ORDER BY fact.data_date DESC, fact.source_row_no ASC
            """), parameters)
            _write_xlsx(path, result.mappings())
        except Exception:
            path.unlink(missing_ok=True)
            raise
    return path
