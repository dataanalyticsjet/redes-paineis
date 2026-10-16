from __future__ import annotations

from dataclasses import dataclass
import re


NAME_MAPPED_SOURCES = frozenset({
    "collection_monitoring",
    "collection_rate",
    "jt_monitoring",
    "no_movement",
    "pdd_collection_failure",
})
CODE_RESOLUTION_SOURCES = frozenset({"no_movement", "pdd_collection_failure"})


def code_only_mapping(source_id: str, contract_version: int) -> bool:
    """Whether this contract version forbids falling back to a base name."""
    return source_id == "collection_rate" and contract_version == 2


def name_mapping_enabled(source_id: str, contract_version: int) -> bool:
    return source_id in NAME_MAPPED_SOURCES and not code_only_mapping(source_id, contract_version)


@dataclass(frozen=True)
class MappingQuery:
    joins: str
    effective_base_code_sql: str
    effective_resolution_sql: str
    match_method_sql: str


def normalize_mapping_name(value: str) -> str:
    """Fold ASCII whitespace and case while preserving punctuation and accents."""
    return re.sub(r"[ \t\n\r]+", " ", value.strip(" \t\n\r")).lower()


def resolve_name_candidates(
    *,
    exact_candidates: tuple[str, ...] = (),
    normalized_candidates: tuple[str, ...] = (),
    decision: tuple[str, str | None] | None = None,
) -> tuple[str | None, str]:
    """Resolve names against the published map; only explicit decisions disambiguate.

    Exact matches take precedence. A single official base is deterministic and
    does not require a stored LINKED decision. A manual LINKED decision can
    select one of multiple candidates when its target is one of those candidates.
    """
    candidates = exact_candidates or normalized_candidates

    if decision is not None:
        state, target_code = decision
        if state == "LINKED" and target_code in candidates:
            return target_code, "NAME_APPROVED"
        if state == "AMBIGUOUS" and len(candidates) > 1:
            return None, "AMBIGUOUS"

    if len(candidates) == 1:
        return candidates[0], "NAME_APPROVED"
    if len(candidates) > 1:
        return None, "AMBIGUOUS"
    if decision is not None and decision[0] == "AMBIGUOUS":
        return None, "AMBIGUOUS"
    return None, "UNMAPPED"


def _binary_sql(expression: str, dialect: str) -> str:
    if dialect == "sqlite":
        return f"CAST(({expression}) AS BLOB)"
    return f"BINARY ({expression})"


def _normalized_name_sql(expression: str, dialect: str) -> str:
    # Preserve punctuation and accents; only fold case and ASCII whitespace.
    pattern = r"[\t\n\r ]+"
    normalized = (
        f"LOWER(TRIM(REGEXP_REPLACE(TRIM({expression}), "
        f"'{pattern}', ' ')))"
    )
    return _binary_sql(normalized, dialect)


