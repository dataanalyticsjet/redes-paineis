from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any
import uuid

from sqlalchemy import Engine, text

from app.services.data_foundation.contracts import CONTRACTS, CONTRACT_VERSIONS, get_contract
from app.services.data_foundation.mapping_resolution import build_mapping_query, code_only_mapping
from app.services.data_foundation.repository import DAILY_SOURCES, FACT_TABLES, DataFoundationError, fact_table_for_contract


@dataclass(frozen=True)
class ScopedQuery:
    source_id: str
    where_sql: str
    parameters: dict[str, object]
    from_sql: str
    fact_from_sql: str
    mapping_from_sql: str
    select_sql: str


def _is_active_text_filter(value: str | None) -> bool:
    """Match the query planner's existing truthiness rule for text filters."""
    return bool(value)


def _scope_clause(
    identity: dict[str, Any],
    params: dict[str, object],
    *,
    mapping_alias: str = "effective_entry",
    dialect: str = "mysql",
) -> str:
    scope = str(identity.get("organizational_scope") or "").strip().lower()
    role = str(identity.get("role") or "").strip().lower()
    if scope == "matrix" and role == "matrix":
        return ""
    if scope == "regional":
        if role != "regional":
            raise DataFoundationError("user_scope_unavailable", 403)
        if "effective_regions" in identity:
            authorized_regions = identity.get("effective_regions") or []
        else:
            # Compatibility for internal callers that have not yet resolved a
            # current PlatformUser identity. HTTP routes always pass this field.
            authorized_regions = [identity.get("home_region"), *(identity.get("additional_regions") or [])]
        regions = {
            str(region).strip().upper()
            for region in authorized_regions
            if str(region or "").strip()
        }
        if not regions:
            raise DataFoundationError("user_scope_unavailable", 403)
        placeholders = []
        for index, region in enumerate(sorted(regions)):
            key = f"scope_region_{index}"
            params[key] = region
            placeholders.append(f":{key}")
        regional_expression = (
            f"{mapping_alias}.regional_name COLLATE BINARY"
            if dialect == "sqlite"
            else f"BINARY {mapping_alias}.regional_name"
        )
        return f"{regional_expression} IN ({', '.join(placeholders)})"
    if scope == "base":
        if role != "regional":
            raise DataFoundationError("user_scope_unavailable", 403)
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
            extra_region_expression = (
                f"{mapping_alias}.regional_name COLLATE BINARY"
                if dialect == "sqlite"
                else f"BINARY {mapping_alias}.regional_name"
            )
            extra_region_clause = f" OR {extra_region_expression} IN ({', '.join(placeholders)})"
        home_region = str(identity.get("home_region") or identity.get("region") or "").strip().upper()
        if home_region:
            params["scope_base_name"] = base_code
            params["scope_home_region"] = home_region
            base_name_expression = (
                f"{mapping_alias}.base_name COLLATE BINARY"
                if dialect == "sqlite"
                else f"BINARY {mapping_alias}.base_name"
            )
            home_region_expression = (
                f"{mapping_alias}.regional_name COLLATE BINARY"
                if dialect == "sqlite"
                else f"BINARY {mapping_alias}.regional_name"
            )
            exact_name_expression = (
                "exact_base.base_name COLLATE BINARY"
                if dialect == "sqlite"
                else "BINARY exact_base.base_name"
            )
            exact_region_expression = (
                "exact_base.regional_name COLLATE BINARY"
                if dialect == "sqlite"
                else "BINARY exact_base.regional_name"
            )
            return (
                f"({mapping_alias}.base_code = :scope_base_code"
                f" OR ({base_name_expression} = {(':scope_base_name COLLATE BINARY' if dialect == 'sqlite' else 'BINARY :scope_base_name')}"
                f" AND {home_region_expression} = {(':scope_home_region COLLATE BINARY' if dialect == 'sqlite' else 'BINARY :scope_home_region')}"
                f" AND (SELECT COUNT(*) FROM base_mapping_entries AS exact_base"
                f" WHERE exact_base.map_version_id = {mapping_alias}.map_version_id"
                f" AND {exact_name_expression} = {base_name_expression}"
                f" AND {exact_region_expression} = {(':scope_home_region COLLATE BINARY' if dialect == 'sqlite' else 'BINARY :scope_home_region')}) = 1){extra_region_clause})"
            )
        return f"({mapping_alias}.base_code = :scope_base_code{extra_region_clause})"
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
    contract_version: int | None = None,
    sql_dialect: str = "mysql",
) -> ScopedQuery:
    # Validate and build the server-resolved scope before planning any fact read.
    scope_parameters: dict[str, object] = {}
    scope_predicate = _scope_clause(identity, scope_parameters, dialect=sql_dialect)
    selected_version = contract_version
    if selected_version is None:
        legacy_contract = CONTRACTS.get(source_id)
        selected_version = legacy_contract.version if legacy_contract is not None else None
    try:
        contract = get_contract(source_id, selected_version)
        table = fact_table_for_contract(source_id, contract.version)
    except KeyError:
        raise DataFoundationError("data_source_not_found", 404)
    except RuntimeError as error:
        if isinstance(error, DataFoundationError):
            raise
        raise DataFoundationError("data_source_contract_version_not_supported", 404) from None
    if source_id == "no_movement" and (date_from or date_to):
        raise DataFoundationError("date_filter_not_supported", 422)

    params: dict[str, object] = {"source_id": source_id, **scope_parameters}
    if date_from:
        params["date_from"] = date_from
    if date_to:
        params["date_to"] = date_to
    fact_from_sql_override: str | None = None
    if publication_id is not None:
        try:
            params["selected_publication_id"] = uuid.UUID(publication_id).bytes
        except ValueError:
            raise DataFoundationError("publication_id_invalid", 422) from None
        head_join = """
            JOIN source_publications AS selected_publication
              ON selected_publication.source_id = fact.source_id
             AND selected_publication.publication_id = fact.publication_id
             AND selected_publication.contract_version = :contract_version
             AND selected_publication.publication_state = 'PUBLISHED'
        """
        params["contract_version"] = contract.version
    elif source_id == "collection_monitoring_t4_t5" and contract.version == 1:
        # Drive this high-volume source from its active daily heads. On MySQL,
        # STRAIGHT_JOIN keeps the access path head -> published publication ->
        # fact lookup, using the existing fact index on source/publication/date.
        # SQLite keeps ordinary JOINs so tests remain portable.
        params["contract_version"] = contract.version
        join_operator = "STRAIGHT_JOIN" if sql_dialect == "mysql" else "JOIN"
        fact_from_sql_override = f"""
            FROM source_daily_head AS head
            {join_operator} source_publications AS active_publication
              ON active_publication.source_id = head.source_id
             AND active_publication.publication_id = head.publication_id
             AND active_publication.contract_version = :contract_version
             AND active_publication.publication_state = 'PUBLISHED'
            {join_operator} `{table}` AS fact
              ON fact.source_id = head.source_id
             AND fact.publication_id = head.publication_id
             AND fact.data_date = head.data_date
        """
    elif (
        source_id == "collection_rate" and contract.version in {1, 2, 3}
    ) or (
        source_id == "collection_monitoring" and contract.version in {1, 2}
    ):
        # source_daily_head is source-wide rather than contract-versioned.
        # Select the current partition independently for each contract version
        # so a newer monthly format cannot hide preserved V1/V2 facts.
        params["contract_version"] = contract.version
        daily_date_filter = []
        if date_from:
            daily_date_filter.append("publication_dates.data_date >= :date_from")
        if date_to:
            daily_date_filter.append("publication_dates.data_date <= :date_to")
        daily_date_filter_sql = " AND " + " AND ".join(daily_date_filter) if daily_date_filter else ""
        head_join = """
            JOIN (
                SELECT ranked_dates.source_id, ranked_dates.data_date, ranked_dates.publication_id
                FROM (
                    SELECT publication_dates.source_id, publication_dates.data_date,
                           publication_dates.publication_id,
                           ROW_NUMBER() OVER (
                               PARTITION BY publication_dates.source_id, publication_dates.data_date
                               ORDER BY daily_publication.version_no DESC
                           ) AS publication_rank
                    FROM source_publication_dates AS publication_dates
                    JOIN source_publications AS daily_publication
                      ON daily_publication.source_id = publication_dates.source_id
                     AND daily_publication.publication_id = publication_dates.publication_id
                    WHERE daily_publication.source_id = :source_id
                      AND daily_publication.contract_version = :contract_version
                      AND daily_publication.publication_state = 'PUBLISHED'
            """ + daily_date_filter_sql + """
                ) AS ranked_dates
                WHERE ranked_dates.publication_rank = 1
            ) AS versioned_head
              ON versioned_head.source_id = fact.source_id
             AND versioned_head.data_date = fact.data_date
             AND versioned_head.publication_id = fact.publication_id
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
    column_keys = {column.key for column in contract.columns}
    mapping_query = build_mapping_query(
        source_id=source_id,
        has_source_base_code="source_base_code" in column_keys,
        has_source_base_name="source_base_name" in column_keys,
        allow_name_mapping=not code_only_mapping(source_id, contract.version),
        dialect=sql_dialect,
    )
    fact_from_sql = fact_from_sql_override or f"""
        FROM {chr(96)}{table}{chr(96)} AS fact
        {head_join}
    """
    mapping_from_sql = f"""
        JOIN base_mapping_current AS current_map
          ON current_map.current_key = 'OFFICIAL'
        JOIN base_mapping_versions AS current_version
          ON current_version.map_version_id = current_map.map_version_id
         AND current_version.version_state = 'PUBLISHED'
        {mapping_query.joins}
    """
    from_sql = f"{fact_from_sql} {mapping_from_sql}"
    where_parts = [
        "fact.source_id = :source_id",
    ]
    if source_id == "collection_monitoring_t4_t5" and contract.version == 1 and publication_id is None:
        where_parts.append("head.source_id = :source_id")
    if publication_id is not None:
        where_parts.append("fact.publication_id = :selected_publication_id")
    where_parts.append(scope_predicate)
    if date_from:
        where_parts.append("fact.data_date >= :date_from")
        if source_id == "collection_monitoring_t4_t5" and contract.version == 1 and publication_id is None:
            where_parts.append("head.data_date >= :date_from")
        params["date_from"] = date_from
    if date_to:
        where_parts.append("fact.data_date <= :date_to")
        if source_id == "collection_monitoring_t4_t5" and contract.version == 1 and publication_id is None:
            where_parts.append("head.data_date <= :date_to")
        params["date_to"] = date_to
    if _is_active_text_filter(base_code):
        where_parts.append("effective_entry.base_code = :filter_base_code")
        params["filter_base_code"] = base_code
    if _is_active_text_filter(region):
        if region == "Sem regional":
            where_parts.append("effective_entry.base_code IS NULL")
        elif sql_dialect == "sqlite":
            where_parts.append("CAST(effective_entry.regional_name AS BLOB) = CAST(:filter_region AS BLOB)")
        else:
            where_parts.append("BINARY effective_entry.regional_name = BINARY :filter_region")
        params["filter_region"] = region

    fields = [f"fact.`{column.key}` AS `{column.key}`" for column in contract.columns]
    fields.extend([
        "fact.publication_id AS publication_id",
        "fact.source_row_no AS source_row_no",
        "fact.resolved_base_code AS resolved_base_code",
        "fact.mapping_resolution AS mapping_resolution",
        f"{mapping_query.effective_base_code_sql} AS effective_base_code",
        f"{mapping_query.effective_resolution_sql} AS effective_mapping_resolution",
        f"{mapping_query.match_method_sql} AS mapping_match_method",
        "effective_entry.base_name AS mapped_base_name",
        "effective_entry.regional_name AS mapped_region",
        "effective_entry.uf_code AS mapped_uf",
        "effective_entry.rm_region AS mapped_rm_area",
        "effective_entry.rm_responsible AS mapped_rm",
    ])
    if source_id == "pdd_collection_failure" and contract.version == 2:
        fields.extend([
            "fact.source_sheet_name AS source_sheet_name",
            "fact.source_sheet_row_no AS source_sheet_row_no",
        ])
    return ScopedQuery(
        source_id=source_id,
        where_sql=" AND ".join(part for part in where_parts if part),
        parameters=params,
        from_sql=from_sql,
        fact_from_sql=fact_from_sql,
        mapping_from_sql=mapping_from_sql,
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


def _is_resolved_matrix_scope(identity: dict[str, Any]) -> bool:
    """Use publication metadata only for the backend-resolved national scope.

    `platform_role` is intentionally not considered here: ADMIN authorization
    and data scope are independent. The `role` and `organizational_scope`
    values are populated by the authenticated backend identity.
    """
    return (
        str(identity.get("organizational_scope") or "").strip().lower() == "matrix"
        and str(identity.get("role") or "").strip().lower() == "matrix"
    )


def _matrix_daily_metadata_eligible(
    identity: dict[str, Any],
    *,
    source_id: str,
    contract_version: int | None,
    base_code: str | None,
    region: str | None,
    publication_id: str | None,
) -> bool:
    """Use daily publication metadata only for unfiltered, resolved MATRIX data.

    Metadata is valid for collection_rate V3, collection_monitoring V2, and
    the daily-replacement T4/T5 source.
    Date bounds select daily partitions; base, region, and historical-publication
    filters change row visibility and must use the scoped fact query.
    """
    supported_daily_contract = (
        source_id == "collection_rate" and contract_version == 3
    ) or (
        source_id == "collection_monitoring" and contract_version == 2
    ) or (
        source_id == "collection_monitoring_t4_t5" and contract_version == 1
    )
    return (
        supported_daily_contract
        and _is_resolved_matrix_scope(identity)
        and not _is_active_text_filter(base_code)
        and not _is_active_text_filter(region)
        and publication_id is None
    )


def _matrix_collection_monitoring_v2_page_eligible(
    identity: dict[str, Any],
    *,
    source_id: str,
    contract_version: int | None,
    base_code: str | None,
    region: str | None,
) -> bool:
    """Page facts before mapping only when MATRIX visibility is row-independent."""
    return (
        (
            source_id == "collection_monitoring" and contract_version == 2
            or source_id == "collection_monitoring_t4_t5" and contract_version == 1
        )
        and _is_resolved_matrix_scope(identity)
        and not _is_active_text_filter(base_code)
        and not _is_active_text_filter(region)
    )


def _daily_metadata_dates_cte(
    *,
    date_from: date | None,
    date_to: date | None,
) -> str:
    """Select the latest published daily partition for each requested day."""
    date_filters = []
    if date_from is not None:
        date_filters.append("publication_dates.data_date >= :date_from")
    if date_to is not None:
        date_filters.append("publication_dates.data_date <= :date_to")
    date_filter_sql = " AND " + " AND ".join(date_filters) if date_filters else ""
    return f"""
        WITH ranked_metadata_dates AS (
            SELECT publication_dates.source_id, publication_dates.data_date,
                   publication_dates.publication_id, publication_dates.row_count,
                   daily_publication.published_at, daily_publication.snapshot_as_of,
                   ROW_NUMBER() OVER (
                       PARTITION BY publication_dates.source_id, publication_dates.data_date
                       ORDER BY daily_publication.version_no DESC
                   ) AS publication_rank
            FROM source_publication_dates AS publication_dates
            JOIN source_publications AS daily_publication
              ON daily_publication.source_id = publication_dates.source_id
             AND daily_publication.publication_id = publication_dates.publication_id
            WHERE daily_publication.source_id = :source_id
              AND daily_publication.contract_version = :contract_version
              AND daily_publication.publication_state = 'PUBLISHED'
              {date_filter_sql}
        )
    """


def _daily_metadata_consistency_expression(dialect: str) -> str:
    """Check published daily row/date metadata before trusting its fast path.

    Facts and their per-date counts are written in one publication
    transaction. This inexpensive metadata-only guard also detects incomplete
    publication metadata and routes such histories through the legacy query.
    """
    if dialect == "sqlite":
        period_start_differs = "publication.period_start IS NOT daily_metadata.period_start"
        period_end_differs = "publication.period_end IS NOT daily_metadata.period_end"
    else:
        period_start_differs = "NOT (publication.period_start <=> daily_metadata.period_start)"
        period_end_differs = "NOT (publication.period_end <=> daily_metadata.period_end)"
    return f"""NOT EXISTS (
        SELECT 1
        FROM source_publications AS publication
        LEFT JOIN (
            SELECT source_id, publication_id,
                   MIN(data_date) AS period_start,
                   MAX(data_date) AS period_end,
                   SUM(row_count) AS row_count
            FROM source_publication_dates
            WHERE source_id = :source_id
            GROUP BY source_id, publication_id
        ) AS daily_metadata
          ON daily_metadata.source_id = publication.source_id
         AND daily_metadata.publication_id = publication.publication_id
        WHERE publication.source_id = :source_id
          AND publication.contract_version = :contract_version
          AND publication.publication_state = 'PUBLISHED'
          AND (
                publication.row_count <> COALESCE(daily_metadata.row_count, 0)
             OR {period_start_differs}
             OR {period_end_differs}
          )
        LIMIT 1
    )"""


def _publication_contract_filter(
    contracts: list[tuple[int, Any]],
    parameters: dict[str, object],
    *,
    alias: str = "publication",
) -> str:
    """Build a SQL filter for contract versions supported by this code."""
    placeholders = []
    for index, (version, _contract) in enumerate(contracts):
        key = f"supported_contract_version_{index}"
        parameters[key] = version
        placeholders.append(f":{key}")
    return f"{alias}.contract_version IN ({', '.join(placeholders)})"


def _daily_publication_metadata_is_consistent(
    engine: Engine,
    *,
    source_id: str,
    publication_filter: str,
    parameters: dict[str, object],
) -> bool:
    """Check publication row/date metadata without reading a fact table.

    The publisher writes `source_publications` and `source_publication_dates`
    in the same transaction as fact insertion. This check detects incomplete
    or inconsistent daily metadata and lets the caller retain the legacy fact
    aggregation path for those exceptional histories.
    """
    if engine.dialect.name == "sqlite":
        period_start_differs = "publication.period_start IS NOT daily_metadata.period_start"
        period_end_differs = "publication.period_end IS NOT daily_metadata.period_end"
    else:
        period_start_differs = "NOT (publication.period_start <=> daily_metadata.period_start)"
        period_end_differs = "NOT (publication.period_end <=> daily_metadata.period_end)"

    with engine.connect() as connection:
        inconsistent = connection.execute(text(f"""
            SELECT 1
            FROM source_publications AS publication
            LEFT JOIN (
                SELECT source_id, publication_id,
                       MIN(data_date) AS period_start,
                       MAX(data_date) AS period_end,
                       SUM(row_count) AS row_count
                FROM source_publication_dates
                WHERE source_id = :source_id
                GROUP BY source_id, publication_id
            ) AS daily_metadata
              ON daily_metadata.source_id = publication.source_id
             AND daily_metadata.publication_id = publication.publication_id
            WHERE {publication_filter}
              AND (
                    publication.row_count <> COALESCE(daily_metadata.row_count, 0)
                 OR {period_start_differs}
                 OR {period_end_differs}
              )
            LIMIT 1
        """), parameters).first()
    return inconsistent is None


def _get_matrix_publications_from_metadata(
    engine: Engine,
    *,
    source_id: str,
    publication_filter: str,
    parameters: dict[str, object],
    limit: int,
    offset: int,
) -> dict[str, object]:
    """List visible matrix publication history from publication metadata only."""
    with engine.connect() as connection:
        total = int(connection.execute(text(f"""
            SELECT COUNT(*)
            FROM source_publications AS publication
            WHERE {publication_filter}
              AND publication.row_count > 0
        """), parameters).scalar_one())
        rows = connection.execute(text(f"""
            SELECT publication.publication_id, publication.version_no,
                   publication.contract_version, publication.published_at,
                   publication.snapshot_as_of,
                   publication.row_count AS visible_row_count,
                   publication.period_start, publication.period_end
            FROM source_publications AS publication
            WHERE {publication_filter}
              AND publication.row_count > 0
            ORDER BY publication.version_no DESC
            LIMIT :limit OFFSET :offset
        """), {**parameters, "limit": limit, "offset": offset}).mappings()
        publications = [
            {
                "publicationId": str(uuid.UUID(bytes=bytes(row["publication_id"]))),
                "version": int(row["version_no"]),
                "contractVersion": int(row["contract_version"]),
                "publishedAt": row["published_at"],
                "snapshotAsOf": row["snapshot_as_of"],
                "visibleRowCount": int(row["visible_row_count"]),
                "periodStart": row["period_start"],
                "periodEnd": row["period_end"],
            }
            for row in rows
        ]
    return {
        "sourceId": source_id,
        "publications": publications,
        "total": total,
        "limit": limit,
        "offset": offset,
    }


def get_current_mapping_status(engine: Engine, *, identity: dict[str, Any]) -> dict[str, object]:
    """Return current map metadata and only the base count visible to this identity."""
    parameters: dict[str, object] = {}
    # This validates scope before any database query and applies it to counts.
    scope = _scope_clause(identity, parameters, mapping_alias="current_entry", dialect=engine.dialect.name)
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
    contract_version: int | None = None,
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
        contract_version=contract_version,
        sql_dialect=engine.dialect.name,
    )
    _assert_map_available(engine)
    where = f"WHERE {plan.where_sql}"
    order = "fact.data_date DESC, fact.source_row_no ASC" if source_id in DAILY_SOURCES else "fact.source_row_no ASC"
    use_metadata_count = _matrix_daily_metadata_eligible(
        identity,
        source_id=source_id,
        contract_version=contract_version,
        base_code=base_code,
        region=region,
        publication_id=publication_id,
    )
    page_facts_before_mapping = _matrix_collection_monitoring_v2_page_eligible(
        identity,
        source_id=source_id,
        contract_version=contract_version,
        base_code=base_code,
        region=region,
    )
    count_from_sql = plan.fact_from_sql if page_facts_before_mapping else plan.from_sql
    with engine.connect() as connection:
        if use_metadata_count:
            metadata_count = connection.execute(text(f"""
                {_daily_metadata_dates_cte(date_from=date_from, date_to=date_to)}
                SELECT COALESCE(SUM(metadata.row_count), 0) AS total,
                       CASE WHEN {_daily_metadata_consistency_expression(engine.dialect.name)}
                            THEN 1 ELSE 0 END AS metadata_consistent
                FROM ranked_metadata_dates AS metadata
                WHERE metadata.publication_rank = 1
                  AND metadata.row_count > 0
            """), plan.parameters).mappings().one()
            if metadata_count["metadata_consistent"]:
                total = int(metadata_count["total"])
            else:
                # Do not trust incomplete metadata: retain the existing fact
                # count for this exceptional publication history.
                total = int(connection.execute(
                    text(f"SELECT COUNT(*) {count_from_sql} {where}"),
                    plan.parameters,
                ).scalar_one())
        else:
            total = int(connection.execute(text(f"SELECT COUNT(*) {count_from_sql} {where}"), plan.parameters).scalar_one())
        if page_facts_before_mapping:
            result = connection.execute(text(f"""
                WITH page_facts AS (
                    SELECT fact.*
                    {plan.fact_from_sql}
                    {where}
                    ORDER BY {order}
                    LIMIT :page_limit OFFSET :page_offset
                )
                SELECT {plan.select_sql}
                FROM page_facts AS fact
                {plan.mapping_from_sql}
                ORDER BY {order}
            """), {**plan.parameters, "page_limit": limit, "page_offset": offset})
        else:
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
    contract_version: int | None = None,
    latest_only: bool = False,
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
        contract_version=contract_version,
        sql_dialect=engine.dialect.name,
    )
    _assert_map_available(engine)
    metadata_fallback_has_published: bool | None = None
    use_metadata_dates = _matrix_daily_metadata_eligible(
        identity,
        source_id=source_id,
        contract_version=contract_version,
        base_code=base_code,
        region=region,
        publication_id=publication_id,
    )
    if use_metadata_dates:
        with engine.connect() as connection:
            publication_state = connection.execute(text(f"""
                SELECT EXISTS (
                    SELECT 1
                    FROM source_publications
                    WHERE source_id = :source_id
                      AND contract_version = :contract_version
                      AND publication_state = 'PUBLISHED'
                ) AS has_published_publication,
                CASE WHEN {_daily_metadata_consistency_expression(engine.dialect.name)}
                     THEN 1 ELSE 0 END AS metadata_consistent
            """), plan.parameters).mappings().one()
            metadata_fallback_has_published = bool(publication_state["has_published_publication"])
            if publication_state["metadata_consistent"]:
                rows = connection.execute(text(f"""
                    {_daily_metadata_dates_cte(date_from=date_from, date_to=date_to)}
                    SELECT metadata.data_date AS date, metadata.row_count AS row_count,
                           metadata.publication_id, metadata.published_at,
                           metadata.snapshot_as_of
                    FROM ranked_metadata_dates AS metadata
                    WHERE metadata.publication_rank = 1
                      AND metadata.row_count > 0
                    ORDER BY metadata.data_date DESC
                    {"LIMIT 1" if latest_only else ""}
                """), plan.parameters).mappings()
                dates = [
                    {
                        "date": row["date"],
                        "rowCount": int(row["row_count"]),
                        "publicationId": str(uuid.UUID(bytes=bytes(row["publication_id"]))),
                        "publishedAt": row["published_at"],
                        "snapshotAsOf": row["snapshot_as_of"],
                    }
                    for row in rows
                ]
                return {
                    "sourceId": source_id,
                    "dates": dates,
                    "hasPublishedPublication": metadata_fallback_has_published,
                }
    if source_id == "no_movement":
        with engine.connect() as connection:
            count = int(connection.execute(text(f"SELECT COUNT(*) {plan.from_sql} WHERE {plan.where_sql}"), plan.parameters).scalar_one())
        return {"sourceId": source_id, "dates": [], "snapshotRowCount": count}
    if (
        source_id == "collection_rate" and contract_version in {2, 3}
    ) or (
        source_id == "collection_monitoring" and contract_version == 2
    ):
        with engine.connect() as connection:
            has_published_publication = metadata_fallback_has_published
            if has_published_publication is None:
                has_published_publication = bool(connection.execute(text("""
                    SELECT EXISTS (
                        SELECT 1
                        FROM source_publications
                        WHERE source_id = :source_id
                          AND contract_version = :contract_version
                          AND publication_state = 'PUBLISHED'
                    )
                """), plan.parameters).scalar_one())
            latest_data_date = None
            if latest_only:
                latest_from_sql = plan.fact_from_sql if _is_resolved_matrix_scope(identity) and not _is_active_text_filter(base_code) and not _is_active_text_filter(region) and publication_id is None else plan.from_sql
                latest_data_date = connection.execute(text(f"""
                    SELECT fact.data_date
                    {latest_from_sql}
                    WHERE {plan.where_sql}
                    ORDER BY fact.data_date DESC, fact.source_row_no ASC
                    LIMIT 1
                """), plan.parameters).scalar_one_or_none()
                if latest_data_date is None:
                    return {
                        "sourceId": source_id,
                        "dates": [],
                        "hasPublishedPublication": has_published_publication,
                    }
            dates_where = plan.where_sql
            dates_parameters = dict(plan.parameters)
            if latest_data_date is not None:
                dates_where += " AND fact.data_date = :latest_data_date"
                dates_parameters["latest_data_date"] = latest_data_date
            rows = connection.execute(text(f"""
                SELECT fact.data_date AS date, fact.publication_id,
                       daily_publication.published_at, daily_publication.snapshot_as_of,
                       COUNT(*) AS row_count
                {plan.from_sql}
                JOIN source_publications AS daily_publication
                  ON daily_publication.source_id = fact.source_id
                 AND daily_publication.publication_id = fact.publication_id
                 AND daily_publication.contract_version = :contract_version
                 AND daily_publication.publication_state = 'PUBLISHED'
                WHERE {dates_where}
                GROUP BY fact.data_date, fact.publication_id,
                         daily_publication.published_at, daily_publication.snapshot_as_of
                ORDER BY fact.data_date DESC
                {"LIMIT 1" if latest_only else ""}
            """), dates_parameters).mappings()
            dates = [
                {
                    "date": row["date"],
                    "rowCount": int(row["row_count"]),
                    "publicationId": str(uuid.UUID(bytes=bytes(row["publication_id"]))),
                    "publishedAt": row["published_at"],
                    "snapshotAsOf": row["snapshot_as_of"],
                }
                for row in rows
            ]
        return {
            "sourceId": source_id,
            "dates": dates,
            "hasPublishedPublication": has_published_publication,
        }
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
    contract_version: int | None = None,
) -> tuple[list[str], list[dict[str, object]]]:
    selected_version = contract_version
    if selected_version is None:
        legacy_contract = CONTRACTS.get(source_id)
        selected_version = legacy_contract.version if legacy_contract is not None else None
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
        contract_version=selected_version,
    )
    headers = [
        *(column.key for column in get_contract(source_id, selected_version).columns),
        "publication_id", "source_row_no", "resolved_base_code", "mapping_resolution",
        "effective_base_code", "effective_mapping_resolution", "mapping_match_method",
        "mapped_base_name", "mapped_region", "mapped_uf", "mapped_rm_area", "mapped_rm",
    ]
    contract = get_contract(source_id, selected_version)
    if source_id == "pdd_collection_failure" and contract.version == 2:
        headers.extend(["source_sheet_name", "source_sheet_row_no"])
    return headers, result["records"]


def get_publications(
    engine: Engine,
    *,
    source_id: str,
    identity: dict[str, Any],
    limit: int,
    offset: int,
    contract_version: int | None = None,
) -> dict[str, object]:
    if source_id not in FACT_TABLES:
        raise DataFoundationError("data_source_not_found", 404)
    contracts = [
        (version, contract)
        for (registered_source, version), contract in CONTRACT_VERSIONS.items()
        if registered_source == source_id and (contract_version is None or version == contract_version)
    ]
    if not contracts:
        raise DataFoundationError("data_source_contract_version_not_supported", 404)
    # Scoped publication history is data too: regional/base row counts and
    # periods must be computed from facts visible to this identity. Matrix
    # viewers retain unmapped rows and can use publication metadata only after
    # the publisher's count/period invariants have been checked.
    parameters: dict[str, object] = {"source_id": source_id}
    matrix_scope = _is_resolved_matrix_scope(identity)
    scope = _scope_clause(identity, parameters, dialect=engine.dialect.name)
    _assert_map_available(engine)
    publication_filter = "publication.source_id = :source_id AND publication.publication_state = 'PUBLISHED'"
    if contract_version is not None:
        parameters["contract_version"] = contract_version
        publication_filter += " AND publication.contract_version = :contract_version"

    if matrix_scope:
        metadata_parameters = dict(parameters)
        metadata_filter = (
            publication_filter
            + " AND "
            + _publication_contract_filter(contracts, metadata_parameters)
        )
        metadata_is_consistent = (
            source_id not in DAILY_SOURCES
            or _daily_publication_metadata_is_consistent(
                engine,
                source_id=source_id,
                publication_filter=metadata_filter,
                parameters=metadata_parameters,
            )
        )
        if metadata_is_consistent:
            return _get_matrix_publications_from_metadata(
                engine,
                source_id=source_id,
                publication_filter=metadata_filter,
                parameters=metadata_parameters,
                limit=limit,
                offset=offset,
            )

    if source_id in DAILY_SOURCES:
        date_select = "MIN(fact.data_date) AS period_start, MAX(fact.data_date) AS period_end"
    elif source_id == "no_movement":
        # For snapshots these fields carry the collection date from the latest
        # successful Bot_NewBI execution, not a business-date range.
        date_select = "publication.period_start AS period_start, publication.period_end AS period_end"
    else:
        date_select = "NULL AS period_start, NULL AS period_end"
    with engine.connect() as connection:
        published_versions = {
            int(row[0])
            for row in connection.execute(text("""
                SELECT DISTINCT contract_version
                FROM source_publications
                WHERE source_id = :source_id
                  AND publication_state = 'PUBLISHED'
                  AND (:contract_version IS NULL OR contract_version = :contract_version)
            """), {"source_id": source_id, "contract_version": contract_version})
        }
        # A new contract may be registered before its fact table is created.
        # Do not reference that table until a PUBLISHED publication exists;
        # the publication transaction inserts its facts before exposing it.
        published_contracts = [
            (version, contract) for version, contract in contracts
            if version in published_versions
        ]
        if not published_contracts:
            return {"sourceId": source_id, "publications": [], "total": 0, "limit": limit, "offset": offset}

        fact_aggregates = []
        for version, _contract in published_contracts:
            table = fact_table_for_contract(source_id, version)
            column_keys = {column.key for column in _contract.columns}
            mapping_query = build_mapping_query(
                source_id=source_id,
                has_source_base_code="source_base_code" in column_keys,
                has_source_base_name="source_base_name" in column_keys,
                allow_name_mapping=not code_only_mapping(source_id, version),
                dialect=engine.dialect.name,
            )
            if source_id in DAILY_SOURCES:
                period_columns = "MIN(fact.data_date) AS period_start, MAX(fact.data_date) AS period_end"
            else:
                period_columns = "NULL AS period_start, NULL AS period_end"
            fact_aggregates.append(f"""
                SELECT fact.source_id, fact.publication_id, COUNT(*) AS visible_row_count,
                       {period_columns}, {version} AS contract_version
                FROM `{table}` AS fact
                JOIN base_mapping_current AS current_map
                  ON current_map.current_key = 'OFFICIAL'
                JOIN base_mapping_versions AS current_version
                  ON current_version.map_version_id = current_map.map_version_id
                 AND current_version.version_state = 'PUBLISHED'
                {mapping_query.joins}
                WHERE fact.source_id = :source_id
                  AND {scope or '1 = 1'}
                GROUP BY fact.source_id, fact.publication_id
            """)
        fact_counts_sql = " UNION ALL ".join(fact_aggregates)
        result = connection.execute(text(f"""
            SELECT publication.publication_id, publication.version_no, publication.contract_version, publication.published_at,
                   publication.snapshot_as_of, fact.visible_row_count,
                   {date_select.replace('MIN(fact.data_date) AS period_start, MAX(fact.data_date) AS period_end', 'fact.period_start, fact.period_end')}
            FROM source_publications AS publication
            JOIN ({fact_counts_sql}) AS fact
              ON fact.source_id = publication.source_id
             AND fact.publication_id = publication.publication_id
             AND fact.contract_version = publication.contract_version
            WHERE {publication_filter}
            ORDER BY publication.version_no DESC
        """), parameters).mappings()
        visible_publications = [
            {
                "publicationId": str(uuid.UUID(bytes=bytes(row["publication_id"]))),
                "version": int(row["version_no"]),
                "contractVersion": int(row["contract_version"]),
                "publishedAt": row["published_at"],
                "snapshotAsOf": row["snapshot_as_of"],
                "visibleRowCount": int(row["visible_row_count"]),
                "periodStart": row["period_start"],
                "periodEnd": row["period_end"],
            }
            for row in result
        ]
    total = len(visible_publications)
    publications = visible_publications[offset:offset + limit]
    return {"sourceId": source_id, "publications": publications, "total": total, "limit": limit, "offset": offset}
