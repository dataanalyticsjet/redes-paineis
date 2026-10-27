"""Prepare, confirm and deliver a scoped Sem Movimentacao Feishu report.

The pilot is deliberately limited to an effective MATRIX administrator, the
private Feishu recipient already approved by the organization, and the source
publication's pinned DoomsDay version. No publication hook calls this module.
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import re
import uuid
import zipfile
from contextlib import contextmanager
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

import httpx
from sqlalchemy import Connection, Engine, text

from app.core.config import Settings, get_settings
from app.services.data_foundation.contracts import get_contract
from app.services.feishu_publication_notifications import RECIPIENT_EMAIL
from app.services.no_movement_operational_analysis import build_bilingual_analysis

logger = logging.getLogger(__name__)
SOURCE_ID = "no_movement"
CONTRACT_VERSION = 2
RULES_VERSION = "feishu-pilot-v1"
RECIPIENT_KEY = "PHELIPPE_PRIVATE"
RECIPIENT_LABEL = "Feishu privado — usuário de teste autorizado"
TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
FILES_URL = "https://open.feishu.cn/open-apis/im/v1/files"
IMAGES_URL = "https://open.feishu.cn/open-apis/im/v1/images"
MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages"
MAX_FILE_BYTES = 30 * 1024 * 1024
HTTP_TIMEOUT = httpx.Timeout(30.0, connect=5.0)


def _utc_now() -> datetime:
    """Return a naive UTC value for MySQL DATETIME(6) columns."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class NoMovementFeishuReportError(ValueError):
    def __init__(self, code: str, status_code: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


class _FeishuRejected(Exception):
    """The API explicitly rejected the operation; retrying that stage is safe."""


def _uuid_bytes(value: str) -> bytes:
    try:
        return uuid.UUID(value).bytes
    except (ValueError, TypeError, AttributeError):
        raise NoMovementFeishuReportError("no_movement_report_id_invalid", 422) from None


@contextmanager
def _connection(engine: Engine, connection: Connection | None = None):
    if connection is not None:
        yield connection
    else:
        with engine.connect() as opened:
            yield opened


def _current_publication(engine: Engine, publication_id: str, connection: Connection | None = None) -> dict[str, Any]:
    publication_key = _uuid_bytes(publication_id)
    with _connection(engine, connection) as active:
        row = active.execute(text("""
        SELECT p.publication_id, p.version_no, p.contract_version, p.map_version_id,
               p.period_start, p.snapshot_as_of, p.publication_state
        FROM source_snapshot_head AS head
        JOIN source_publications AS p
          ON p.source_id = head.source_id AND p.publication_id = head.publication_id
        WHERE head.source_id = :source_id AND head.publication_id = :publication_id
          AND p.contract_version = :contract_version AND p.publication_state = 'PUBLISHED'
        """), {
            "source_id": SOURCE_ID,
            "publication_id": publication_key,
            "contract_version": CONTRACT_VERSION,
        }).mappings().first()
    if row is None:
        raise NoMovementFeishuReportError("no_movement_publication_not_current", 409)
    publication = dict(row)
    map_version = publication.get("map_version_id")
    if publication.get("period_start") is None or map_version is None or len(bytes(map_version)) != 16:
        raise NoMovementFeishuReportError("no_movement_publication_metadata_invalid", 409)
    return publication


def _region_names(engine: Engine, map_version_id: bytes, connection: Connection | None = None) -> list[str]:
    with _connection(engine, connection) as active:
        rows = active.execute(text("""
            SELECT DISTINCT regional_name
            FROM base_mapping_entries
            WHERE map_version_id = :map_version_id AND regional_name IS NOT NULL
              AND regional_name <> ''
            ORDER BY regional_name
        """), {"map_version_id": map_version_id}).scalars().all()
    return [str(value) for value in rows]


def get_report_options(engine: Engine, *, publication_id: str) -> dict[str, object]:
    publication = _current_publication(engine, publication_id)
    map_id = bytes(publication["map_version_id"])
    return {
        "publicationId": str(uuid.UUID(bytes=bytes(publication["publication_id"]))),
        "publicationVersion": int(publication["version_no"]),
        "contractVersion": int(publication["contract_version"]),
        "mapVersionId": str(uuid.UUID(bytes=map_id)),
        "operationalDate": publication["period_start"].isoformat(),
        "regions": _region_names(engine, map_id),
        "recipients": [{"key": RECIPIENT_KEY, "label": RECIPIENT_LABEL}],
        "sendEnabled": bool(get_settings().feishu_no_movement_pilot_enabled),
    }


def _source_rows(engine: Engine, publication: dict[str, Any], region_code: str | None, connection: Connection | None = None) -> list[dict[str, Any]]:
    contract = get_contract(SOURCE_ID, CONTRACT_VERSION)
    columns = [column.key for column in contract.columns]
    select = ", ".join(f"fact.`{key}` AS `{key}`" for key in columns)
    region_clause = ""
    params: dict[str, object] = {
        "source_id": SOURCE_ID,
        "publication_id": bytes(publication["publication_id"]),
        "map_version_id": bytes(publication["map_version_id"]),
    }
    if region_code:
        params["region_code"] = region_code
        region_clause = (
            " AND BINARY entry.regional_name = BINARY :region_code"
            if engine.dialect.name == "mysql"
            else " AND entry.regional_name COLLATE BINARY = :region_code"
        )
    query = text(f"""
        SELECT {select}, fact.source_row_no, fact.resolved_base_code,
               entry.regional_name AS mapped_region, entry.base_name AS mapped_base_name,
               entry.rm_responsible AS mapped_rm
        FROM fact_no_movement_snapshot AS fact
        LEFT JOIN base_mapping_entries AS entry
          ON entry.map_version_id = fact.map_version_id
         AND entry.base_code = fact.resolved_base_code
        WHERE fact.source_id = :source_id
          AND fact.publication_id = :publication_id
          AND fact.map_version_id = :map_version_id
          {region_clause}
        ORDER BY fact.source_row_no
    """)
    with _connection(engine, connection) as active:
        return [dict(row) for row in active.execute(query, params).mappings().all()]


def _stable_value(value: object) -> object:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, bytes):
        return value.hex()
    return value


