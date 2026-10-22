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
from app.services.data_foundation.queries import (
    _assert_map_available,
    _daily_metadata_consistency_expression,
    _is_resolved_matrix_scope,
    _query_plan,
)
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


def _matrix_unfiltered(identity: dict[str, Any], filters: T4T5Filters) -> bool:
    """Whether publication metadata can safely replace a scoped fact count."""
    return _is_resolved_matrix_scope(identity) and not any(
        _active(value) for value in filters.__dict__.values()
    )


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
    if _matrix_unfiltered(identity, filters):
        _assert_map_available(engine)
        parameters: dict[str, object] = {
            "source_id": SOURCE_ID,
            "contract_version": CONTRACT_VERSION,
        }
        date_predicates = []
        if date_from is not None:
            parameters["date_from"] = date_from
            date_predicates.append("head.data_date >= :date_from")
        if date_to is not None:
            parameters["date_to"] = date_to
            date_predicates.append("head.data_date <= :date_to")
        date_sql = " AND " + " AND ".join(date_predicates) if date_predicates else ""
        consistency = _daily_metadata_consistency_expression(engine.dialect.name)
        with engine.connect() as connection:
            row = connection.execute(text(f"""
                SELECT MAX(head.data_date) AS snapshot_date,
                       CASE WHEN {consistency} THEN 1 ELSE 0 END AS metadata_consistent
                FROM source_daily_head AS head
                JOIN source_publications AS publication
                  ON publication.source_id = head.source_id
                 AND publication.publication_id = head.publication_id
                 AND publication.contract_version = :contract_version
                 AND publication.publication_state = 'PUBLISHED'
                JOIN source_publication_dates AS publication_dates
                  ON publication_dates.source_id = head.source_id
                 AND publication_dates.publication_id = head.publication_id
                 AND publication_dates.data_date = head.data_date
                WHERE head.source_id = :source_id
                  AND publication_dates.row_count > 0
                  {date_sql}
            """), parameters).mappings().one()
        if row["metadata_consistent"]:
            return row["snapshot_date"]

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


def _matrix_metadata_count(
    connection: Connection,
    *,
    date_from: date | None,
    date_to: date | None,
) -> int | None:
    """Return an unfiltered MATRIX count from validated active-head metadata."""
    parameters: dict[str, object] = {
        "source_id": SOURCE_ID,
        "contract_version": CONTRACT_VERSION,
    }
    date_predicates = []
    if date_from is not None:
        parameters["date_from"] = date_from
        date_predicates.append("head.data_date >= :date_from")
    if date_to is not None:
        parameters["date_to"] = date_to
        date_predicates.append("head.data_date <= :date_to")
    date_sql = " AND " + " AND ".join(date_predicates) if date_predicates else ""
    consistency = _daily_metadata_consistency_expression(connection.dialect.name)
    row = connection.execute(text(f"""
        SELECT COALESCE(SUM(publication_dates.row_count), 0) AS total,
               CASE WHEN {consistency} THEN 1 ELSE 0 END AS metadata_consistent
        FROM source_daily_head AS head
        JOIN source_publications AS publication
          ON publication.source_id = head.source_id
         AND publication.publication_id = head.publication_id
         AND publication.contract_version = :contract_version
         AND publication.publication_state = 'PUBLISHED'
        JOIN source_publication_dates AS publication_dates
          ON publication_dates.source_id = head.source_id
         AND publication_dates.publication_id = head.publication_id
         AND publication_dates.data_date = head.data_date
        WHERE head.source_id = :source_id
          {date_sql}
    """), parameters).mappings().one()
    if not row["metadata_consistent"]:
        return None
    return int(row["total"])


def _matrix_mapping_filters_absent(identity: dict[str, Any], filters: T4T5Filters) -> bool:
    """Mapping joins may follow pagination only for MATRIX and unmapped filters."""
    return _is_resolved_matrix_scope(identity) and not any(
        _active(value) for value in (
            filters.region,
            filters.rm_regional,
            filters.base_code,
            filters.rm_region,
            filters.rm_responsible,
        )
    )


def _matrix_summary_distinct_mapping_eligible(
    identity: dict[str, Any], filters: T4T5Filters,
) -> bool:
    """Allow row-independent national summaries to resolve DoomsDay per PDD key.

    Any filter or authorization predicate that depends on the effective map keeps
    using the existing row-level query. This fast path is limited to the backend
    resolved MATRIX scope; ADMIN role alone never enables it.
    """
    return _matrix_mapping_filters_absent(identity, filters)


def _mapping_key_sql(expression: str, dialect: str) -> str:
    """Build an exact byte key, independent of database text collation."""
    cast_type = "BLOB" if dialect == "sqlite" else "BINARY"
    return f"HEX(CAST({expression} AS {cast_type}))"


