from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Literal


# Review fingerprint for the one-time migration candidate. Later official map
# releases must be reviewed as a new immutable mapping version.
INITIAL_MAPPING_WORKBOOK_SHA256 = "6d07265a1b9e9a612c86979f3a8a6bbf64b04566623b2293558735b523b1dbba"


ValueKind = Literal["DATE", "DATETIME", "BASE_CODE", "TEXT", "INTEGER", "DECIMAL"]


@dataclass(frozen=True)
class ContractColumn:
    key: str
    header: str
    kind: ValueKind
    nullable: bool = False
    max_length: int | None = None
    numeric_code_allowed: bool = False


@dataclass(frozen=True)
class SourceContract:
    source_id: str
    display_name: str
    workbook_name: str
    sheet_name: str
    header_row: int
    version: int
    history_policy: Literal["DAILY_REPLACE_DATES", "SNAPSHOT_REPLACE_ALL", "PENDING"]
    grain_description: str
    columns: tuple[ContractColumn, ...]
    expected_sample_rows: int
    approval_state: Literal["DISCOVERED"] = "DISCOVERED"

    @property
    def headers(self) -> tuple[str, ...]:
        return tuple(column.header for column in self.columns)


def _c(
    key: str,
    header: str,
    kind: ValueKind,
    *,
    nullable: bool = False,
    max_length: int | None = None,
    numeric_code_allowed: bool = False,
) -> ContractColumn:
    return ContractColumn(key, header, kind, nullable, max_length, numeric_code_allowed)


_COLLECTION_MONITORING = (
    _c("data_date", "Data", "DATE"),
    _c("reported_region", "Regional Origem", "TEXT", nullable=True, max_length=64),
    _c("source_base_name", "PDD de saida", "TEXT", nullable=True, max_length=191),
    _c("seller_collection_rate", "Taxa de coleta do vendedor", "DECIMAL", nullable=True),
    _c("collection_visit_rate", "Taxa de Visita de Coleta", "DECIMAL", nullable=True),
    _c("expected_dropoff_collection", "Coleta Prevista Drop-off", "INTEGER"),
    _c("expected_pickup_collection", "Coleta Prevista Pick-up", "INTEGER"),
    _c("awaiting_collection_dropoff", "Aguardando Coleta Drop-off", "INTEGER"),
    _c("awaiting_collection_pickup", "Aguardando Coleta Pick-up", "INTEGER"),
    _c("collected_current", "Status atual – Coletado", "INTEGER"),
    _c("received_at_base_current", "Status atual – Recebido na base", "INTEGER"),
    _c("dispatched_by_base", "Expedida pela Base", "INTEGER"),
    _c("in_transit_from_base", "Status atual – Em trânsito a partir da base", "INTEGER"),
    _c("branch_outbound_transit_center", "网点发件在途(中心)", "INTEGER"),
    _c("branch_outbound_transit_sorting", "网点发件在途(集散)", "INTEGER"),
    _c("arrived_at_sorting_center", "Chegada ao Centro de Triagem", "INTEGER"),
    _c("dispatched_by_sorting_center", "Expedido pelo Centro de Triagem", "INTEGER"),
    _c("sorting_outbound_transit", "集散发件在途", "INTEGER"),
    _c("arrived_at_sc", "Status atual – Chegou ao SC", "INTEGER"),
    _c("package_created_by_base", "Pacote Criado pela Base", "INTEGER"),
    _c("processed_problem_items", "已处理问题件", "INTEGER"),
    _c("unprocessed_problem_items", "未处理问题件", "INTEGER"),
)

_COLLECTION_RATE = (
    _c("deadline_at", "Horário de término do prazo de coleta", "DATETIME"),
    _c("reported_region", "Nome da regional", "TEXT", nullable=True, max_length=64),
    _c("source_base_name", "Nome da base de coleta", "TEXT", nullable=True, max_length=191),
    _c("order_origin", "Origem do Pedido", "TEXT", max_length=96),
    _c("product_type", "Tipo de produto", "TEXT", max_length=64),
    _c("order_quantity", "Quantidade de pedidos", "INTEGER"),
    _c("quantity_to_collect", "Qtd a coletar", "INTEGER"),
    _c("cancelled_quantity", "Qtd cancelada", "INTEGER"),
    _c("collection_rate", "Taxa de coleta", "DECIMAL"),
    _c("collected_quantity", "揽收量", "INTEGER"),
    _c("not_collected_quantity", "未揽收量", "INTEGER"),
    _c("not_collected_on_time_quantity", "Qtd não coletada no prazo", "INTEGER"),
    _c("collected_on_time_quantity", "Qtd coletada no prazo", "INTEGER"),
    _c("collection_on_time_rate", "Taxa de coleta no prazo", "DECIMAL"),
    _c("collected_plus_attempts_quantity", "Pedidos coletados + Tentativas de coleta", "INTEGER"),
    _c("collection_rate_with_attempts", "Taxa de coleta com tentativas de coleta", "DECIMAL"),
    _c("average_collection_delay_hours", "Prazo médio demorado para coleta(h)", "DECIMAL", nullable=True),
    _c("processed_problem_items", "已做问题件的量", "INTEGER"),
    _c("unprocessed_problem_items", "未做问题件的量", "INTEGER"),
    _c("seller_collection_rate", "Taxa de coleta do vendedor", "DECIMAL"),
    _c("expected_merchant_visits", "应上门商家量", "INTEGER"),
    _c("merchants_not_visited", "未上门商家量", "INTEGER"),
)

