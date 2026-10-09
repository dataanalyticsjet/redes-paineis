from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any
import uuid

from sqlalchemy import Engine, text

from app.services.data_foundation.contracts import CONTRACTS
from app.services.data_foundation.repository import DAILY_SOURCES, FACT_TABLES, DataFoundationError


@dataclass(frozen=True)
class ScopedQuery:
    source_id: str
    where_sql: str
    parameters: dict[str, object]
    from_sql: str
    select_sql: str


def _scope_clause(identity: dict[str, Any], params: dict[str, object]) -> str:
    scope = str(identity.get("organizational_scope") or "").strip().lower()
    role = str(identity.get("role") or "").strip().lower()
    if scope == "matrix" and role == "matrix":
        return ""
    if scope == "regional":
        regions = {
            str(region).strip().upper()
            for region in [identity.get("home_region"), *(identity.get("additional_regions") or [])]
            if str(region or "").strip()
        }
        if not regions:
            raise DataFoundationError("user_scope_unavailable", 403)
        placeholders = []
        for index, region in enumerate(sorted(regions)):
            key = f"scope_region_{index}"
            params[key] = region
            placeholders.append(f":{key}")
        return f"BINARY current_entry.regional_name IN ({', '.join(placeholders)})"
    if scope == "base":
        base_code = str(identity.get("home_base") or identity.get("base") or "").strip()
        if not base_code:
            raise DataFoundationError("user_scope_unavailable", 403)
        params["scope_base_code"] = base_code
        extra_regions = sorted({
            str(value).strip().upper()
            for value in (identity.get("additional_regions") or [])
            if str(value or "").strip()
        })
        extra_region_clause = ""
        if extra_regions:
            placeholders = []
            for index, extra in enumerate(extra_regions):
                key = f"scope_extra_region_{index}"
                params[key] = extra
                placeholders.append(f":{key}")
            extra_region_clause = f" OR BINARY current_entry.regional_name IN ({', '.join(placeholders)})"
        home_region = str(identity.get("home_region") or identity.get("region") or "").strip().upper()
        if home_region:
            params["scope_base_name"] = base_code
            params["scope_home_region"] = home_region
            return (
                "(current_entry.base_code = :scope_base_code"
                " OR (BINARY current_entry.base_name = BINARY :scope_base_name"
                " AND BINARY current_entry.regional_name = BINARY :scope_home_region"
                " AND (SELECT COUNT(*) FROM base_mapping_entries AS exact_base"
                " WHERE exact_base.map_version_id = current_entry.map_version_id"
                " AND BINARY exact_base.base_name = BINARY current_entry.base_name"
                f" AND BINARY exact_base.regional_name = BINARY current_entry.regional_name) = 1){extra_region_clause})"
            )
        return f"(current_entry.base_code = :scope_base_code{extra_region_clause})"
    raise DataFoundationError("user_scope_unavailable", 403)


def _query_plan(
    source_id: str,
    identity: dict[str, Any],
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    base_code: str | None = None,
    region: str | None = None,
    publication_id: str | None = None,
) -> ScopedQuery:
    contract = CONTRACTS.get(source_id)
    table = FACT_TABLES.get(source_id)
    if contract is None or table is None:
        raise DataFoundationError("data_source_not_found", 404)
    if source_id == "no_movement" and (date_from or date_to):
        raise DataFoundationError("date_filter_not_supported", 422)

    params: dict[str, object] = {"source_id": source_id}
    if publication_id is not None:
        try:
            params["selected_publication_id"] = uuid.UUID(publication_id).bytes
        except ValueError:
            raise DataFoundationError("publication_id_invalid", 422) from None
        head_join = """
            JOIN source_publications AS selected_publication
              ON selected_publication.source_id = fact.source_id
             AND selected_publication.publication_id = fact.publication_id
             AND selected_publication.publication_state = 'PUBLISHED'
        """
    elif source_id in DAILY_SOURCES:
        head_join = """
            JOIN source_daily_head AS head
              ON head.source_id = fact.source_id
             AND head.data_date = fact.data_date
             AND head.publication_id = fact.publication_id
        """
    else:
        head_join = """
            JOIN source_snapshot_head AS head
              ON head.source_id = fact.source_id
             AND head.publication_id = fact.publication_id
        """
    from_sql = f"""
        FROM `{table}` AS fact
        {head_join}
        JOIN base_mapping_current AS current_map
          ON current_map.current_key = 'OFFICIAL'
        JOIN base_mapping_entries AS current_entry
          ON current_entry.map_version_id = current_map.map_version_id
         AND current_entry.base_code = fact.resolved_base_code
    """
    where_parts = [
        "fact.source_id = :source_id",
        "fact.resolved_base_code IS NOT NULL",
        "fact.mapping_resolution IN ('CODE_MATCH', 'NAME_APPROVED')",
    ]
    if publication_id is not None:
        where_parts.append("fact.publication_id = :selected_publication_id")
    where_parts.append(_scope_clause(identity, params))
    if date_from:
        where_parts.append("fact.data_date >= :date_from")
        params["date_from"] = date_from
    if date_to:
        where_parts.append("fact.data_date <= :date_to")
        params["date_to"] = date_to
    if base_code:
        where_parts.append("current_entry.base_code = :filter_base_code")
        params["filter_base_code"] = base_code
    if region:
        where_parts.append("BINARY current_entry.regional_name = BINARY :filter_region")
        params["filter_region"] = region

    fields = [f"fact.`{column.key}` AS `{column.key}`" for column in contract.columns]
    fields.extend([
        "fact.publication_id AS publication_id",
        "fact.source_row_no AS source_row_no",
        "fact.resolved_base_code AS resolved_base_code",
        "fact.mapping_resolution AS mapping_resolution",
        "current_entry.regional_name AS mapped_region",
    ])
    return ScopedQuery(
        source_id=source_id,
        where_sql=" AND ".join(part for part in where_parts if part),
        parameters=params,
        from_sql=from_sql,
        select_sql=", ".join(fields),
    )