def _summary_result(connection: Connection, row: Any) -> dict[str, object]:
    snapshot_date = row["snapshot_date"]
    if snapshot_date is None:
        return {
            "sourceId": SOURCE_ID, "contractVersion": CONTRACT_VERSION,
            "hasData": False, "snapshotDate": None, "metadata": None,
            "totals": None,
        }
    metadata = _snapshot_metadata(connection, snapshot_date)
    if metadata is None:
        raise DataFoundationError("published_snapshot_metadata_inconsistent", 503)
    statuses = {field: int(row[field] or 0) for field in STATUS_COLUMNS}
    awaiting = statuses["awaiting_collection"]
    processing = sum(
        value for field, value in statuses.items() if field != "awaiting_collection"
    )
    total_volume = processing + awaiting
    totals = {
        "records": int(row["record_count"]),
        "regions": int(row["region_count"]),
        "pdds": int(row["pdd_count"]),
        "stores": int(row["store_count"]),
        "unmappedRecords": int(row["unmapped_record_count"] or 0),
        "statuses": statuses,
        "processingVolume": processing,
        "awaitingCollectionVolume": awaiting,
        "totalVolume": total_volume,
        "processingRatePercent": processing * 100 / total_volume if total_volume else 0.0,
        "awaitingRatePercent": awaiting * 100 / total_volume if total_volume else 0.0,
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


def _get_dashboard_summary_with_row_mapping(
    engine: Engine,
    *,
    identity: dict[str, Any],
    filters: T4T5Filters,
    date_from: date | None,
    date_to: date | None,
) -> dict[str, object]:
    """Reference/fallback summary retaining the original per-row map joins."""
    plan, where, parameters = _query(
        engine, identity, filters, date_from=date_from, date_to=date_to,
    )
    _assert_map_available(engine)
    scoped_fields = [
        "fact.data_date AS data_date",
        "effective_entry.regional_name AS mapped_region",
        "effective_entry.base_code AS mapped_base_code",
        "fact.source_base_name AS source_base_name",
        "fact.seller_id AS seller_id",
        *(f"fact.`{field}` AS `{field}`" for field in STATUS_COLUMNS),
    ]
    status_sql = ", ".join(
        f"COALESCE(SUM(scoped.`{field}`), 0) AS `{field}`" for field in STATUS_COLUMNS
    )
    with engine.connect() as connection:
        row = connection.execute(text(f"""
            WITH scoped_rows AS (
                SELECT {', '.join(scoped_fields)}
                {plan.from_sql}
                WHERE {where}
            ), latest_snapshot AS (
                SELECT MAX(data_date) AS snapshot_date
                FROM scoped_rows
            )
            SELECT latest_snapshot.snapshot_date,
                   COUNT(scoped.data_date) AS record_count,
                   COUNT(DISTINCT scoped.mapped_region) AS region_count,
                   COUNT(DISTINCT scoped.source_base_name) AS pdd_count,
                   COUNT(DISTINCT scoped.seller_id) AS store_count,
                   SUM(CASE WHEN scoped.data_date IS NOT NULL AND scoped.mapped_base_code IS NULL THEN 1 ELSE 0 END) AS unmapped_record_count,
                   {status_sql}
            FROM latest_snapshot
            LEFT JOIN scoped_rows AS scoped
              ON scoped.data_date = latest_snapshot.snapshot_date
            GROUP BY latest_snapshot.snapshot_date
        """), parameters).mappings().one()
        return _summary_result(connection, row)


def _get_matrix_dashboard_summary_by_distinct_mapping_keys(
    engine: Engine,
    *,
    identity: dict[str, Any],
    filters: T4T5Filters,
    date_from: date | None,
    date_to: date | None,
) -> dict[str, object]:
    """Aggregate the national snapshot while resolving DoomsDay once per key.

    Facts determine the latest matching date and every operational total. The
    current DoomsDay resolver runs only against exact distinct source keys from
    that snapshot; weighted unmapped counts preserve the original per-row sum.
    """
    plan, where, parameters = _query(
        engine, identity, filters, date_from=date_from, date_to=date_to,
    )
    _assert_map_available(engine)
    status_fields = ", ".join(
        f"fact.`{field}` AS `{field}`" for field in STATUS_COLUMNS
    )
    summary_status_fields = ", ".join(
        f"COALESCE(SUM(snapshot_facts.`{field}`), 0) AS `{field}`"
        for field in STATUS_COLUMNS
    )
    name_key = _mapping_key_sql("snapshot_facts.source_base_name", engine.dialect.name)
    resolved_key = _mapping_key_sql("snapshot_facts.resolved_base_code", engine.dialect.name)
    resolution_key = _mapping_key_sql("snapshot_facts.mapping_resolution", engine.dialect.name)
    with engine.connect() as connection:
        row = connection.execute(text(f"""
            WITH candidate_facts AS (
                SELECT fact.data_date, fact.source_base_name, fact.seller_id,
                       fact.resolved_base_code, fact.mapping_resolution,
                       {status_fields}
                {plan.fact_from_sql}
                WHERE {where}
            ), latest_snapshot AS (
                SELECT MAX(data_date) AS snapshot_date
                FROM candidate_facts
            ), snapshot_facts AS (
                SELECT candidate_facts.*
                FROM candidate_facts
                JOIN latest_snapshot
                  ON candidate_facts.data_date = latest_snapshot.snapshot_date
            ), keyed_snapshot_facts AS (
                SELECT snapshot_facts.*,
                       {name_key} AS source_base_name_key,
                       {resolved_key} AS resolved_base_code_key,
                       {resolution_key} AS mapping_resolution_key
                FROM snapshot_facts
            ), mapping_keys AS (
                SELECT source_base_name_key,
                       MIN(source_base_name) AS source_base_name,
                       resolved_base_code_key,
                       MIN(resolved_base_code) AS resolved_base_code,
                       mapping_resolution_key,
                       MIN(mapping_resolution) AS mapping_resolution,
                       COUNT(*) AS fact_count
                FROM keyed_snapshot_facts
                GROUP BY source_base_name_key, resolved_base_code_key, mapping_resolution_key
            ), resolved_mapping AS (
                SELECT fact.source_base_name_key, fact.resolved_base_code_key,
                       fact.mapping_resolution_key, fact.fact_count,
                       effective_entry.base_code AS mapped_base_code,
                       effective_entry.regional_name AS mapped_region
                FROM mapping_keys AS fact
                {plan.mapping_from_sql}
            ), fact_totals AS (
                SELECT COUNT(snapshot_facts.data_date) AS record_count,
                       COUNT(DISTINCT snapshot_facts.source_base_name) AS pdd_count,
                       COUNT(DISTINCT snapshot_facts.seller_id) AS store_count,
                       {summary_status_fields}
                FROM snapshot_facts
            ), mapping_totals AS (
                SELECT COUNT(DISTINCT resolved_mapping.mapped_region) AS region_count,
                       COALESCE(SUM(CASE WHEN resolved_mapping.mapped_base_code IS NULL
                                         THEN resolved_mapping.fact_count ELSE 0 END), 0)
                           AS unmapped_record_count
                FROM resolved_mapping
            )
            SELECT latest_snapshot.snapshot_date,
                   fact_totals.record_count,
                   mapping_totals.region_count,
                   fact_totals.pdd_count,
                   fact_totals.store_count,
                   mapping_totals.unmapped_record_count,
                   {', '.join(f'fact_totals.`{field}`' for field in STATUS_COLUMNS)}
            FROM latest_snapshot
            CROSS JOIN fact_totals
            CROSS JOIN mapping_totals
        """), parameters).mappings().one()
        return _summary_result(connection, row)


def get_dashboard_summary(
    engine: Engine,
    *,
    identity: dict[str, Any],
    filters: T4T5Filters,
    date_from: date | None,
    date_to: date | None,
) -> dict[str, object]:
    if _matrix_summary_distinct_mapping_eligible(identity, filters):
        return _get_matrix_dashboard_summary_by_distinct_mapping_keys(
            engine, identity=identity, filters=filters,
            date_from=date_from, date_to=date_to,
        )
    return _get_dashboard_summary_with_row_mapping(
        engine, identity=identity, filters=filters,
        date_from=date_from, date_to=date_to,
    )


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
        rows = list(connection.execute(text(f"""
            SELECT {', '.join(selected)}, COUNT(*) AS record_count
                   {extra_sql}, {status_sql}, COUNT(*) OVER() AS total_groups
            {plan.from_sql}
            WHERE {where}
            GROUP BY {group_by}
            ORDER BY record_count DESC, {group_by}
            LIMIT :group_limit OFFSET :group_offset
        """), {**parameters, "group_limit": limit, "group_offset": offset}).mappings())
        total = int(rows[0]["total_groups"]) if rows else 0
        if not rows and offset > 0:
            # Keep the historical total when a caller requests a page past the
            # end. Normal pages need only the grouped query above.
            total = int(connection.execute(text(f"""
                SELECT COUNT(*) FROM (
                    SELECT 1 {plan.from_sql} WHERE {where} GROUP BY {group_by}
                ) AS grouped_rows
            """), parameters).scalar_one())
        output = []
        for row in rows:
            item = dict(row)
            item.pop("total_groups", None)
            output.append({
                **item,
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
    _assert_map_available(engine)
    plan, where, parameters = _query(
        engine, identity, filters, date_from=date_from, date_to=date_to,
    )
    with engine.connect() as connection:
        rows = connection.execute(text(f"""
            WITH scoped_rows AS (
                SELECT fact.data_date AS data_date,
                       COALESCE(effective_entry.regional_name, 'Sem regional') AS regional_name,
                       COALESCE(effective_entry.rm_region, 'Sem região do RM') AS rm_region,
                       COALESCE(effective_entry.rm_responsible, 'Sem RM') AS rm_responsible,
                       fact.source_base_name AS source_base_name,
                       fact.order_origin AS order_origin
                {plan.from_sql}
                WHERE {where}
            ), latest_snapshot AS (
                SELECT MAX(data_date) AS snapshot_date
                FROM scoped_rows
            ), option_rows AS (
                SELECT DISTINCT
                       scoped.regional_name,
                       scoped.rm_region,
                       scoped.rm_responsible,
                       scoped.source_base_name,
                       scoped.order_origin
                FROM scoped_rows AS scoped
                JOIN latest_snapshot
                  ON scoped.data_date = latest_snapshot.snapshot_date
            ), region_options AS (
                SELECT DISTINCT regional_name AS value
                FROM option_rows ORDER BY value LIMIT 500
            ), rm_options AS (
                SELECT DISTINCT regional_name, rm_region, rm_responsible
                FROM option_rows
                ORDER BY regional_name, rm_region, rm_responsible LIMIT 1000
            ), pdd_options AS (
                SELECT DISTINCT source_base_name AS value
                FROM option_rows
                WHERE source_base_name IS NOT NULL
                ORDER BY value LIMIT 3000
            ), origin_options AS (
                SELECT DISTINCT order_origin AS value
                FROM option_rows ORDER BY value LIMIT 1000
            )
            SELECT 'snapshot' AS kind,
                   CAST(snapshot_date AS CHAR) AS first_value,
                   NULL AS second_value,
                   NULL AS third_value
            FROM latest_snapshot
            UNION ALL
            SELECT 'region' AS kind, value AS first_value, NULL AS second_value, NULL AS third_value
            FROM region_options
            UNION ALL
            SELECT 'rm', regional_name, rm_region, rm_responsible FROM rm_options
            UNION ALL
            SELECT 'pdd', value, NULL, NULL FROM pdd_options
            UNION ALL
            SELECT 'origin', value, NULL, NULL FROM origin_options
            ORDER BY kind, first_value, second_value, third_value
        """), parameters).mappings().all()
    snapshot_date = next(
        (date.fromisoformat(str(row["first_value"])) for row in rows
         if row["kind"] == "snapshot" and row["first_value"] is not None),
        None,
    )
    regions: list[str] = []
    rms: list[dict[str, str]] = []
    pdds: list[str] = []
    origins: list[str] = []
    for row in rows:
        if row["kind"] == "region":
            regions.append(str(row["first_value"]))
        elif row["kind"] == "rm":
            rms.append({
                "regional": str(row["first_value"]),
                "region": str(row["second_value"]),
                "responsible": str(row["third_value"]),
            })
        elif row["kind"] == "pdd":
            pdds.append(str(row["first_value"]))
        else:
            origins.append(str(row["first_value"]))
    return {
        "sourceId": SOURCE_ID,
        "snapshotDate": snapshot_date,
        "regions": regions,
        "rms": rms,
        "pdds": pdds,
        "origins": origins,
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
    matrix_metadata_eligible = _matrix_unfiltered(identity, filters)
    page_before_mapping = _matrix_mapping_filters_absent(identity, filters)
    with engine.connect() as connection:
        total = _matrix_metadata_count(
            connection, date_from=date_from, date_to=date_to,
        ) if matrix_metadata_eligible else None
        if total is None:
            total = int(connection.execute(
                text(f"SELECT COUNT(*) {plan.from_sql} WHERE {where}"), parameters,
            ).scalar_one())
        select_sql = f"""
            SELECT {selected_columns}, fact.publication_id AS publication_id,
                   fact.source_row_no AS source_row_no,
                   effective_entry.base_code AS effective_base_code,
                   effective_entry.base_name AS mapped_base_name,
                   effective_entry.regional_name AS mapped_region,
                   effective_entry.rm_region AS mapped_rm_area,
                   effective_entry.rm_responsible AS mapped_rm,
                   fact.mapping_resolution AS mapping_resolution
            FROM page_facts AS fact
            {plan.mapping_from_sql}
            ORDER BY {order}
        """ if page_before_mapping else f"""
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
        """
        if page_before_mapping:
            result = connection.execute(text(f"""
                WITH page_facts AS (
                    SELECT fact.*
                    {plan.fact_from_sql}
                    WHERE {where}
                    ORDER BY {order}
                    LIMIT :page_limit OFFSET :page_offset
                )
                {select_sql}
            """), {**parameters, "page_limit": limit, "page_offset": offset})
        else:
            result = connection.execute(text(select_sql), {
                **parameters, "page_limit": limit, "page_offset": offset,
            })
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
