from __future__ import annotations

import json
import logging
import uuid
from datetime import date, datetime, time, timedelta
from decimal import Decimal, ROUND_HALF_UP
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import Engine, text

logger = logging.getLogger(__name__)
SOURCE_ID = "collection_rate"
CONTRACT_VERSION = 3
RULES_VERSION = "v1"
# Matches the V3 dashboard: SUM(collected_quantity) / SUM(quantity_to_collect).
# quantity_to_collect is also the operational volume shown beside each base.
TARGET_RATE = Decimal("0.98")
REGION_LIMIT = 5
BASE_LIMIT = 2
try:
    SAO_PAULO = ZoneInfo("America/Sao_Paulo")
except ZoneInfoNotFoundError:  # Windows Python may not ship the IANA database.
    from datetime import timezone

    SAO_PAULO = timezone(timedelta(hours=-3), "America/Sao_Paulo")


def _integer(value: object) -> int:
    try:
        result = int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0
    return result if result >= 0 else 0


def _as_date(value: object) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def _rate(collected: int, planned: int) -> Decimal | None:
    return Decimal(collected) / Decimal(planned) if planned > 0 else None


def _impact(collected: int, planned: int) -> Decimal:
    """Estimated units needed to reach target; a ranking score, not observed backlog."""
    return max(Decimal(0), TARGET_RATE * Decimal(planned) - Decimal(collected))


