from __future__ import annotations

import json
import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import Engine, text

logger = logging.getLogger(__name__)
SOURCE_ID = "pdd_collection_failure"
CONTRACT_VERSION = 2
RULES_VERSION = "v1"
BASE_LIMIT = 8
try:
    SAO_PAULO = ZoneInfo("America/Sao_Paulo")
except ZoneInfoNotFoundError:
    SAO_PAULO = timezone(timedelta(hours=-3), "America/Sao_Paulo")


def _integer(value: object) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def _as_date(value: object) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def _rate(numerator: int, denominator: int) -> Decimal | None:
    return Decimal(numerator) / Decimal(denominator) if denominator > 0 else None


def _percent(value: Decimal | None) -> str:
    if value is None:
        return "—"
    rounded = (value * 100).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    return f"{rounded:.1f}%".replace(".", ",")


def _volume(value: int) -> str:
    return f"{value:,}".replace(",", ".")


def _rank_key(item: dict[str, object]) -> tuple[int, Decimal, int, str, str]:
    rate = _rate(_integer(item.get("unscanned")), _integer(item.get("total")))
    return (
        -_integer(item.get("unscanned")), -(rate or Decimal(0)), -_integer(item.get("total")),
        str(item.get("name") or "").casefold(), str(item.get("code") or ""),
    )


def build_bilingual_analysis(
    *,
    operational_date: date,
    publication_version: int,
    total_orders: int,
    orders_unscanned: int,
    bases: list[dict[str, object]],
    unmapped_total: int = 0,
    unmapped_unscanned: int = 0,
    generated_at: datetime | None = None,
    base_limit: int = BASE_LIMIT,
) -> tuple[str, dict[str, object]]:
    now = generated_at or datetime.now(SAO_PAULO)
    if now.tzinfo is None:
        now = now.replace(tzinfo=SAO_PAULO)
    greeting = ("Bom dia, pessoal!", "大家早上好！") if now.hour < 12 else ("Boa tarde, pessoal!", "大家下午好！")
    candidates = [dict(item) for item in bases if _integer(item.get("unscanned")) > 0]
    candidates.sort(key=_rank_key)
    selected = candidates[:max(1, min(int(base_limit), 50))]
    national_rate = _rate(orders_unscanned, total_orders)
    lines = [
        greeting[0], greeting[1], "",
        f"📊 **FALHA NA COLETA PDD — {_as_date(operational_date).strftime('%d/%m/%Y')} | 揽收漏扫描**",
        "", f"Total de pedidos: **{_volume(total_orders)}**", f"订单总量：**{_volume(total_orders)}**",
        "", f"Pedidos não bipados: **{_volume(orders_unscanned)} ({_percent(national_rate)})**",
        f"未扫描订单：**{_volume(orders_unscanned)}（{_percent(national_rate)}）**",
        "", "⚠️ **Bases prioritárias | 重点关注网点**",
    ]
    if selected:
        for item in selected:
            name = str(item.get("name") or item.get("code") or "Base sem nome oficial")
            owner = str(item.get("owner") or "").strip() or "Sem RM"
            lines.extend(["", f"🔴 **{name} — {_percent(_rate(_integer(item.get('unscanned')), _integer(item.get('total'))))}** | {owner}"])
    else:
        lines.extend(["", "✅ Nenhuma base apresentou pedidos não bipados na data operacional.", "✅ 本运营日期没有网点出现未扫描订单。"])
    lines.extend([
        "", "⚠️ **Prioridade operacional: reduzir as falhas de digitalização nas bases com maior impacto.**",
        "⚠️ **运营重点：优先改善漏扫描问题较严重的网点，降低异常订单量。**", "",
        "Contamos com a atuação dos responsáveis para reduzir as falhas.",
        "请各负责人重点跟进，持续降低漏扫描订单量。",
    ])
    if unmapped_total or unmapped_unscanned:
        lines.extend([
            "", f"ℹ️ Registros sem vínculo DoomsDay mantidos no consolidado nacional: {_volume(unmapped_total)} pedidos, {_volume(unmapped_unscanned)} não bipados.",
            f"ℹ️ 未关联 DoomsDay 的记录仍计入全国汇总：订单 {_volume(unmapped_total)} 单，未扫描 {_volume(unmapped_unscanned)} 单。",
        ])
    results = {
        "rulesVersion": RULES_VERSION,
        "operationalDate": _as_date(operational_date).isoformat(),
        "metric": {
            "totalOrdersField": "total_orders",
            "unscannedField": "orders_unscanned_at_collection",
            "rateFormula": "SUM(orders_unscanned_at_collection) / SUM(total_orders)",
            "totalOrders": total_orders,
            "ordersUnscannedAtCollection": orders_unscanned,
            "failureRate": str(national_rate) if national_rate is not None else None,
        },
        "priorityBases": [{
            "baseCode": str(item.get("code") or ""), "baseName": str(item.get("name") or ""),
            "region": str(item.get("region") or ""), "responsible": str(item.get("owner") or "").strip() or "Sem RM",
            "totalOrders": _integer(item.get("total")), "ordersUnscannedAtCollection": _integer(item.get("unscanned")),
            "failureRate": str(_rate(_integer(item.get("unscanned")), _integer(item.get("total"))))
                if _rate(_integer(item.get("unscanned")), _integer(item.get("total"))) is not None else None,
        } for item in selected],
        "unmapped": {"totalOrders": unmapped_total, "ordersUnscannedAtCollection": unmapped_unscanned},
        "ranking": "unscanned_volume_desc, failure_rate_desc, total_orders_desc, base_name_asc, base_code_asc",
    }
    return "\n".join(lines), results