def build_mapping_query(
    *,
    source_id: str,
    has_source_base_code: bool,
    has_source_base_name: bool,
    allow_name_mapping: bool = True,
    dialect: str = "mysql",
) -> MappingQuery:
    """Build one-row-per-fact joins against the current published map.

    A supplied source code is authoritative and never falls back to a name.
    Otherwise, an existing code is reused, then an explicit manual decision,
    then one exact published name, and finally one conservatively normalized
    published name. Every candidate relation is grouped before joining so map
    duplicates cannot multiply fact rows.
    """
    stored_map_code = _binary_sql("stored_entry.base_code", dialect)
    stored_fact_code = _binary_sql("fact.resolved_base_code", dialect)
    joins = [f"""
        LEFT JOIN base_mapping_entries AS stored_entry
          ON stored_entry.map_version_id = current_map.map_version_id
         AND {stored_map_code} = {stored_fact_code}
    """]

    source_code_entry = None
    source_code_available = "0 = 1"
    if has_source_base_code:
        source_code = _binary_sql("fact.source_base_code", dialect)
        mapped_code = _binary_sql("source_code_entry.base_code", dialect)
        source_code_available = "(fact.source_base_code IS NOT NULL AND LENGTH(TRIM(fact.source_base_code)) > 0)"
        joins.append(f"""
        LEFT JOIN base_mapping_entries AS source_code_entry
          ON source_code_entry.map_version_id = current_map.map_version_id
         AND {mapped_code} = {source_code}
        """)
        source_code_entry = "source_code_entry"

    exact_candidate_count = None
    normalized_candidate_count = None
    exact_candidate_code = None
    normalized_candidate_code = None
    exact_decision_state = None
    normalized_decision_state = None
    exact_decision_code = None
    normalized_decision_code = None

    if has_source_base_name and allow_name_mapping:
        exact_map_key = _binary_sql("map_name.base_name", dialect)
        exact_source_key = _binary_sql("fact.source_base_name", dialect)
        joins.append(f"""
        LEFT JOIN (
            SELECT map_name.map_version_id,
                   {exact_map_key} AS exact_name_key,
                   COUNT(DISTINCT map_name.base_code) AS candidate_count,
                   MIN(map_name.base_code) AS candidate_base_code
            FROM base_mapping_entries AS map_name
            GROUP BY map_name.map_version_id, {exact_map_key}
        ) AS exact_name_candidates
          ON exact_name_candidates.map_version_id = current_map.map_version_id
         AND exact_name_candidates.exact_name_key = {exact_source_key}
        """)

        normalized_map_key = _normalized_name_sql("map_name.base_name", dialect)
        normalized_source_key = _normalized_name_sql("fact.source_base_name", dialect)
        joins.append(f"""
        LEFT JOIN (
            SELECT map_name.map_version_id,
                   {normalized_map_key} AS normalized_name_key,
                   COUNT(DISTINCT map_name.base_code) AS candidate_count,
                   MIN(map_name.base_code) AS candidate_base_code
            FROM base_mapping_entries AS map_name
            GROUP BY map_name.map_version_id, {normalized_map_key}
        ) AS normalized_name_candidates
          ON normalized_name_candidates.map_version_id = current_map.map_version_id
         AND normalized_name_candidates.normalized_name_key = {normalized_source_key}
        """)
        exact_candidate_count = "exact_name_candidates.candidate_count"
        normalized_candidate_count = "normalized_name_candidates.candidate_count"
        exact_candidate_code = "exact_name_candidates.candidate_base_code"
        normalized_candidate_code = "normalized_name_candidates.candidate_base_code"

        if source_id in NAME_MAPPED_SOURCES and allow_name_mapping:
            joins.append(f"""
            LEFT JOIN base_mapping_name_decisions AS exact_decision
              ON exact_decision.map_version_id = current_map.map_version_id
             AND exact_decision.source_id = :source_id
             AND {_binary_sql('exact_decision.source_base_name', dialect)} = {exact_source_key}
            """)
            exact_decision_state = "exact_decision.resolution_state"

            decision_name_key = _normalized_name_sql("name_decision.source_base_name", dialect)
            joins.append(f"""
            LEFT JOIN (
                SELECT name_decision.map_version_id,
                       name_decision.source_id,
                       {decision_name_key} AS normalized_name_key,
                       COUNT(*) AS decision_count,
                       MAX(name_decision.resolution_state) AS decision_state,
                       MAX(name_decision.target_base_code) AS target_base_code
                FROM base_mapping_name_decisions AS name_decision
                WHERE name_decision.source_id = :source_id
                GROUP BY name_decision.map_version_id, name_decision.source_id,
                         {decision_name_key}
                HAVING COUNT(*) = 1
            ) AS normalized_name_decision
              ON normalized_name_decision.map_version_id = current_map.map_version_id
             AND normalized_name_decision.source_id = :source_id
             AND normalized_name_decision.normalized_name_key = {normalized_source_key}
            """)
            normalized_decision_state = "normalized_name_decision.decision_state"

            joins.append("""
            LEFT JOIN base_mapping_entries AS exact_decision_entry
              ON exact_decision_entry.map_version_id = current_map.map_version_id
             AND exact_decision.resolution_state = 'LINKED'
             AND exact_decision_entry.base_code = exact_decision.target_base_code
            """)
            exact_decision_code = "exact_decision_entry.base_code"
            joins.append("""
            LEFT JOIN base_mapping_entries AS normalized_decision_entry
              ON normalized_decision_entry.map_version_id = current_map.map_version_id
             AND exact_decision.source_base_name IS NULL
             AND normalized_name_decision.decision_state = 'LINKED'
             AND normalized_decision_entry.base_code = normalized_name_decision.target_base_code
            """)
            normalized_decision_code = "normalized_decision_entry.base_code"

    exact_auto_entry = None
    normalized_auto_entry = None
    if exact_candidate_count:
        joins.append(f"""
        LEFT JOIN base_mapping_entries AS exact_auto_entry
          ON exact_auto_entry.map_version_id = current_map.map_version_id
         AND {exact_candidate_count} = 1
         AND exact_auto_entry.base_code = {exact_candidate_code}
        """)
        exact_auto_entry = "exact_auto_entry"
    if normalized_candidate_count:
        joins.append(f"""
        LEFT JOIN base_mapping_entries AS normalized_auto_entry
          ON normalized_auto_entry.map_version_id = current_map.map_version_id
         AND {exact_candidate_count} IS NULL
         AND {normalized_candidate_count} = 1
         AND normalized_auto_entry.base_code = {normalized_candidate_code}
        """)
        normalized_auto_entry = "normalized_auto_entry"

    source_code = f"{source_code_entry}.base_code" if source_code_entry else "NULL"
    stored_code = "stored_entry.base_code"
    exact_decision = exact_decision_code or "NULL"
    exact_auto = f"{exact_auto_entry}.base_code" if exact_auto_entry else "NULL"
    normalized_decision = normalized_decision_code or "NULL"
    normalized_auto = f"{normalized_auto_entry}.base_code" if normalized_auto_entry else "NULL"
    fallback_code = f"COALESCE({stored_code}, {exact_decision}, {exact_auto}, {normalized_decision}, {normalized_auto})"
    effective_code = f"CASE WHEN {source_code_available} THEN {source_code} ELSE {fallback_code} END"

    effective_map_code = _binary_sql("effective_entry.base_code", dialect)
    joins.append(f"""
    LEFT JOIN base_mapping_entries AS effective_entry
      ON effective_entry.map_version_id = current_map.map_version_id
     AND {effective_map_code} = {_binary_sql(effective_code, dialect)}
    """)

    no_identifier_parts = []
    if has_source_base_name:
        no_identifier_parts.append("(fact.source_base_name IS NULL OR LENGTH(TRIM(fact.source_base_name)) = 0)")
    if has_source_base_code:
        no_identifier_parts.append("(fact.source_base_code IS NULL OR LENGTH(TRIM(fact.source_base_code)) = 0)")
    no_identifier = " AND ".join(no_identifier_parts) or "1 = 1"

    ambiguity_terms = []
    if exact_decision_state:
        ambiguity_terms.append(f"{exact_decision_state} = 'AMBIGUOUS'")
    if normalized_decision_state:
        ambiguity_terms.append(f"({exact_candidate_count} IS NULL AND {normalized_decision_state} = 'AMBIGUOUS')")
    if exact_candidate_count:
        ambiguity_terms.append(f"{exact_candidate_count} > 1")
    if normalized_candidate_count:
        ambiguity_terms.append(f"({exact_candidate_count} IS NULL AND {normalized_candidate_count} > 1)")
    ambiguous = " OR ".join(ambiguity_terms) or "0 = 1"

    effective_resolution = f"""
    CASE
      WHEN {source_code_available} THEN CASE WHEN {source_code} IS NOT NULL THEN 'CODE_MATCH' ELSE 'UNMAPPED' END
      WHEN stored_entry.base_code IS NOT NULL THEN
        CASE WHEN fact.mapping_resolution IN ('NAME_APPROVED', 'CODE_MATCH') THEN fact.mapping_resolution ELSE 'CODE_MATCH' END
      WHEN COALESCE({exact_decision}, {exact_auto}, {normalized_decision}, {normalized_auto}) IS NOT NULL THEN 'NAME_APPROVED'
      WHEN {ambiguous} THEN 'AMBIGUOUS'
      WHEN {no_identifier} THEN 'MISSING_IDENTIFIER'
      ELSE 'UNMAPPED'
    END
    """

    match_method = f"""
    CASE
      WHEN {source_code_available} THEN CASE WHEN {source_code} IS NOT NULL THEN 'SOURCE_CODE' ELSE 'SOURCE_CODE_NO_MATCH' END
      WHEN stored_entry.base_code IS NOT NULL THEN 'PERSISTED_CODE'
      WHEN {exact_decision} IS NOT NULL THEN 'MANUAL_EXACT_NAME'
      WHEN {exact_auto} IS NOT NULL THEN 'EXACT_NAME'
      WHEN {normalized_decision} IS NOT NULL THEN 'MANUAL_NORMALIZED_NAME'
      WHEN {normalized_auto} IS NOT NULL THEN 'NORMALIZED_NAME'
      WHEN {ambiguous} THEN 'AMBIGUOUS'
      WHEN {no_identifier} THEN 'MISSING_IDENTIFIER'
      ELSE 'NO_MATCH'
    END
    """
    return MappingQuery(
        joins="\n".join(joins),
        effective_base_code_sql=effective_code,
        effective_resolution_sql=effective_resolution,
        match_method_sql=match_method,
    )