def _percent(value: Decimal | None) -> str:
    if value is None:
        return "—"
    rounded = (value * Decimal(100)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    return f"{rounded:.1f}%".replace(".", ",")


def _volume(value: int) -> str:
    return f"{value:,}".replace(",", ".")


def _rank_key(item: dict[str, object]) -> tuple[Decimal, int, str, str]:
    return (
        -_impact(_integer(item.get("collected")), _integer(item.get("planned"))),
        -_integer(item.get("planned")),
        str(item.get("label") or item.get("name") or "").casefold(),
        str(item.get("code") or ""),
    )


def build_bilingual_analysis(
    *,
    operational_date: date,
    publication_version: int,
    collected: int,
    planned: int,
    bases: list[dict[str, object]],
    unmapped_planned: int = 0,
    units_without_denominator: int = 0,
    generated_at: datetime | None = None,
    region_limit: int = REGION_LIMIT,
    base_limit: int = BASE_LIMIT,
) -> tuple[str, dict[str, object]]:
    """Build the approved V3 rate analysis using weighted aggregates and pinned units."""
    now = generated_at or datetime.now(SAO_PAULO)
    if now.tzinfo is None:
        now = now.replace(tzinfo=SAO_PAULO)
    greeting_pt, greeting_zh = ("Bom dia, pessoal!", "大家早上好！") if now.hour < 12 else ("Boa tarde, pessoal!", "大家下午好！")
    day = _as_date(operational_date)
    national_rate = _rate(collected, planned)

    regions: dict[str, dict[str, object]] = {}
    for base in bases:
        region = str(base.get("region") or "").strip()
        if not region:
            continue
        bucket = regions.setdefault(region, {"label": region, "collected": 0, "planned": 0, "bases": []})
        bucket["collected"] = _integer(bucket["collected"]) + _integer(base.get("collected"))
        bucket["planned"] = _integer(bucket["planned"]) + _integer(base.get("planned"))
        bucket_bases = bucket["bases"]
        assert isinstance(bucket_bases, list)
        if _integer(base.get("planned")) > 0:
            bucket_bases.append(base)

    critical_regions = [
        item for item in regions.values()
        if _rate(_integer(item["collected"]), _integer(item["planned"])) is not None
        and _rate(_integer(item["collected"]), _integer(item["planned"])) < TARGET_RATE
    ]
    critical_regions.sort(key=_rank_key)
    selected_regions: list[dict[str, object]] = []
    lines = [
        greeting_pt,
        greeting_zh,
        "",
        f"📊 **TAXA DE COLETA {day.strftime('%d/%m/%Y')} | 揽收及时率**",
        "",
        f"Geral: **{_percent(national_rate)}** | Meta: **{_percent(TARGET_RATE)}**",
        f"整体：**{_percent(national_rate)}** | 目标：**{_percent(TARGET_RATE)}**",
        "",
        "⚠️ **Pontos críticos / 重点关注**",
    ]
    if not critical_regions:
        lines.extend(["", "✅ Nenhuma regional mapeada está abaixo da meta nesta data.", "✅ 本日没有已映射区域低于目标。"])
    else:
        for region in critical_regions[:max(0, region_limit)]:
            label = str(region["label"])
            regional_rate = _rate(_integer(region["collected"]), _integer(region["planned"]))
            lines.extend(["", f"🔴 **{label} — {_percent(regional_rate)}**"])
            regional_bases = [
                base for base in region["bases"]
                if _integer(base.get("planned")) > 0
                and _rate(_integer(base.get("collected")), _integer(base.get("planned"))) is not None
                and _rate(_integer(base.get("collected")), _integer(base.get("planned"))) < TARGET_RATE
            ]
            regional_bases.sort(key=_rank_key)
            chosen_bases = regional_bases[:max(0, base_limit)]
            selected_regions.append({
                "region": label,
                "collected": _integer(region["collected"]),
                "planned": _integer(region["planned"]),
                "rate": str(regional_rate),
                "estimatedTargetGap": str(_impact(_integer(region["collected"]), _integer(region["planned"]))),
                "bases": [],
            })
            for base in chosen_bases:
                base_rate = _rate(_integer(base.get("collected")), _integer(base.get("planned")))
                owner = str(base.get("responsible") or "Sem responsável identificado")
                base_label = str(base.get("name") or base.get("code") or "Base sem nome oficial")
                lines.append(f"{base_label} — **{_percent(base_rate)}** | {_volume(_integer(base.get('planned')))} pacotes | RM: {owner}")
                selected_regions[-1]["bases"].append({
                    "baseCode": str(base.get("code") or ""),
                    "baseName": base_label,
                    "responsible": owner,
                    "collected": _integer(base.get("collected")),
                    "planned": _integer(base.get("planned")),
                    "rate": str(base_rate),
                    "estimatedTargetGap": str(_impact(_integer(base.get("collected")), _integer(base.get("planned")))),
                })

    lines.extend([
        "",
        "⚠️ **Prioridade operacional: recuperar as bases de maior impacto que permanecem abaixo da meta de coleta.**",
        "⚠️ **运营重点：优先改善订单量大且揽收及时率低于目标的网点。**",
        "",
        "Contamos com o acompanhamento e a atuação dos responsáveis.",
        "请各负责人重点跟进并持续改善。",
        "",
        "*Prioridade ordenada pelo déficit matemático estimado até a meta; não representa uma quantidade observada de pedidos atrasados.*",
        "*排序依据为达到目标的数学估算差额，不代表实际逾期订单量。*",
    ])
    if unmapped_planned > 0:
        lines.extend([
            "",
            f"ℹ️ Volume sem regional/base DoomsDay vinculada mantido no consolidado nacional: {_volume(unmapped_planned)} pacotes.",
            f"ℹ️ 未关联 DoomsDay 区域/网点的数量仍计入全国汇总：{_volume(unmapped_planned)} 单。",
        ])
    if units_without_denominator > 0:
        lines.extend([
            "",
            f"ℹ️ {units_without_denominator} unidade(s) sem denominador positivo não foram classificadas por taxa.",
            f"ℹ️ {units_without_denominator} 个分母不为正的网点未按比率排序。",
        ])

    result: dict[str, object] = {
        "rulesVersion": RULES_VERSION,
        "targetRate": str(TARGET_RATE),
        "metric": {
            "numeratorField": "collected_quantity",
            "denominatorField": "quantity_to_collect",
            "volumeField": "quantity_to_collect",
            "collected": collected,
            "planned": planned,
            "rate": str(national_rate) if national_rate is not None else None,
        },
        "regions": selected_regions,
        "unmappedPlanned": unmapped_planned,
        "unitsWithoutDenominator": units_without_denominator,
        "ranking": "estimated_target_gap_desc, planned_volume_desc, label_asc, code_asc",
        "estimatedTargetGapIsObservedBacklog": False,
    }
    return "\n".join(lines), result


def _claim_analysis(engine: Engine, publication_id: str) -> tuple[bytes, dict[str, object]] | None:
    binary_publication_id = uuid.UUID(publication_id).bytes
    with engine.begin() as connection:
        publication = connection.execute(text("""
            SELECT publication_id, version_no, contract_version, map_version_id, publication_state
            FROM source_publications
            WHERE source_id=:source_id AND publication_id=:publication_id
              AND publication_state='PUBLISHED' AND contract_version=:contract_version
        """), {
            "source_id": SOURCE_ID,
            "publication_id": binary_publication_id,
            "contract_version": CONTRACT_VERSION,
        }).mappings().first()
        if publication is None:
            return None
        map_version_id = bytes(publication["map_version_id"] or b"")
        if len(map_version_id) != 16:
            return None
        lock = " FOR UPDATE" if connection.dialect.name == "mysql" else ""
        existing = connection.execute(text("""
            SELECT analysis_id, analysis_state
            FROM collection_rate_operational_analyses
            WHERE publication_id=:publication_id AND rules_version=:rules_version
            LIMIT 1
        """ + lock), {"publication_id": binary_publication_id, "rules_version": RULES_VERSION}).mappings().first()
        if existing is not None:
            if str(existing["analysis_state"]) != "PENDING":
                return None
            analysis_id = bytes(existing["analysis_id"])
            claimed = connection.execute(text("""
                UPDATE collection_rate_operational_analyses
                SET analysis_state='PROCESSING', error_code=NULL
                WHERE analysis_id=:analysis_id AND analysis_state='PENDING'
            """), {"analysis_id": analysis_id})
            if claimed.rowcount != 1:
                return None
        else:
            analysis_id = uuid.uuid4().bytes
            connection.execute(text("""
                INSERT INTO collection_rate_operational_analyses
                  (analysis_id, source_id, publication_id, publication_version, contract_version,
                   map_version_id, analysis_state, rules_version, target_rate)
                VALUES
                  (:analysis_id, :source_id, :publication_id, :publication_version, :contract_version,
                   :map_version_id, 'PROCESSING', :rules_version, :target_rate)
            """), {
                "analysis_id": analysis_id,
                "source_id": SOURCE_ID,
                "publication_id": binary_publication_id,
                "publication_version": int(publication["version_no"]),
                "contract_version": int(publication["contract_version"]),
                "map_version_id": map_version_id,
                "rules_version": RULES_VERSION,
                "target_rate": str(TARGET_RATE),
            })
        return analysis_id, {
            "publication_id": binary_publication_id,
            "publication_version": int(publication["version_no"]),
            "contract_version": int(publication["contract_version"]),
            "map_version_id": map_version_id,
        }


def generate_publication_analysis(engine: Engine, *, publication_id: str) -> None:
    """Best-effort generation for one new V3 publication; failures never affect publication."""
    analysis_id: bytes | None = None
    try:
        claimed = _claim_analysis(engine, publication_id)
        if claimed is None:
            return
        analysis_id, metadata = claimed
        binary_publication_id = metadata["publication_id"]
        map_version_id = metadata["map_version_id"]
        with engine.connect() as connection:
            operational_date_value = connection.execute(text("""
                SELECT MAX(publication_date.data_date)
                FROM source_publication_dates AS publication_date
                JOIN source_publications AS publication
                  ON publication.source_id=publication_date.source_id
                 AND publication.publication_id=publication_date.publication_id
                WHERE publication_date.source_id=:source_id
                  AND publication_date.publication_id=:publication_id
                  AND publication_date.row_count > 0
                  AND publication.contract_version=:contract_version
                  AND publication.publication_state='PUBLISHED'
            """), {
                "source_id": SOURCE_ID,
                "publication_id": binary_publication_id,
                "contract_version": CONTRACT_VERSION,
            }).scalar_one_or_none()
            if operational_date_value is None:
                raise ValueError("collection_rate_operational_date_unavailable")
            operational_date = _as_date(operational_date_value)
            rows = connection.execute(text("""
                SELECT fact.resolved_base_code,
                       entry.base_name,
                       entry.regional_name,
                       entry.rm_responsible,
                       SUM(fact.collected_quantity) AS collected,
                       SUM(fact.quantity_to_collect) AS planned
                FROM fact_collection_rate_v3 AS fact
                LEFT JOIN base_mapping_entries AS entry
                  ON entry.map_version_id=fact.map_version_id
                 AND entry.base_code=fact.resolved_base_code
                 AND fact.mapping_resolution = 'NAME_APPROVED'
                WHERE fact.source_id=:source_id
                  AND fact.publication_id=:publication_id
                  AND fact.map_version_id=:map_version_id
                  AND fact.deadline_at >= :date_start
                  AND fact.deadline_at < :date_end
                GROUP BY fact.resolved_base_code, entry.base_name,
                         entry.regional_name, entry.rm_responsible
            """), {
                "source_id": SOURCE_ID,
                "publication_id": binary_publication_id,
                "map_version_id": map_version_id,
                "date_start": datetime.combine(operational_date, time.min),
                "date_end": datetime.combine(operational_date + timedelta(days=1), time.min),
            }).mappings().all()
        if not rows:
            raise ValueError("collection_rate_operational_date_has_no_fact_rows")

        collected_total = 0
        planned_total = 0
        mapped_bases: list[dict[str, object]] = []
        unmapped_planned = 0
        units_without_denominator = 0
        for row in rows:
            collected = _integer(row["collected"])
            planned = _integer(row["planned"])
            collected_total += collected
            planned_total += planned
            code = str(row["resolved_base_code"] or "").strip()
            region = str(row["regional_name"] or "").strip()
            base_name = str(row["base_name"] or "").strip()
            if not (code and region and base_name):
                unmapped_planned += planned
                continue
            if planned <= 0:
                units_without_denominator += 1
            mapped_bases.append({
                "code": code,
                "name": base_name,
                "region": region,
                "responsible": str(row["rm_responsible"] or "").strip() or None,
                "collected": collected,
                "planned": planned,
            })

        message, result = build_bilingual_analysis(
            operational_date=operational_date,
            publication_version=int(metadata["publication_version"]),
            collected=collected_total,
            planned=planned_total,
            bases=mapped_bases,
            unmapped_planned=unmapped_planned,
            units_without_denominator=units_without_denominator,
        )
        national_rate = _rate(collected_total, planned_total)
        with engine.begin() as connection:
            timestamp = "CURRENT_TIMESTAMP(6)" if connection.dialect.name == "mysql" else "CURRENT_TIMESTAMP"
            connection.execute(text(f"""
                UPDATE collection_rate_operational_analyses
                SET operational_date=:operational_date,
                    national_collected_quantity=:collected,
                    national_quantity_to_collect=:planned,
                    national_rate=:national_rate,
                    results_json=:results_json,
                    message_pt_zh=:message,
                    analysis_state='READY',
                    generated_at={timestamp},
                    error_code=NULL
                WHERE analysis_id=:analysis_id AND analysis_state='PROCESSING'
            """), {
                "operational_date": operational_date,
                "collected": collected_total,
                "planned": planned_total,
                "national_rate": str(national_rate) if national_rate is not None else None,
                "results_json": json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                "message": message,
                "analysis_id": analysis_id,
            })
    except Exception as error:
        logger.exception("Collection-rate operational analysis failed after publication")
        if analysis_id is not None:
            try:
                with engine.begin() as connection:
                    connection.execute(text("""
                        UPDATE collection_rate_operational_analyses
                        SET analysis_state='FAILED', error_code=:error_code
                        WHERE analysis_id=:analysis_id AND analysis_state='PROCESSING'
                    """), {
                        "analysis_id": analysis_id,
                        "error_code": (
                            str(error)[:96]
                            if isinstance(error, ValueError)
                            else type(error).__name__.lower()[:96]
                        ) or "analysis_generation_failed",
                    })
            except Exception:
                logger.exception("Could not record collection-rate analysis failure")


def get_analysis_history(engine: Engine, *, limit: int = 20) -> dict[str, object]:
    with engine.connect() as connection:
        rows = connection.execute(text("""
            SELECT analysis_id, publication_id, publication_version, contract_version,
                   map_version_id, operational_date, analysis_state,
                   national_collected_quantity, national_quantity_to_collect, national_rate,
                   target_rate, results_json, message_pt_zh, error_code, generated_at
            FROM collection_rate_operational_analyses
            ORDER BY publication_version DESC, created_at DESC
            LIMIT :limit
        """), {"limit": max(1, min(limit, 50))}).mappings().all()
    return {"analyses": [{
        "analysisId": str(uuid.UUID(bytes=bytes(row["analysis_id"]))),
        "publicationId": str(uuid.UUID(bytes=bytes(row["publication_id"]))),
        "publicationVersion": int(row["publication_version"]),
        "contractVersion": int(row["contract_version"]),
        "mapVersionId": str(uuid.UUID(bytes=bytes(row["map_version_id"]))),
        "operationalDate": _as_date(row["operational_date"]).isoformat() if row["operational_date"] else None,
        "state": str(row["analysis_state"]),
        "collected": _integer(row["national_collected_quantity"]),
        "planned": _integer(row["national_quantity_to_collect"]),
        "rate": float(row["national_rate"]) if row["national_rate"] is not None else None,
        "targetRate": float(row["target_rate"]),
        "results": json.loads(row["results_json"]) if row["results_json"] else None,
        "message": row["message_pt_zh"],
        "errorCode": row["error_code"],
        "generatedAt": row["generated_at"].isoformat(sep=" ") if isinstance(row["generated_at"], datetime) else str(row["generated_at"]) if row["generated_at"] else None,
    } for row in rows]}