def _claim_analysis(engine: Engine, publication_id: str) -> tuple[bytes, dict[str, object]] | None:
    binary_id = uuid.UUID(publication_id).bytes
    with engine.begin() as connection:
        publication = connection.execute(text("""
            SELECT publication_id, version_no, contract_version, map_version_id
            FROM source_publications
            WHERE source_id=:source_id AND publication_id=:publication_id
              AND publication_state='PUBLISHED' AND contract_version=:contract_version
        """), {"source_id": SOURCE_ID, "publication_id": binary_id, "contract_version": CONTRACT_VERSION}).mappings().first()
        if publication is None:
            return None
        map_id = bytes(publication["map_version_id"] or b"")
        if len(map_id) != 16:
            return None
        operational_date = connection.execute(text("""
            SELECT MAX(data_date)
            FROM source_publication_dates
            WHERE source_id=:source_id AND publication_id=:publication_id AND row_count > 0
        """), {"source_id": SOURCE_ID, "publication_id": binary_id}).scalar_one_or_none()
        if operational_date is None:
            return None
        lock = " FOR UPDATE" if connection.dialect.name == "mysql" else ""
        existing = connection.execute(text("""
            SELECT analysis_id, analysis_state
            FROM pdd_collection_failure_operational_analyses
            WHERE publication_id=:publication_id AND rules_version=:rules_version LIMIT 1
        """ + lock), {"publication_id": binary_id, "rules_version": RULES_VERSION}).mappings().first()
        if existing:
            if str(existing["analysis_state"]) != "PENDING":
                return None
            analysis_id = bytes(existing["analysis_id"])
            claimed = connection.execute(text("""
                UPDATE pdd_collection_failure_operational_analyses
                SET analysis_state='PROCESSING', error_code=NULL
                WHERE analysis_id=:analysis_id AND analysis_state='PENDING'
            """), {"analysis_id": analysis_id})
            if claimed.rowcount != 1:
                return None
        else:
            analysis_id = uuid.uuid4().bytes
            connection.execute(text("""
                INSERT INTO pdd_collection_failure_operational_analyses
                  (analysis_id, source_id, publication_id, publication_version, contract_version,
                   map_version_id, operational_date, analysis_state, rules_version)
                VALUES (:analysis_id, :source_id, :publication_id, :publication_version,
                        :contract_version, :map_version_id, :operational_date, 'PROCESSING', :rules_version)
            """), {"analysis_id": analysis_id, "source_id": SOURCE_ID, "publication_id": binary_id,
                   "publication_version": int(publication["version_no"]), "contract_version": int(publication["contract_version"]),
                   "map_version_id": map_id, "operational_date": operational_date, "rules_version": RULES_VERSION})
        return analysis_id, {"publication_id": binary_id, "publication_version": int(publication["version_no"]), "map_version_id": map_id}