_JT_MONITORING = (
    _c("data_date", "Data", "DATE"),
    _c("reported_region", "Regional Origem", "TEXT", nullable=True, max_length=64),
    _c("source_base_name", "PDD de saida", "TEXT", nullable=True, max_length=191),
    _c("customer_name", "Cliente", "TEXT", max_length=191),
    _c("store_name", "Loja", "TEXT", max_length=191),
    _c("seller_id", "Id Seller/remetente", "TEXT", max_length=64),
    _c("assigned_driver", "Motorista Designado", "TEXT", max_length=191),
    _c("order_origin", "Origem do Pedido", "TEXT", max_length=96),
    _c("awaiting_collection", "Status atual – Aguardando coleta", "INTEGER"),
    _c("received_at_dropoff", "Status atual – Recebido no Drop-off", "INTEGER"),
    _c("collected", "Status atual – Coletado", "INTEGER"),
    _c("received", "Status atual – Recebido", "INTEGER"),
    _c("received_at_base", "Status atual – Recebido na base", "INTEGER"),
    _c("in_base_dispatch_flow", "当前状态-网点发件流程中", "INTEGER"),
    _c("arrived_at_sc", "Status atual – Chegou ao SC", "INTEGER"),
)

_NO_MOVEMENT = (
    _c("reported_region", "Regional responsável", "TEXT", max_length=64),
    _c("source_base_code", "Código da unidade responsável", "BASE_CODE", max_length=64, numeric_code_allowed=True),
    _c("source_base_name", "Nome da unidade responsável", "TEXT", max_length=191),
    _c("stopped_orders", "Total de pedidos sem movimentação", "INTEGER"),
    _c("orders_in_transit", "Qtd pedidos em trânsito", "INTEGER"),
    _c("stopped_over_1_day", "Sem mov. há mais de 1 dia", "INTEGER"),
    _c("stopped_over_2_days", "Sem mov. há mais de 2 dias", "INTEGER"),
    _c("stopped_over_3_days", "Sem mov. há mais de 3 dias", "INTEGER"),
    _c("stopped_over_4_days", "Sem mov. há mais de 4 dias", "INTEGER"),
    _c("stopped_over_5_days", "Sem mov. há mais de 5 dias", "INTEGER"),
    _c("stopped_over_6_days", "Sem mov. há mais de 6 dias", "INTEGER"),
    _c("stopped_over_7_days", "Sem mov. há mais de 7 dias", "INTEGER"),
    _c("stopped_over_10_days", "Sem mov. há mais de 10 dias", "INTEGER"),
    _c("stopped_over_14_days", "Sem mov. há mais de 14 dias", "INTEGER"),
    _c("stopped_over_30_days", "Sem mov. há mais de 30 dias", "INTEGER"),
    _c("last_operation_at", "Horário da última operação", "DATETIME"),
    _c("stopped_14_plus_days_rate", "Taxa de sem mov 14+dias", "DECIMAL"),
    _c("stopped_30_plus_days_rate", "Taxa de sem mov 30+dias", "DECIMAL"),
)

_PDD_COLLECTION_FAILURE = (
    _c("data_date", "Data considerada", "DATE"),
    _c("source_base_code", "Código da base", "BASE_CODE", max_length=64, numeric_code_allowed=True),
    _c("source_base_name", "Nome da base", "TEXT", max_length=191),
    _c("source_region_code", "Código da Regional", "BASE_CODE", max_length=64, numeric_code_allowed=True),
    _c("reported_region", "Nome da regional", "TEXT", max_length=64),
    _c("orders_to_scan", "Qtd pedidos a bipar", "INTEGER"),
    _c("orders_unscanned_at_receipt", "Qtd pedidos não bipados no recebimento", "INTEGER"),
    _c("rate_unscanned_at_receipt", "Taxa de pedidos não bipados no recebimento", "DECIMAL"),
    _c("orders_unscanned_for_delivery", "Qtd de pedidos não bipados na saída para entrega", "INTEGER"),
    _c("rate_unscanned_for_delivery", "Taxa de pedidos não bipados na saída para entrega", "DECIMAL"),
    _c("overall_unscanned_rate", "Taxa geral de falta de bipagem", "DECIMAL"),
)