def _assert_map_available(engine: Engine) -> None:
    with engine.connect() as connection:
        current = connection.execute(text("""
            SELECT 1
            FROM base_mapping_current AS current_map
            JOIN base_mapping_versions AS version
              ON version.map_version_id = current_map.map_version_id
            WHERE current_map.current_key = 'OFFICIAL'
              AND version.version_state = 'PUBLISHED'
            LIMIT 1
        """)).first()
    if current is None:
        raise DataFoundationError("official_mapping_unavailable", 503)


def get_current_mapping_status(engine: Engine, *, identity: dict[str, Any]) -> dict[str, object]:
    """Return current map metadata and only the base count visible to this identity."""
    parameters: dict[str, object] = {}
    scope = _scope_clause(identity, parameters)
    with engine.connect() as connection:
        current = connection.execute(text("""
            SELECT version.map_version_id, version.version_no, version.version_state,
                   version.published_at
            FROM base_mapping_current AS pointer
            JOIN base_mapping_versions AS version
              ON version.map_version_id = pointer.map_version_id
            WHERE pointer.current_key = 'OFFICIAL'
              AND version.version_state = 'PUBLISHED'
        """)).mappings().first()
        if current is None:
            return {
                "state": "UNAVAILABLE",
                "mappingVersionId": None,
                "version": None,
                "publishedAt": None,
                "visibleBaseCount": 0,
            }
        count_filter = "current_entry.map_version_id = :map_version_id"
        if scope:
            count_filter += f" AND {scope}"
        count = int(connection.execute(text(f"""
            SELECT COUNT(*)
            FROM base_mapping_entries AS current_entry
            WHERE {count_filter}
        """), {
            **parameters,
            "map_version_id": current["map_version_id"],
        }).scalar_one())
    return {
        "state": str(current["version_state"]),
        "mappingVersionId": str(uuid.UUID(bytes=bytes(current["map_version_id"]))),
        "version": int(current["version_no"]),
        "publishedAt": current["published_at"],
        "visibleBaseCount": count,
    }


def get_records(
    engine: Engine,
    *,
    source_id: str,
    identity: dict[str, Any],
    limit: int,
    offset: int,
    date_from: date | None = None,
    date_to: date | None = None,
    base_code: str | None = None,
    region: str | None = None,
    publication_id: str | None = None,
) -> dict[str, object]:
    if date_from and date_to and date_from > date_to:
        raise DataFoundationError("date_range_invalid", 422)
    plan = _query_plan(
        source_id,
        identity,
        date_from=date_from,
        date_to=date_to,
        base_code=base_code,
        region=region,
        publication_id=publication_id,
    )
    _assert_map_available(engine)
    where = f"WHERE {plan.where_sql}"
    order = "fact.data_date DESC, fact.source_row_no ASC" if source_id in DAILY_SOURCES else "fact.source_row_no ASC"
    with engine.connect() as connection:
        total = int(connection.execute(text(f"SELECT COUNT(*) {plan.from_sql} {where}"), plan.parameters).scalar_one())
        result = connection.execute(text(f"""
            SELECT {plan.select_sql}
            {plan.from_sql}
            {where}
            ORDER BY {order}
            LIMIT :page_limit OFFSET :page_offset
        """), {**plan.parameters, "page_limit": limit, "page_offset": offset})
        records = []
        for row in result.mappings():
            record = dict(row)
            record["publication_id"] = str(uuid.UUID(bytes=bytes(record["publication_id"])))
            for key, value in list(record.items()):
                if isinstance(value, Decimal):
                    record[key] = format(value, "f")
            records.append(record)
    return {"sourceId": source_id, "records": records, "total": total, "limit": limit, "offset": offset}