def _dataset_digest(rows: list[dict[str, Any]], columns: list[str], map_version_id: bytes) -> bytes:
    payload = {
        "mapVersionId": map_version_id.hex(),
        "rows": [[_stable_value(row.get(key)) for key in columns] for row in rows],
    }
    canonical = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=False).encode("utf-8")
    return hashlib.sha256(canonical).digest()


def _analysis(publication: dict[str, Any], rows: list[dict[str, Any]], region_code: str | None) -> tuple[str, int]:
    groups_by_key: dict[tuple[object, ...], dict[str, object]] = {}
    total = 0
    for row in rows:
        amount = int(row.get("stopped_orders") or 0)
        total += amount
        mapped = row.get("resolved_base_code") is not None and row.get("mapped_region") is not None
        region = str(row.get("mapped_region")) if mapped else "Sem mapeamento"
        base = str(row.get("mapped_base_name") or "") if mapped else f"{row.get('source_base_name') or 'Unidade sem identificação'} ({row.get('source_base_code') or 'sem código'})"
        owner = str(row.get("mapped_rm") or "") if mapped else ""
        resolved_code = row.get("resolved_base_code")
        reported_region = str(row.get("reported_region") or "")
        source_code = str(row.get("source_base_code") or "")
        source_name = str(row.get("source_base_name") or "")
        key = (region, base, owner, str(resolved_code or ""), reported_region, source_code, source_name, bool(mapped))
        group = groups_by_key.setdefault(key, {
            "mapped": bool(mapped), "region": region, "base_name": base,
            "rm_responsible": owner, "resolved_base_code": resolved_code,
            "reported_region": reported_region, "source_base_code": source_code,
            "source_base_name": source_name, "total": 0,
        })
        group["total"] = int(group["total"]) + amount
    message = build_bilingual_analysis(
        operational_date=publication["period_start"],
        export_time=publication["snapshot_as_of"],
        publication_version=int(publication["version_no"]),
        total=total,
        groups=list(groups_by_key.values()),
        region_limit=5 if region_code is None else 1,
        base_limit=5,
        region_scope=region_code,
    )
    return message, total