def generate_publication_analysis(engine: Engine, *, publication_id: str, base_limit: int = BASE_LIMIT) -> None:
    analysis_id: bytes | None = None
    try:
        claimed = _claim_analysis(engine, publication_id)
        if claimed is None:
            return
        analysis_id, metadata = claimed
        with engine.connect() as connection:
            day_value = connection.execute(text("""
                SELECT MAX(pd.data_date)
                FROM source_publication_dates AS pd
                JOIN source_publications AS p ON p.source_id=pd.source_id AND p.publication_id=pd.publication_id
                WHERE pd.source_id=:source_id AND pd.publication_id=:publication_id
                  AND pd.row_count > 0 AND p.contract_version=:contract_version AND p.publication_state='PUBLISHED'
            """), {"source_id": SOURCE_ID, "publication_id": metadata["publication_id"], "contract_version": CONTRACT_VERSION}).scalar_one_or_none()
            if day_value is None:
                raise ValueError("pdd_operational_date_unavailable")
            operational_date = _as_date(day_value)
            rows = connection.execute(text("""
                SELECT entry.base_code AS base_code, entry.base_name AS base_name,
                       entry.regional_name AS region, entry.rm_responsible AS owner,
                       SUM(fact.total_orders) AS total_orders,
                       SUM(fact.orders_unscanned_at_collection) AS orders_unscanned_at_collection
                FROM fact_pdd_collection_failure_v2 AS fact
                LEFT JOIN base_mapping_entries AS entry
                  ON entry.map_version_id=fact.map_version_id AND entry.base_code=fact.resolved_base_code
                WHERE fact.source_id=:source_id AND fact.publication_id=:publication_id
                  AND fact.map_version_id=:map_version_id AND fact.data_date=:operational_date
                GROUP BY entry.base_code, entry.base_name, entry.regional_name, entry.rm_responsible,
                         CASE WHEN entry.base_code IS NULL THEN fact.source_base_code END,
                         CASE WHEN entry.base_code IS NULL THEN fact.source_base_name END
            """), {"source_id": SOURCE_ID, "publication_id": metadata["publication_id"],
                   "map_version_id": metadata["map_version_id"], "operational_date": operational_date}).mappings().all()
        if not rows:
            raise ValueError("pdd_operational_date_has_no_fact_rows")
        total_orders = unscanned = unmapped_total = unmapped_unscanned = 0
        bases = []
        for row in rows:
            total = _integer(row["total_orders"])
            failed = _integer(row["orders_unscanned_at_collection"])
            total_orders += total
            unscanned += failed
            if row["base_code"] is None:
                unmapped_total += total
                unmapped_unscanned += failed
                continue
            bases.append({
                "code": str(row["base_code"]), "name": str(row["base_name"] or row["base_code"]),
                "region": str(row["region"] or ""), "owner": str(row["owner"] or "").strip() or "Sem RM",
                "total": total, "unscanned": failed,
            })
        message, results = build_bilingual_analysis(
            operational_date=operational_date, publication_version=metadata["publication_version"],
            total_orders=total_orders, orders_unscanned=unscanned, bases=bases,
            unmapped_total=unmapped_total, unmapped_unscanned=unmapped_unscanned, base_limit=base_limit,
        )
        rate = _rate(unscanned, total_orders)
        with engine.begin() as connection:
            timestamp = "CURRENT_TIMESTAMP(6)" if connection.dialect.name == "mysql" else "CURRENT_TIMESTAMP"
            connection.execute(text(f"""
                UPDATE pdd_collection_failure_operational_analyses
                SET operational_date=:day, total_orders=:total, orders_unscanned_at_collection=:unscanned,
                    collection_failure_rate=:rate, results_json=:results, message_pt_zh=:message,
                    analysis_state='READY', generated_at={timestamp}, error_code=NULL
                WHERE analysis_id=:analysis_id AND analysis_state='PROCESSING'
            """), {"day": operational_date, "total": total_orders, "unscanned": unscanned,
                   "rate": str(rate) if rate is not None else None,
                   "results": json.dumps(results, ensure_ascii=False, separators=(",", ":")),
                   "message": message, "analysis_id": analysis_id})
    except Exception as error:
        logger.exception("PDD operational analysis failed after publication")
        if analysis_id is not None:
            try:
                with engine.begin() as connection:
                    connection.execute(text("""
                        UPDATE pdd_collection_failure_operational_analyses
                        SET analysis_state='FAILED', error_code=:error_code
                        WHERE analysis_id=:analysis_id AND analysis_state='PROCESSING'
                    """), {"analysis_id": analysis_id, "error_code": (
                        str(error)[:96] if isinstance(error, ValueError) else type(error).__name__.lower()[:96]
                    ) or "analysis_generation_failed"})
            except Exception:
                logger.exception("Could not record PDD analysis failure")


def get_analysis_history(engine: Engine, *, limit: int = 20) -> dict[str, object]:
    bounded_limit = max(1, min(limit, 50))
    with engine.connect() as connection:
        rows = connection.execute(text("""
            SELECT analysis_id, publication_id, publication_version, contract_version, map_version_id,
                   operational_date, analysis_state, total_orders, orders_unscanned_at_collection,
                   collection_failure_rate, results_json, message_pt_zh, error_code, generated_at
            FROM pdd_collection_failure_operational_analyses
            ORDER BY operational_date DESC, publication_version DESC, created_at DESC LIMIT :limit
        """), {"limit": bounded_limit}).mappings().all()
    analyses = []
    for row in rows:
        try:
            results = json.loads(row["results_json"]) if row["results_json"] else None
        except (TypeError, ValueError):
            results = None
        analyses.append({
            "analysisId": str(uuid.UUID(bytes=bytes(row["analysis_id"]))),
            "publicationId": str(uuid.UUID(bytes=bytes(row["publication_id"]))),
            "publicationVersion": int(row["publication_version"]),
            "contractVersion": int(row["contract_version"]),
            "mapVersionId": str(uuid.UUID(bytes=bytes(row["map_version_id"]))),
            "operationalDate": _as_date(row["operational_date"]).isoformat() if row["operational_date"] else None,
            "state": str(row["analysis_state"]), "totalOrders": _integer(row["total_orders"]),
            "ordersUnscannedAtCollection": _integer(row["orders_unscanned_at_collection"]),
            "failureRate": float(row["collection_failure_rate"]) if row["collection_failure_rate"] is not None else None,
            "results": results, "message": row["message_pt_zh"], "errorCode": row["error_code"],
            "generatedAt": row["generated_at"].isoformat(sep=" ") if isinstance(row["generated_at"], datetime)
                else str(row["generated_at"]) if row["generated_at"] else None,
        })
    return {"analyses": analyses, "limit": bounded_limit}