_BASE_MAPPING = (
    _c("regional_name", "Regional", "TEXT", nullable=True, max_length=64),
    _c("uf_code", "UF", "TEXT", nullable=True, max_length=8),
    _c("rm_region", "Região RM", "TEXT", nullable=True, max_length=96),
    _c("rm_responsible", "Responsável Rm", "TEXT", nullable=True, max_length=160),
    _c("base_code", "Código da base", "BASE_CODE", max_length=64, numeric_code_allowed=True),
    _c("base_name", "Nome da base", "TEXT", max_length=191),
    _c("base_description", "Descrição", "TEXT", nullable=True, max_length=500),
)


CONTRACTS: dict[str, SourceContract] = {
    "collection_monitoring": SourceContract(
        source_id="collection_monitoring",
        display_name="Monitoramento de Coleta",
        workbook_name="揽收监控Resumo17474620261006101134.xlsx - Monitoramento de Coleta .xlsx",
        sheet_name="sheet0",
        header_row=1,
        version=1,
        history_policy="DAILY_REPLACE_DATES",
        grain_description="Uma linha por linha física do arquivo; cada data presente substitui sua partição integral.",
        columns=_COLLECTION_MONITORING,
        expected_sample_rows=3877,
    ),
    "collection_rate": SourceContract(
        source_id="collection_rate",
        display_name="Taxa de Coleta",
        workbook_name="Taxa de coleta no prazo(Taxa de coleta oportuna - resumo)17474620261006101324.xlsx - Taxa de Coleta .xlsx",
        sheet_name="sheet0",
        header_row=1,
        version=1,
        history_policy="DAILY_REPLACE_DATES",
        grain_description="Uma linha por linha física; deadline_at determina a data diária substituída.",
        columns=_COLLECTION_RATE,
        expected_sample_rows=3269,
    ),
    "jt_monitoring": SourceContract(
        source_id="jt_monitoring",
        display_name="Monitoramento J&T",
        workbook_name="揽收监控Resumo17474620261006101208.xlsx - Monitoramento J&T .xlsx",
        sheet_name="sheet1",
        header_row=1,
        version=1,
        history_policy="DAILY_REPLACE_DATES",
        grain_description="Uma linha por linha física; duplicatas da origem são preservadas.",
        columns=_JT_MONITORING,
        expected_sample_rows=159666,
    ),
    "no_movement": SourceContract(
        source_id="no_movement",
        display_name="Sem Movimentação",
        workbook_name="Monitoramento de movimentação em tempo real (novo)(Resumo)17474620261006102038.xlsx - Sem Movimentac\u0327a\u0303o.xlsx",
        sheet_name="sheet0",
        header_row=1,
        version=1,
        history_policy="SNAPSHOT_REPLACE_ALL",
        grain_description="Snapshot integral; os códigos da base devem ser únicos. O arquivo não informa a data do snapshot.",
        columns=_NO_MOVEMENT,
        expected_sample_rows=151,
    ),
    "pdd_collection_failure": SourceContract(
        source_id="pdd_collection_failure",
        display_name="Falha na Coleta PDD",
        workbook_name="网点派件漏扫率报表(汇总)17474620261006101412.xlsx - Falha na coleta PDD.xlsx",
        sheet_name="sheet0",
        header_row=1,
        version=1,
        history_policy="DAILY_REPLACE_DATES",
        grain_description="Uma linha por linha física; cada data presente substitui sua partição integral.",
        columns=_PDD_COLLECTION_FAILURE,
        expected_sample_rows=1617,
    ),
    "base_mapping_official": SourceContract(
        source_id="base_mapping_official",
        display_name="De-para oficial de bases",
        workbook_name="De_para DoomsDay.xlsx",
        sheet_name="Ativas",
        header_row=1,
        version=1,
        history_policy="PENDING",
        grain_description="Migração inicial imutável da versão vigente, preservando as 1.628 bases originais.",
        columns=_BASE_MAPPING,
        expected_sample_rows=1628,
    ),
}


def get_contract(source_id: str) -> SourceContract:
    try:
        return CONTRACTS[source_id]
    except KeyError:
        raise KeyError("data_source_not_supported") from None


def contract_sha256(contract: SourceContract) -> bytes:
    definition = {
        "sourceId": contract.source_id,
        "version": contract.version,
        "sheet": contract.sheet_name,
        "headerRow": contract.header_row,
        "historyPolicy": contract.history_policy,
        "columns": [
            {
                "key": column.key,
                "header": column.header,
                "kind": column.kind,
                "nullable": column.nullable,
                "maxLength": column.max_length,
                "numericCodeAllowed": column.numeric_code_allowed,
            }
            for column in contract.columns
        ],
    }
    canonical = json.dumps(definition, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).digest()

