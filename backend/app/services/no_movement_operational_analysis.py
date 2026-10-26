from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError

logger = logging.getLogger(__name__)
SOURCE_ID = "no_movement"
RULES_VERSION = "v1"
try:
    SAO_PAULO = ZoneInfo("America/Sao_Paulo")
except ZoneInfoNotFoundError:  # Windows Python may not ship the IANA database.
    SAO_PAULO = timezone(timedelta(hours=-3), "America/Sao_Paulo")


def _integer(value: object) -> int:
    return int(value or 0)


def _as_date(value: object) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def _as_datetime(value: object | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value))


def build_bilingual_analysis(
    *,
    operational_date: date,
    export_time: datetime | None,
    publication_version: int,
    total: int,
    groups: list[dict[str, object]],
    generated_at: datetime | None = None,
    region_limit: int = 5,
    base_limit: int = 5,
) -> str:
    now = generated_at or datetime.now(SAO_PAULO)
    if now.tzinfo is None:
        now = now.replace(tzinfo=SAO_PAULO)
    greeting_pt, greeting_zh = ("Bom dia, equipe!", "大家早上好！") if now.hour < 12 else ("Boa tarde, equipe!", "大家下午好！")
    export_time = _as_datetime(export_time)
    export_label = f"{export_time.strftime('%d/%m/%Y %H:%M')} (America/Sao_Paulo)" if export_time else "Horário não confirmado"
    operational_date = _as_date(operational_date)
    regions: dict[str, dict[str, object]] = {}
    unmapped: list[dict[str, object]] = []
    for group in groups:
        amount = _integer(group.get("total"))
        if amount <= 0:
            continue
        if not group.get("mapped"):
            unmapped.append(group)
            continue
        region = str(group.get("region") or "Sem regional identificada")
        bucket = regions.setdefault(region, {"total": 0, "bases": []})
        bucket["total"] = _integer(bucket["total"]) + amount
        bases = bucket["bases"]
        assert isinstance(bases, list)
        bases.append({**group, "total": amount})

    lines = [greeting_pt, greeting_zh, "", "📊 **SEM MOVIMENTAÇÃO | 无流转**", "",
             f"📅 Data operacional: {operational_date.strftime('%d/%m/%Y')}",
             f"🕒 Exportação: {export_label}",
             f"📄 Publicação: v{publication_version}",
             f"📦 Volume nacional: {total:,} pacotes".replace(",", "."),
             f"全国无流转订单总量：**{total:,} 单**".replace(",", "."), "",
             "⚠️ **REGIONAIS EM ATENÇÃO | 重点关注区域**"]
    ranked = sorted(regions.items(), key=lambda item: (-_integer(item[1]["total"]), item[0]))
    for region, bucket in ranked[:max(1, region_limit)]:
        lines.extend(["", f"🔴 **{region} — {_integer(bucket['total']):,} pacotes**".replace(",", ".")])
        bases = sorted(bucket["bases"], key=lambda item: (-_integer(item.get("total")), str(item.get("base_name") or "")))
        for base in bases[:max(1, base_limit)]:
            name = str(base.get("base_name") or "Base sem nome oficial")
            owner = str(base.get("rm_responsible") or "Sem responsável identificado")
            lines.append(f"• {name} — **{_integer(base.get('total')):,} pacotes** | Responsável RM: {owner}".replace(",", "."))
    if unmapped:
        lines.extend(["", "⚠️ **REGISTROS SEM MAPEAMENTO DOOMSDAY | 未映射记录**"])
        for row in sorted(unmapped, key=lambda item: (-_integer(item.get("total")), str(item.get("base_name") or "")))[:max(1, base_limit)]:
            label = str(row.get("base_name") or "Unidade sem identificação")
            lines.append(f"• {label} — **{_integer(row.get('total')):,} pacotes**".replace(",", "."))
    lines.extend(["", "🎯 **PRIORIDADE OPERACIONAL | 运营改善重点**",
                  "Acompanhar as unidades com maior volume e priorizar a redução dos pedidos sem movimentação.",
                  "请重点跟进无流转订单量较高的网点，优先处理积压订单。", "",
                  "📌 **ACOMPANHAMENTO | 跟进要求**",
                  "Os responsáveis devem acompanhar as ocorrências das unidades destacadas.",
                  "请相关负责人持续跟进重点网点并推进异常订单处理。"])
    return "\n".join(lines)