def _make_xlsx(rows: list[dict[str, Any]], *, region_code: str | None, operational_date: date) -> tuple[str, bytes]:
    from openpyxl import Workbook

    contract = get_contract(SOURCE_ID, CONTRACT_VERSION)
    workbook = Workbook(write_only=True)
    sheet = workbook.create_sheet("Dados")
    sheet.append([column.header for column in contract.columns])
    for row in rows:
        sheet.append([row.get(column.key) for column in contract.columns])
    workbook.properties.title = "Sem Movimentacao — relatorio oficial"
    workbook.properties.subject = f"Publicacao Data Foundation; regional={region_code or 'ALL'}"
    stable_created_at = datetime.combine(operational_date, datetime.min.time())
    workbook.properties.created = stable_created_at
    workbook.properties.modified = stable_created_at
    output = io.BytesIO()
    workbook.save(output)
    raw = output.getvalue()
    canonical = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw), "r") as source_zip, zipfile.ZipFile(canonical, "w", zipfile.ZIP_DEFLATED) as target_zip:
        for item in source_zip.infolist():
            stable_item = zipfile.ZipInfo(item.filename, date_time=(1980, 1, 1, 0, 0, 0))
            stable_item.compress_type = item.compress_type
            stable_item.external_attr = item.external_attr
            target_zip.writestr(stable_item, source_zip.read(item.filename), compress_type=item.compress_type)
    content = canonical.getvalue()
    if not content or len(content) > MAX_FILE_BYTES or not zipfile.is_zipfile(io.BytesIO(content)):
        raise NoMovementFeishuReportError("no_movement_report_xlsx_size_invalid", 413)
    with zipfile.ZipFile(io.BytesIO(content), "r") as archive:
        if archive.testzip() is not None:
            raise NoMovementFeishuReportError("no_movement_report_xlsx_size_invalid", 413)
    region_name = re.sub(r"[^A-Za-z0-9_-]+", "_", region_code or "nacional").strip("_") or "regional"
    return f"sem_movimentacao_{region_name}_{operational_date.isoformat()}.xlsx", content