def get_date_counts(
    engine: Engine,
    *,
    source_id: str,
    identity: dict[str, Any],
    date_from: date | None = None,
    date_to: date | None = None,
    base_code: str | None = None,
    region: str | None = None,
    publication_id: str | None = None,
) -> dict[str, object]:
    if date_from and date_to and date_from > date_to:
        raise DataFoundationError("date_range_invalid", 422)
    plan = _query_plan(
        source_id,
        identity,
        date_from=date_from,
        date_to=date_to,
        base_code=base_code,
        region=region,
        publication_id=publication_id,
    )
    _assert_map_available(engine)
    if source_id == "no_movement":
        with engine.connect() as connection:
            count = int(connection.execute(text(f"SELECT COUNT(*) {plan.from_sql} WHERE {plan.where_sql}"), plan.parameters).scalar_one())
        return {"sourceId": source_id, "dates": [], "snapshotRowCount": count}
    with engine.connect() as connection:
        rows = connection.execute(text(f"""
            SELECT fact.data_date AS date, COUNT(*) AS row_count
            {plan.from_sql}
            WHERE {plan.where_sql}
            GROUP BY fact.data_date
            ORDER BY fact.data_date DESC
        """), plan.parameters).mappings()
        dates = [{"date": row["date"], "rowCount": int(row["row_count"])} for row in rows]
    return {"sourceId": source_id, "dates": dates}


def export_records(
    engine: Engine,
    *,
    source_id: str,
    identity: dict[str, Any],
    limit: int,
    offset: int,
    date_from: date | None = None,
    date_to: date | None = None,
    base_code: str | None = None,
    region: str | None = None,
    publication_id: str | None = None,
) -> tuple[list[str], list[dict[str, object]]]:
    result = get_records(
        engine,
        source_id=source_id,
        identity=identity,
        limit=limit,
        offset=offset,
        date_from=date_from,
        date_to=date_to,
        base_code=base_code,
        region=region,
        publication_id=publication_id,
    )
    headers = [
        *(column.key for column in CONTRACTS[source_id].columns),
        "publication_id", "source_row_no", "resolved_base_code", "mapping_resolution", "mapped_region",
    ]
    return headers, result["records"]


def get_publications(
    engine: Engine,
    *,
    source_id: str,
    identity: dict[str, Any],
    limit: int,
    offset: int,
) -> dict[str, object]:
    if source_id not in FACT_TABLES:
        raise DataFoundationError("data_source_not_found", 404)
    table = FACT_TABLES[source_id]
    parameters: dict[str, object] = {"source_id": source_id}
    scope = _scope_clause(identity, parameters)
    from_sql = f"""
        FROM source_publications AS publication
        JOIN `{table}` AS fact
          ON fact.source_id = publication.source_id
         AND fact.publication_id = publication.publication_id
        JOIN base_mapping_current AS current_map
          ON current_map.current_key = 'OFFICIAL'
        JOIN base_mapping_entries AS current_entry
          ON current_entry.map_version_id = current_map.map_version_id
         AND current_entry.base_code = fact.resolved_base_code
    """
    filters = "publication.source_id = :source_id AND publication.publication_state = 'PUBLISHED'"
    filters += " AND fact.resolved_base_code IS NOT NULL AND fact.mapping_resolution IN ('CODE_MATCH', 'NAME_APPROVED')"
    if scope:
        filters += f" AND {scope}"
    if source_id in DAILY_SOURCES:
        date_select = "MIN(fact.data_date) AS period_start, MAX(fact.data_date) AS period_end"
    else:
        date_select = "NULL AS period_start, NULL AS period_end"
    with engine.connect() as connection:
        total = int(connection.execute(text(f"""
            SELECT COUNT(*) FROM (
                SELECT publication.publication_id
                {from_sql}
                WHERE {filters}
                GROUP BY publication.publication_id
            ) AS visible_publications
        """), parameters).scalar_one())
        result = connection.execute(text(f"""
            SELECT publication.publication_id, publication.version_no, publication.published_at,
                   COUNT(*) AS visible_row_count, {date_select}
            {from_sql}
            WHERE {filters}
            GROUP BY publication.publication_id, publication.version_no, publication.published_at
            ORDER BY publication.version_no DESC
            LIMIT :page_limit OFFSET :page_offset
        """), {**parameters, "page_limit": limit, "page_offset": offset}).mappings()
        publications = [
            {
                "publicationId": str(uuid.UUID(bytes=bytes(row["publication_id"]))),
                "version": int(row["version_no"]),
                "publishedAt": row["published_at"],
                "visibleRowCount": int(row["visible_row_count"]),
                "periodStart": row["period_start"],
                "periodEnd": row["period_end"],
            }
            for row in result
        ]
    return {"sourceId": source_id, "publications": publications, "total": total, "limit": limit, "offset": offset}