def generate_publication_analysis(
    engine: Engine,
    *,
    publication_id: str,
    confirmation_user_id: int | None = None,
    confirmed_at: datetime | None = None,
    region_limit: int = 5,
    base_limit: int = 5,
) -> None:
    """Best-effort, idempotent analysis. It must never affect publication success."""
    try:
        binary_publication_id = uuid.UUID(publication_id).bytes
        analysis_id = uuid.uuid4().bytes
        with engine.begin() as connection:
            publication = connection.execute(text("""
                SELECT publication_id, version_no, contract_version, map_version_id,
                       period_start, snapshot_as_of, publication_state
                FROM source_publications
                WHERE source_id = :source_id AND publication_id = :publication_id
                  AND publication_state = 'PUBLISHED' AND contract_version = 2
            """), {"source_id": SOURCE_ID, "publication_id": binary_publication_id}).mappings().first()
            if publication is None or publication["period_start"] is None:
                return
            lock_clause = " FOR UPDATE" if connection.dialect.name == "mysql" else ""
            existing = connection.execute(text("""
                SELECT analysis_id, analysis_state
                FROM no_movement_operational_analyses
                WHERE publication_id=:publication_id AND rules_version=:rules_version
                LIMIT 1
            """ + lock_clause), {"publication_id": binary_publication_id, "rules_version": RULES_VERSION}).mappings().first()
            if existing is not None:
                if str(existing["analysis_state"]) != "PENDING":
                    return
                analysis_id = bytes(existing["analysis_id"])
                claimed = connection.execute(text("""
                    UPDATE no_movement_operational_analyses
                    SET analysis_state='PROCESSING', error_code=NULL
                    WHERE analysis_id=:analysis_id AND analysis_state='PENDING'
                """), {"analysis_id": analysis_id})
                if claimed.rowcount != 1:
                    return
            else:
                connection.execute(text("""
                    INSERT INTO no_movement_operational_analyses
                      (analysis_id, source_id, publication_id, publication_version, contract_version,
                       map_version_id, operational_date, export_time_local, export_time_zone, export_time_source,
                       confirmation_user_id, confirmed_at, analysis_state, rules_version)
                    VALUES (:analysis_id, :source_id, :publication_id, :publication_version, :contract_version,
                            :map_version_id, :operational_date, :export_time_local, 'America/Sao_Paulo', :export_time_source,
                            :confirmation_user_id, :confirmed_at, 'PROCESSING', :rules_version)
                """), {
                    "analysis_id": analysis_id, "source_id": SOURCE_ID,
                    "publication_id": binary_publication_id,
                    "publication_version": int(publication["version_no"]),
                    "contract_version": int(publication["contract_version"]),
                    "map_version_id": bytes(publication["map_version_id"]),
                    "operational_date": publication["period_start"],
                    "export_time_local": publication["snapshot_as_of"],
                    "export_time_source": "ADMIN_CONFIRMATION" if confirmation_user_id else "BOT_METADATA" if publication["snapshot_as_of"] else "UNKNOWN",
                    "confirmation_user_id": confirmation_user_id,
                    "confirmed_at": datetime.fromisoformat(confirmed_at) if isinstance(confirmed_at, str) and confirmation_user_id else confirmed_at if confirmation_user_id else None,
                    "rules_version": RULES_VERSION,
                })
    except IntegrityError:
        # Only an existing reservation is the expected duplicate case.
        try:
            with engine.connect() as connection:
                existing = connection.execute(text("""
                    SELECT 1 FROM no_movement_operational_analyses
                    WHERE publication_id=:publication_id AND rules_version=:rules_version
                    LIMIT 1
                """), {"publication_id": binary_publication_id, "rules_version": RULES_VERSION}).first()
            if existing is not None:
                return
        except Exception:
            logger.exception("Could not verify duplicate no-movement analysis reservation")
        logger.exception("No-movement analysis reservation violated an unexpected integrity rule")
        return
    except Exception:
        logger.exception("Could not reserve no-movement analysis for publication")
        return

    try:
        with engine.connect() as connection:
            metadata = connection.execute(text("""
                SELECT operational_date, export_time_local, publication_version, map_version_id
                FROM no_movement_operational_analyses WHERE analysis_id = :analysis_id
            """), {"analysis_id": analysis_id}).mappings().one()
            grouped = connection.execute(text("""
                SELECT entry.regional_name AS mapped_region,
                       entry.base_name AS mapped_base_name,
                       entry.rm_responsible AS rm_responsible,
                       fact.resolved_base_code AS resolved_base_code,
                       fact.reported_region AS reported_region,
                       fact.source_base_code AS source_base_code,
                       fact.source_base_name AS source_base_name,
                       SUM(fact.stopped_orders) AS total
                FROM fact_no_movement_snapshot AS fact
                LEFT JOIN base_mapping_entries AS entry
                  ON entry.map_version_id = fact.map_version_id
                 AND entry.base_code = fact.resolved_base_code
                WHERE fact.source_id = :source_id
                  AND fact.publication_id = :publication_id
                  AND fact.map_version_id = :map_version_id
                GROUP BY entry.regional_name, entry.base_name, entry.rm_responsible,
                         fact.resolved_base_code, fact.reported_region,
                         fact.source_base_code, fact.source_base_name
            """), {
                "source_id": SOURCE_ID,
                "publication_id": binary_publication_id,
                "map_version_id": bytes(metadata["map_version_id"]),
            }).mappings().all()
        groups = []
        total = 0
        for row in grouped:
            mapped = row["resolved_base_code"] is not None and row["mapped_region"] is not None
            amount = _integer(row["total"])
            total += amount
            groups.append({
                "mapped": mapped,
                "region": row["mapped_region"] if mapped else "Sem mapeamento",
                "base_name": row["mapped_base_name"] if mapped else f"{row['source_base_name']} ({row['source_base_code']})",
                "rm_responsible": row["rm_responsible"] if mapped else None,
                "total": amount,
            })
        message = build_bilingual_analysis(
            operational_date=metadata["operational_date"],
            export_time=metadata["export_time_local"],
            publication_version=int(metadata["publication_version"]),
            total=total,
            groups=groups,
            region_limit=region_limit,
            base_limit=base_limit,
        )
        with engine.begin() as connection:
            current_timestamp = "CURRENT_TIMESTAMP(6)" if connection.dialect.name == "mysql" else "CURRENT_TIMESTAMP"
            connection.execute(text(f"""
                UPDATE no_movement_operational_analyses
                SET analysis_state='READY', total_stopped_orders=:total,
                    message_pt_zh=:message, generated_at={current_timestamp}, error_code=NULL
                WHERE analysis_id=:analysis_id AND analysis_state='PROCESSING'
            """), {"total": total, "message": message, "analysis_id": analysis_id})
    except Exception:
        logger.exception("No-movement analysis failed after publication")
        try:
            with engine.begin() as connection:
                connection.execute(text("""
                    UPDATE no_movement_operational_analyses
                    SET analysis_state='FAILED', error_code='analysis_generation_failed'
                    WHERE analysis_id=:analysis_id AND analysis_state='PROCESSING'
                """), {"analysis_id": analysis_id})
        except Exception:
            logger.exception("Could not record no-movement analysis failure")