def _font(size: int):
    from PIL import ImageFont

    candidates = [
        "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            pass
    return ImageFont.load_default()


def _make_png(rows: list[dict[str, Any]], *, region_code: str | None, publication: dict[str, Any], total: int) -> bytes:
    from PIL import Image, ImageDraw

    width = 1800
    title_font, body_font, small_font = _font(30), _font(17), _font(13)
    image = Image.new("RGB", (width, 650), "#f4f6f9")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((24, 20, width - 24, 626), radius=18, fill="white", outline="#e5e8ef", width=2)
    label = region_code or "Todas as regionais"
    draw.text((54, 42), "J&T EXPRESS  |  SEM MOVIMENTAÇÃO", fill="#e60012", font=small_font)
    draw.text((54, 70), "Resumo operacional", fill="#17191f", font=title_font)
    draw.text((54, 116), f"Data operacional: {publication['period_start']}   |   Regional: {label}   |   Publicação: v{publication['version_no']}", fill="#4d5360", font=body_font)
    draw.rounded_rectangle((54, 158, 540, 238), radius=12, fill="#fff2f3")
    draw.text((76, 174), "PEDIDOS SEM MOVIMENTAÇÃO", fill="#7a7f88", font=small_font)
    draw.text((76, 195), f"{total:,}".replace(",", "."), fill="#d71920", font=title_font)
    unmapped_total = sum(int(row.get("stopped_orders") or 0) for row in rows if not row.get("mapped_region") or not row.get("resolved_base_code"))
    if region_code is None and unmapped_total:
        draw.text((620, 190), f"Sem mapeamento DoomsDay: {unmapped_total:,}".replace(",", "."), fill="#7a4c00", font=body_font)
    candidate_totals: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    metric_keys = ("stopped_orders", "stopped_over_7_days", "stopped_over_14_days", "stopped_over_30_days")
    for row in rows:
        if not row.get("mapped_region") or not row.get("resolved_base_code"):
            continue
        key = (str(row["resolved_base_code"]), str(row["mapped_region"]), str(row.get("mapped_base_name") or ""), str(row.get("mapped_rm") or ""))
        bucket = candidate_totals.setdefault(key, {"mapped_base_name": key[2], "mapped_rm": key[3], **{metric: 0 for metric in metric_keys}})
        for metric in metric_keys:
            bucket[metric] += int(row.get(metric) or 0)
    candidates = list(candidate_totals.values())
    candidates.sort(key=lambda row: (-int(row.get("stopped_orders") or 0), str(row.get("mapped_base_name") or "")))
    keys = ["mapped_base_name", "stopped_orders", "stopped_over_7_days", "stopped_over_14_days", "stopped_over_30_days", "mapped_rm"]
    headers = ["Base DoomsDay", "Sem movimentação", ">7 dias", ">14 dias", ">30 dias", "Responsável RM"]
    x_positions = [54, 630, 865, 1085, 1295, 1510]
    widths = [576, 235, 220, 210, 215, 240]
    top = 270
    draw.rectangle((54, top, width - 54, top + 35), fill="#e60012")
    for index, header in enumerate(headers):
        draw.text((x_positions[index] + 7, top + 9), header, fill="white", font=small_font)
    shown = candidates[:12]
    for row_index, row in enumerate(shown):
        y = top + 35 + row_index * 25
        draw.rectangle((54, y, width - 54, y + 25), fill="#ffffff" if row_index % 2 == 0 else "#f6f7f9", outline="#e7e9ee")
        for col_index, key in enumerate(keys):
            value = row.get(key)
            text_value = "—" if value is None else str(value)
            if key in {"stopped_orders", "stopped_over_7_days", "stopped_over_14_days", "stopped_over_30_days"}:
                text_value = f"{int(value or 0):,}".replace(",", ".")
            draw.text((x_positions[col_index] + 7, y + 5), text_value[:52], fill="#282c34", font=small_font)
    if not shown:
        draw.text((64, top + 52), "Nenhuma base mapeada com volume nesta publicação.", fill="#656b75", font=body_font)
    draw.text((54, 590), "Prévia dos dados; o Excel anexado contém todas as linhas e colunas oficiais deste recorte.", fill="#777d87", font=small_font)
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    content = output.getvalue()
    if not content or len(content) > MAX_FILE_BYTES:
        raise NoMovementFeishuReportError("no_movement_report_png_size_invalid", 413)
    return content


def _report_payload(engine: Engine, *, publication_id: str, region_code: str | None, connection: Connection | None = None) -> dict[str, Any]:
    publication = _current_publication(engine, publication_id, connection)
    map_id = bytes(publication["map_version_id"])
    regions = _region_names(engine, map_id, connection)
    if region_code is not None and region_code not in regions:
        raise NoMovementFeishuReportError("no_movement_report_region_invalid", 422)
    rows = _source_rows(engine, publication, region_code, connection)
    if not rows:
        raise NoMovementFeishuReportError("no_movement_report_no_records", 404)
    contract = get_contract(SOURCE_ID, CONTRACT_VERSION)
    columns = [column.key for column in contract.columns]
    digest = _dataset_digest(rows, columns, map_id)
    message, total = _analysis(publication, rows, region_code)
    operational_date = publication["period_start"]
    file_name, xlsx = _make_xlsx(rows, region_code=region_code, operational_date=operational_date)
    png = _make_png(rows, region_code=region_code, publication=publication, total=total)
    return {
        "publication": publication, "regionCode": region_code, "rows": rows,
        "message": message, "recordCount": len(rows), "total": total,
        "datasetDigest": digest, "fileName": file_name, "xlsx": xlsx, "png": png,
        "regions": regions,
    }


def _recipient_key(value: str) -> None:
    if value != RECIPIENT_KEY:
        raise NoMovementFeishuReportError("no_movement_report_recipient_invalid", 403)


def prepare_report(
    engine: Engine,
    *,
    publication_id: str,
    region_code: str | None,
    recipient_key: str,
    actor_user_id: int,
) -> dict[str, object]:
    _recipient_key(recipient_key)
    payload = _report_payload(engine, publication_id=publication_id, region_code=region_code)
    report_id = uuid.uuid4()
    now = _utc_now()
    context = {"xlsxSha256": hashlib.sha256(payload["xlsx"]).hexdigest(), "pngSha256": hashlib.sha256(payload["png"]).hexdigest()}
    with engine.begin() as connection:
        connection.execute(text("""
            UPDATE no_movement_feishu_reports
            SET report_state='SUPERSEDED', updated_at=:updated_at
            WHERE actor_user_id=:actor_user_id AND publication_id=:publication_id
              AND recipient_key=:recipient_key
              AND report_state IN ('PREPARED','CONFIRMED')
        """), {
            "actor_user_id": actor_user_id,
            "publication_id": bytes(payload["publication"]["publication_id"]),
            "recipient_key": recipient_key,
            "updated_at": now,
        })
        delivery_in_progress = connection.execute(text("""
            SELECT report_id FROM no_movement_feishu_reports
            WHERE publication_id=:publication_id AND region_key=:region_key
              AND recipient_key=:recipient_key AND rules_version=:rules_version
              AND report_state IN ('SENDING','PARTIAL','PENDING','SENT')
            LIMIT 1
        """), {
            "publication_id": bytes(payload["publication"]["publication_id"]),
            "region_key": region_code or "ALL",
            "recipient_key": recipient_key,
            "rules_version": RULES_VERSION,
        }).first()
        if delivery_in_progress:
            raise NoMovementFeishuReportError("no_movement_report_delivery_unresolved", 409)
        connection.execute(text("""
            INSERT INTO no_movement_feishu_reports
              (report_id, source_id, publication_id, publication_version, contract_version,
               map_version_id, region_key, recipient_key, recipient_email, actor_user_id,
               analysis_text, interpretation, comments, recommendations, record_count,
               total_stopped_orders, dataset_sha256, rules_version, report_state,
               delivery_context, created_at, updated_at)
            VALUES (:report_id, :source_id, :publication_id, :publication_version, :contract_version,
                    :map_version_id, :region_key, :recipient_key, :recipient_email, :actor_user_id,
                    :analysis_text, '', '', '', :record_count, :total, :dataset_sha256, :rules_version,
                    'PREPARED', :delivery_context, :created_at, :updated_at)
        """), {
            "report_id": report_id.bytes, "source_id": SOURCE_ID,
            "publication_id": bytes(payload["publication"]["publication_id"]),
            "publication_version": int(payload["publication"]["version_no"]),
            "contract_version": CONTRACT_VERSION, "map_version_id": bytes(payload["publication"]["map_version_id"]),
            "region_key": region_code or "ALL", "recipient_key": recipient_key,
            "recipient_email": RECIPIENT_EMAIL, "actor_user_id": actor_user_id,
            "analysis_text": payload["message"], "record_count": payload["recordCount"],
            "total": payload["total"], "dataset_sha256": payload["datasetDigest"],
            "rules_version": RULES_VERSION,
            "delivery_context": json.dumps({"artifacts": context, "stages": {}}, separators=(",", ":")),
            "created_at": now, "updated_at": now,
        })
    pub = payload["publication"]
    return {
        "reportId": str(report_id), "publicationId": str(uuid.UUID(bytes=bytes(pub["publication_id"]))),
        "publicationVersion": int(pub["version_no"]), "mapVersionId": str(uuid.UUID(bytes=bytes(pub["map_version_id"]))),
        "operationalDate": pub["period_start"].isoformat(), "regionCode": region_code,
        "regionLabel": region_code or "Todas as regionais", "recipientKey": RECIPIENT_KEY,
        "recipientLabel": RECIPIENT_LABEL, "analysis": payload["message"],
        "recordCount": payload["recordCount"], "totalStoppedOrders": payload["total"],
        "baseCount": len({str(row["resolved_base_code"]) for row in payload["rows"] if row.get("mapped_region") and row.get("resolved_base_code")}),
        "excelFileName": payload["fileName"], "excelBytes": len(payload["xlsx"]),
        "pngBytes": len(payload["png"]), "state": "PREPARED",
    }


def confirm_report(engine: Engine, *, report_id: str, actor_user_id: int, interpretation: str, comments: str, recommendations: str) -> dict[str, object]:
    report_key = _uuid_bytes(report_id)
    if any(len(value) > 4000 for value in (interpretation, comments, recommendations)):
        raise NoMovementFeishuReportError("no_movement_report_text_too_long", 422)
    now = _utc_now()
    with engine.begin() as connection:
        lock = " FOR UPDATE" if engine.dialect.name == "mysql" else ""
        report = connection.execute(text("""
            SELECT report_id, publication_id, report_state FROM no_movement_feishu_reports
            WHERE report_id=:report_id AND actor_user_id=:actor_user_id
        """ + lock), {"report_id": report_key, "actor_user_id": actor_user_id}).mappings().first()
        if report is None:
            raise NoMovementFeishuReportError("no_movement_report_not_found", 404)
        if report["report_state"] not in {"PREPARED", "CONFIRMED"}:
            raise NoMovementFeishuReportError("no_movement_report_confirmation_invalid", 409)
        _current_publication(engine, str(uuid.UUID(bytes=bytes(report["publication_id"]))), connection)
        connection.execute(text("""
            UPDATE no_movement_feishu_reports
            SET report_state='CONFIRMED', interpretation=:interpretation, comments=:comments, recommendations=:recommendations,
                confirmed_at=:confirmed_at, updated_at=:updated_at
            WHERE report_id=:report_id AND actor_user_id=:actor_user_id
        """), {
            "interpretation": interpretation, "comments": comments, "recommendations": recommendations,
            "report_id": report_key, "actor_user_id": actor_user_id,
            "confirmed_at": now, "updated_at": now,
        })
    return {"reportId": report_id, "state": "CONFIRMED", "messageSent": False}


def _save_delivery_context(engine: Engine, report_id: bytes, state: str, context: dict[str, object]) -> None:
    now = _utc_now()
    with engine.begin() as connection:
        connection.execute(text("""
            UPDATE no_movement_feishu_reports
            SET report_state=:state, delivery_context=:context, updated_at=:updated_at,
                sent_at=CASE WHEN :state='SENT' THEN :sent_at ELSE sent_at END
            WHERE report_id=:report_id
        """), {"state": state, "context": json.dumps(context, separators=(",", ":")), "report_id": report_id, "updated_at": now, "sent_at": now})


def _feishu_payload(response: httpx.Response) -> dict[str, Any]:
    if response.status_code >= 400:
        if response.status_code >= 500:
            raise RuntimeError("feishu_http_outcome_uncertain")
        raise _FeishuRejected("feishu_request_rejected")
    payload = response.json()
    if not isinstance(payload, dict) or payload.get("code") != 0:
        raise _FeishuRejected("feishu_api_rejected_request")
    return payload


def send_report(engine: Engine, *, report_id: str, actor_user_id: int, settings: Settings | None = None) -> dict[str, object]:
    config = settings or get_settings()
    if not config.feishu_no_movement_pilot_enabled:
        raise NoMovementFeishuReportError("no_movement_feishu_pilot_disabled", 503)
    if not config.feishu_oauth_app_id or not config.feishu_oauth_app_secret:
        raise NoMovementFeishuReportError("feishu_application_not_configured", 503)
    report_key = _uuid_bytes(report_id)
    now = _utc_now()
    with engine.begin() as connection:
        lock = " FOR UPDATE" if engine.dialect.name == "mysql" else ""
        row = connection.execute(text("""
            SELECT * FROM no_movement_feishu_reports
            WHERE report_id=:report_id AND actor_user_id=:actor_user_id
        """ + lock), {"report_id": report_key, "actor_user_id": actor_user_id}).mappings().first()
        if row is None:
            raise NoMovementFeishuReportError("no_movement_report_not_found", 404)
        if row["report_state"] not in {"CONFIRMED", "PARTIAL"}:
            raise NoMovementFeishuReportError("no_movement_report_not_confirmed", 409)
        publication_id = str(uuid.UUID(bytes=bytes(row["publication_id"])))
        if engine.dialect.name == "mysql":
            # Serialize delivery attempts for the same active snapshot so two
            # confirmed report rows cannot both send to the fixed recipient.
            connection.execute(text("""
                SELECT publication_id FROM source_snapshot_head
                WHERE source_id=:source_id AND publication_id=:publication_id
                FOR UPDATE
            """), {"source_id": SOURCE_ID, "publication_id": bytes(row["publication_id"])}).first()
        publication = connection.execute(text("""
            SELECT p.publication_id, p.version_no, p.contract_version, p.map_version_id,
                   p.period_start, p.snapshot_as_of, p.publication_state
            FROM source_snapshot_head AS head
            JOIN source_publications AS p
              ON p.source_id=head.source_id AND p.publication_id=head.publication_id
            WHERE head.source_id=:source_id AND head.publication_id=:publication_id
              AND p.contract_version=:contract_version AND p.publication_state='PUBLISHED'
        """), {
            "source_id": SOURCE_ID,
            "publication_id": bytes(row["publication_id"]),
            "contract_version": CONTRACT_VERSION,
        }).mappings().first()
        if publication is None:
            raise NoMovementFeishuReportError("no_movement_publication_not_current", 409)
        duplicate = connection.execute(text("""
            SELECT report_id FROM no_movement_feishu_reports
            WHERE publication_id=:publication_id AND region_key=:region_key
              AND recipient_key=:recipient_key AND rules_version=:rules_version
              AND report_id<>:report_id AND report_state IN ('SENDING','PARTIAL','PENDING','SENT')
            LIMIT 1
        """ + lock), {
            "publication_id": bytes(row["publication_id"]),
            "region_key": row["region_key"], "recipient_key": row["recipient_key"], "rules_version": RULES_VERSION,
            "report_id": report_key,
        }).first()
        if duplicate:
            raise NoMovementFeishuReportError("no_movement_report_already_sent", 409)
        if bytes(publication["map_version_id"]) != bytes(row["map_version_id"]):
            raise NoMovementFeishuReportError("no_movement_report_mapping_changed", 409)
        region_code = None if row["region_key"] == "ALL" else str(row["region_key"])
        payload = _report_payload(engine, publication_id=publication_id, region_code=region_code, connection=connection)
        if bytes(payload["datasetDigest"]) != bytes(row["dataset_sha256"]):
            raise NoMovementFeishuReportError("no_movement_report_data_changed", 409)
        raw_context = row["delivery_context"]
        context = raw_context if isinstance(raw_context, dict) else json.loads(raw_context or "{}")
        stages = context.setdefault("stages", {})
        artifact_hashes = context.get("artifacts", {})
        if (
            artifact_hashes.get("xlsxSha256") != hashlib.sha256(payload["xlsx"]).hexdigest()
            or artifact_hashes.get("pngSha256") != hashlib.sha256(payload["png"]).hexdigest()
        ):
            raise NoMovementFeishuReportError("no_movement_report_artifacts_changed", 409)
        connection.execute(text("""
            UPDATE no_movement_feishu_reports SET report_state='SENDING', updated_at=:updated_at
            WHERE report_id=:report_id AND actor_user_id=:actor_user_id
        """), {"report_id": report_key, "actor_user_id": actor_user_id, "updated_at": now})

    message = str(row["analysis_text"])
    interpretation = str(row["interpretation"] or "").strip()
    comments = str(row["comments"] or "").strip()
    recommendations = str(row["recommendations"] or "").strip()
    if interpretation:
        message += "\n\n📝 Interpretação | 解读\n" + interpretation
    if comments:
        message += "\n\n💬 Comentários | 评论\n" + comments
    if recommendations:
        message += "\n\n🎯 Recomendações | 建议\n" + recommendations
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            token_payload = _feishu_payload(client.post(TOKEN_URL, json={"app_id": config.feishu_oauth_app_id, "app_secret": config.feishu_oauth_app_secret}))
            token = token_payload.get("tenant_access_token")
            if not isinstance(token, str) or not token:
                raise RuntimeError("feishu_token_unavailable")
            headers = {"Authorization": f"Bearer {token}"}

            if stages.get("text", {}).get("status") != "SENT":
                response = _feishu_payload(client.post(MESSAGE_URL, params={"receive_id_type": "email"}, headers=headers, json={"receive_id": RECIPIENT_EMAIL, "msg_type": "text", "content": json.dumps({"text": message}, ensure_ascii=False)}))
                stages["text"] = {"status": "SENT", "messageId": response["data"]["message_id"]}
                _save_delivery_context(engine, report_key, "SENDING", context)

            if stages.get("xlsx", {}).get("status") != "SENT":
                xlsx = stages.setdefault("xlsx", {})
                if not xlsx.get("fileKey"):
                    response = _feishu_payload(client.post(FILES_URL, headers=headers, data={"file_type": "stream", "file_name": payload["fileName"]}, files={"file": (payload["fileName"], io.BytesIO(payload["xlsx"]), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}))
                    xlsx["fileKey"] = response["data"]["file_key"]
                    _save_delivery_context(engine, report_key, "SENDING", context)
                response = _feishu_payload(client.post(MESSAGE_URL, params={"receive_id_type": "email"}, headers=headers, json={"receive_id": RECIPIENT_EMAIL, "msg_type": "file", "content": json.dumps({"file_key": xlsx["fileKey"]})}))
                xlsx.update({"status": "SENT", "messageId": response["data"]["message_id"]})
                _save_delivery_context(engine, report_key, "SENDING", context)

            if stages.get("png", {}).get("status") != "SENT":
                png = stages.setdefault("png", {})
                if not png.get("imageKey"):
                    response = _feishu_payload(client.post(IMAGES_URL, headers=headers, data={"image_type": "message"}, files={"image": ("sem_movimentacao_preview.png", io.BytesIO(payload["png"]), "image/png")}))
                    png["imageKey"] = response["data"]["image_key"]
                    _save_delivery_context(engine, report_key, "SENDING", context)
                response = _feishu_payload(client.post(MESSAGE_URL, params={"receive_id_type": "email"}, headers=headers, json={"receive_id": RECIPIENT_EMAIL, "msg_type": "image", "content": json.dumps({"image_key": png["imageKey"]})}))
                png.update({"status": "SENT", "messageId": response["data"]["message_id"]})
                _save_delivery_context(engine, report_key, "SENDING", context)
    except _FeishuRejected as error:
        _save_delivery_context(engine, report_key, "PARTIAL", context)
        logger.warning("No-movement Feishu report stage rejected; safe partial retry available")
        raise NoMovementFeishuReportError("no_movement_feishu_partial_delivery", 502) from error
    except Exception as error:
        _save_delivery_context(engine, report_key, "PENDING", context)
        logger.warning("No-movement Feishu report outcome requires reconciliation (%s)", type(error).__name__)
        raise NoMovementFeishuReportError("no_movement_feishu_delivery_pending", 502) from None

    _save_delivery_context(engine, report_key, "SENT", context)
    return {"reportId": report_id, "state": "SENT", "recipient": RECIPIENT_LABEL, "messageIds": {key: value.get("messageId") for key, value in stages.items()}}
