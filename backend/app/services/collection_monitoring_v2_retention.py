from __future__ import annotations

from datetime import date
from typing import Any
import uuid

from sqlalchemy import Engine, text

from app.services.data_foundation.mapping_resolution import build_mapping_query
from app.services.data_foundation.queries import _assert_map_available, _query_plan, _scope_clause
from app.services.data_foundation.repository import DataFoundationError


RETENTION_FIELDS = (
    "expected_dropoff", "expected_pickup", "pending_dropoff", "pending_pickup",
    "status_collected", "status_received_at_base", "status_dispatched_from_base",
    "status_in_transit_from_base", "in_transit_to_center", "in_transit_to_distribution",
)


def _get_authorized_retention_aggregates(
    engine: Engine, *, identity: dict[str, Any],
    date_from: date, date_to: date,
) -> dict[str, object]:
    """V2 only: sum active partitions and resolve the official map per exact key.

    Authorization runs on the same effective mapping as /records, before any
    result leaves the backend. The table service filters these complete
    authorized aggregates before the HTTP response.
    """
    if date_from > date_to:
        raise DataFoundationError("date_range_invalid", 422)
    plan = _query_plan(
        "collection_monitoring", identity, contract_version=2,
        date_from=date_from, date_to=date_to, sql_dialect=engine.dialect.name,
    )
    mapping = build_mapping_query(source_id="collection_monitoring", has_source_base_code=False, has_source_base_name=True, dialect=engine.dialect.name)
    _assert_map_available(engine)
    parameters = dict(plan.parameters)
    scope = _scope_clause(identity, parameters, dialect=engine.dialect.name) or "1 = 1"
    cast = "BLOB" if engine.dialect.name == "sqlite" else "BINARY"
    keys = ("source_base_name", "resolved_base_code", "mapping_resolution")
    def key(field: str) -> str:
        # Hex preserves case, trailing spaces and NULL versus empty on both DBs.
        return f"CASE WHEN fact.{field} IS NULL THEN 'NULL' ELSE HEX(CAST(fact.{field} AS {cast})) END"
    select_keys = ", ".join(f"{key(field)} AS {field}_key" for field in keys)
    key_names = ", ".join(f"{field}_key" for field in keys)
    min_values = ", ".join(f"MIN({field}) AS {field}" for field in keys)
    final_keys = " AND ".join(f"mapped.{field}_key = daily.{field}_key" for field in keys)
    sums = ", ".join(f"SUM(`{field}`) AS `{field}`" for field in RETENTION_FIELDS)
    with engine.connect() as connection:
        result = connection.execute(text(f"""
            WITH candidate_facts AS (
                SELECT fact.data_date, fact.publication_id, fact.source_base_name, fact.order_origin,
                       fact.resolved_base_code, fact.mapping_resolution,
                       {', '.join(f'fact.`{field}`' for field in RETENTION_FIELDS)}
                {plan.fact_from_sql}
                WHERE fact.source_id = :source_id
                  AND fact.data_date >= :date_from AND fact.data_date <= :date_to
            ), keyed_facts AS (
                SELECT fact.*, {select_keys},
                       {key('order_origin')} AS order_origin_key
                FROM candidate_facts AS fact
            ), mapping_keys AS (
                SELECT {key_names}, {min_values}
                FROM keyed_facts GROUP BY {key_names}
            ), mapped_keys AS (
                SELECT DISTINCT {', '.join(f'fact.{field}_key' for field in keys)},
                       effective_entry.base_code AS effective_base_code,
                       {mapping.effective_resolution_sql} AS effective_mapping_resolution,
                       effective_entry.base_name AS mapped_base_name,
                       effective_entry.regional_name AS mapped_region,
                       effective_entry.rm_region AS mapped_rm_area,
                       effective_entry.rm_responsible AS mapped_rm
                FROM mapping_keys AS fact
                {plan.mapping_from_sql}
                WHERE {scope}
            ), daily AS (
                SELECT data_date, {key_names}, order_origin_key, {min_values},
                       MIN(order_origin) AS order_origin, MIN(publication_id) AS publication_id, COUNT(*) AS row_count, {sums}
                FROM keyed_facts
                GROUP BY data_date, {key_names}, order_origin_key
            )
            SELECT daily.*, mapped.effective_base_code, mapped.effective_mapping_resolution,
                   mapped.mapped_base_name, mapped.mapped_region, mapped.mapped_rm_area, mapped.mapped_rm
            FROM daily JOIN mapped_keys AS mapped ON {final_keys}
            ORDER BY daily.data_date, daily.source_base_name_key, daily.order_origin_key
        """), parameters).mappings()
        aggregates = []
        for item in result:
            row = {field: value for field, value in dict(item).items() if not field.endswith('_key')}
            for field in (*RETENTION_FIELDS, "row_count"):
                row[field] = int(row[field] or 0)
            row["publication_id"] = str(uuid.UUID(bytes=bytes(row["publication_id"])))
            aggregates.append(row)
    return {"sourceId": "collection_monitoring", "contractVersion": 2, "aggregates": aggregates}


def get_regional_retention_table(
    engine: Engine, *, identity: dict[str, Any], date_from: date, date_to: date,
    region: str | None = None, rm: str | None = None, rm_area: str | None = None,
    base: str | None = None, origin: str | None = None,
    rgm_filter: bool = False, rgm_regions: list[str] | None = None,
) -> dict[str, object]:
    """Finish dimension filters and day/region grouping before the HTTP response.

    These are display-value filters, never authority: _scope_clause has already
    restricted every weighted key. Mirror ECMAScript whitespace folding used by
    the existing UI, without changing the official name-matching SQL.
    RGM regions are restrictive selections from the UI's official RGM registry.
    """
    import re
    whitespace = r"[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+"
    def display(value: object) -> str:
        return re.sub(whitespace, " ", str(value or "")).strip(" ")
    result = _get_authorized_retention_aggregates(engine, identity=identity, date_from=date_from, date_to=date_to)
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in result["aggregates"]:
        confirmed = row["effective_mapping_resolution"] == "NAME_APPROVED" and bool(display(row["effective_base_code"]))
        mapped_region = (display(row["mapped_region"]) or "Sem regional") if confirmed else "Sem regional"
        dimensions = {
            "region": mapped_region,
            "rm": (display(row["mapped_rm"]) or "Sem RM") if confirmed else "Sem RM",
            "rm_area": (display(row["mapped_rm_area"]) or "Sem região do RM") if confirmed else "Sem região do RM",
            "base": (display(row["mapped_base_name"]) or display(row["source_base_name"]) or "Sem base") if confirmed else (display(row["source_base_name"]) or "Sem base"),
            "origin": display(row["order_origin"]) or "Sem origem",
        }
        if any(value and dimensions[key] != value for key, value in (("region", region), ("rm", rm), ("rm_area", rm_area), ("base", base), ("origin", origin))):
            continue
        if rgm_filter and mapped_region not in (rgm_regions or []):
            continue
        day = str(row["data_date"])[:10]
        item = grouped.setdefault((day, mapped_region), {"data_date": day, "region": mapped_region, "publication_id": row["publication_id"], "row_count": 0, **dict.fromkeys(RETENTION_FIELDS, 0)})
        item["row_count"] += row["row_count"]
        for field in RETENTION_FIELDS:
            item[field] += row[field]
    dates = sorted({day for day, _region in grouped})[-3:]
    return {"sourceId": "collection_monitoring", "contractVersion": 2,
            "aggregates": [item for (day, _region), item in sorted(grouped.items()) if day in dates]}