def get_analysis_history(engine: Engine, *, limit: int = 20) -> dict[str, object]:
    with engine.connect() as connection:
        rows = connection.execute(text("""
            SELECT analysis_id, publication_id, publication_version, contract_version,
                   map_version_id, operational_date, export_time_local, export_time_zone, export_time_source,
                   analysis_state, total_stopped_orders, message_pt_zh, error_code, generated_at
            FROM no_movement_operational_analyses
            ORDER BY operational_date DESC, export_time_local DESC, publication_version DESC, created_at DESC
            LIMIT :limit
        """), {"limit": max(1, min(limit, 50))}).mappings().all()
    return {"analyses": [{
        "analysisId": str(uuid.UUID(bytes=bytes(row["analysis_id"]))),
        "publicationId": str(uuid.UUID(bytes=bytes(row["publication_id"]))),
        "publicationVersion": int(row["publication_version"]),
        "contractVersion": int(row["contract_version"]),
        "mapVersionId": str(uuid.UUID(bytes=bytes(row["map_version_id"]))),
            "operationalDate": _as_date(row["operational_date"]).isoformat(),
            "exportTimeLocal": _as_datetime(row["export_time_local"]).isoformat(sep=" ") if row["export_time_local"] else None,
        "exportTimeZone": str(row["export_time_zone"]),
        "exportTimeSource": str(row["export_time_source"]),
        "state": str(row["analysis_state"]),
        "total": _integer(row["total_stopped_orders"]),
        "message": row["message_pt_zh"],
        "errorCode": row["error_code"],
            "generatedAt": _as_datetime(row["generated_at"]).isoformat(sep=" ") if row["generated_at"] else None,
    } for row in rows]}
