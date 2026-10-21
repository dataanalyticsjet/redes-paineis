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
    expected_sample_rows: int | None
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

_COLLECTION_MONITORING_V2 = (
    _c("data_date", "Data", "DATE"),
    _c("reported_origin_region", "Regional Origem", "TEXT", nullable=True, max_length=64),
    # Keep the established source_base_name key: the V1 contract already maps
    # this exact JMS field (PDD de saida) against the official base catalogue.
    _c("source_base_name", "PDD de saida", "TEXT", nullable=True, max_length=191),
    _c("order_origin", "Origem do Pedido", "TEXT", max_length=96),
    _c("seller_collection_rate", "Taxa de coleta do vendedor", "DECIMAL", nullable=True),
    _c("collection_visit_rate", "Taxa de Visita de Coleta", "DECIMAL", nullable=True),
    _c("expected_dropoff", "Coleta Prevista Drop-off", "INTEGER"),
    _c("expected_pickup", "Coleta Prevista Pick-up", "INTEGER"),
    _c("pending_dropoff", "Aguardando Coleta Drop-off", "INTEGER"),
    _c("pending_pickup", "Aguardando Coleta Pick-up", "INTEGER"),
    _c("status_collected", "Status atual – Coletado", "INTEGER"),
    _c("status_received_at_base", "Status atual – Recebido na base", "INTEGER"),
    _c("status_dispatched_from_base", "Expedida pela Base", "INTEGER"),
    _c("status_in_transit_from_base", "Status atual – Em trânsito a partir da base", "INTEGER"),
    _c("in_transit_to_center", "网点发件在途(中心)", "INTEGER"),
    _c("in_transit_to_distribution", "网点发件在途(集散)", "INTEGER"),
    _c("arrived_sorting_center", "Chegada ao Centro de Triagem", "INTEGER"),
    _c("departed_sorting_center", "Expedido pelo Centro de Triagem", "INTEGER"),
    _c("distribution_in_transit", "集散发件在途", "INTEGER"),
    _c("arrived_sc", "Status atual – Chegou ao SC", "INTEGER"),
    _c("package_created_at_base", "Pacote Criado pela Base", "INTEGER"),
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

_COLLECTION_RATE_V2 = (
    _c("data_date", "Data de referência", "DATE"),
    _c("source_region_code", "Código da regional", "TEXT", nullable=True, max_length=64),
    _c("reported_region", "Regional", "TEXT", nullable=True, max_length=64),
    _c("source_base_code", "Código da base de coleta", "BASE_CODE", nullable=True, max_length=64, numeric_code_allowed=True),
    _c("source_base_name", "Base de coleta", "TEXT", nullable=True, max_length=191),
    _c("order_origin_code", "Código da origem do pedido", "TEXT", max_length=64),
    _c("order_origin", "Origem do pedido", "TEXT", max_length=96),
    _c("product_type_code", "Código do tipo de encomenda", "TEXT", max_length=64),
    _c("product_type", "Tipo de encomenda", "TEXT", max_length=96),
    _c("total_orders", "Total de pedidos", "INTEGER"),
    _c("quantity_to_collect", "Quantidade prevista para coleta", "INTEGER"),
    _c("cancelled_orders", "Total de cancelamentos", "INTEGER"),
    _c("collection_rate_reported", "Taxa de coleta", "DECIMAL"),
    _c("collected_quantity", "Quantidade coletada", "INTEGER"),
    _c("not_collected_quantity", "Quantidade não coletada", "INTEGER"),
    _c("not_collected_deadline_pending", "Não coletados — indicador de prazo", "INTEGER"),
    _c("collected_on_time_quantity", "Coletas no prazo", "INTEGER"),
    _c("not_collected_after_deadline", "Não coletados fora do prazo", "INTEGER"),
    _c("collected_after_deadline", "Coletas fora do prazo", "INTEGER"),
    _c("collection_on_time_rate_reported", "Taxa de coleta no prazo", "DECIMAL"),
    _c("attempts_on_time_pending", "Tentativas de coleta no prazo", "INTEGER"),
    _c("punctuality_rate_pending", "Taxa de pontualidade", "DECIMAL"),
    _c("average_collection_pending", "Média de coleta", "DECIMAL", nullable=True),
    _c("problem_quantity", "Quantidade com problema", "INTEGER"),
    _c("no_problem_quantity", "Quantidade sem problema", "INTEGER"),
    _c("seller_collection_rate_pending", "Taxa relacionada à loja", "DECIMAL"),
    _c("expected_shop_quantity_pending", "Quantidade prevista — loja", "INTEGER"),
    _c("unexpected_shop_quantity_pending", "Quantidade não prevista — loja", "INTEGER"),
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

_COLLECTION_MONITORING_T4_T5 = (
    _c("data_date", "Data", "DATE"),
    _c("reported_origin_region", "Regional Origem", "TEXT", nullable=True, max_length=64),
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

_PDD_COLLECTION_FAILURE_V2 = (
    _c("data_date", "Data considerada", "DATE"),
    _c("source_region_code", "Código da Regional do PDD Responsável", "BASE_CODE", max_length=64, numeric_code_allowed=True),
    _c("reported_region", "Nome da Regional do PDD Responsável", "TEXT", max_length=64),
    _c("source_base_code", "Código da base", "BASE_CODE", max_length=64, numeric_code_allowed=True),
    _c("source_base_name", "Nome do PDD Responsável", "TEXT", max_length=191),
    _c("order_origin_code", "Código da origem do pedido", "TEXT", max_length=64),
    _c("order_origin", "Origem do Pedido", "TEXT", max_length=96),
    _c("total_orders", "Qtd pedidos a bipar", "INTEGER"),
    _c("orders_unscanned_at_receipt", "Qtd pedidos não bipados no recebimento da coleta", "INTEGER"),
    _c("rate_unscanned_at_receipt", "Taxa de pedidos não bipados no recebimento da coleta", "DECIMAL"),
    _c("orders_unscanned_at_collection", "Qtd pedidos não bipados na coleta", "INTEGER"),
    _c("collection_failure_rate", "Taxa de falta de bipagem na coleta", "DECIMAL"),
    _c("packages_missing_dispatch_scan", "Qtd de Pacotes com Falta de Bipe de Envio", "INTEGER"),
    _c("rate_unscanned_at_dispatch", "Taxa de pedidos não bipados na expedição", "DECIMAL"),
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
    "collection_monitoring_t4_t5": SourceContract(
        source_id="collection_monitoring_t4_t5",
        display_name="Monitoramento de Coleta T4 e T5",
        workbook_name="monitoramento_coleta_t4_t5.xlsx",
        sheet_name="Dados",
        header_row=1,
        version=1,
        history_policy="DAILY_REPLACE_DATES",
        grain_description=(
            "Uma linha por linha física da aba Dados; cada data importada substitui "
            "somente sua partição diária. PDD é associado apenas por correspondência "
            "única com o DoomsDay publicado; Regional Origem não é fallback."
        ),
        columns=_COLLECTION_MONITORING_T4_T5,
        expected_sample_rows=None,
    ),
    "no_movement": SourceContract(
        source_id="no_movement",
        display_name="Sem Movimentação",
        workbook_name="painel_sem_movimentacao.xlsx",
        sheet_name="Dados",
        header_row=1,
        version=2,
        history_policy="SNAPSHOT_REPLACE_ALL",
        grain_description="Uma linha por registro físico da aba Dados; códigos de base repetidos em regionais diferentes são preservados. O snapshot é identificado pela aba Execucoes.",
        columns=_NO_MOVEMENT,
        expected_sample_rows=None,
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

PDD_COLLECTION_FAILURE_V2_CONTRACT = SourceContract(
    source_id="pdd_collection_failure",
    display_name="Falha na Coleta PDD",
    workbook_name="falha_coleta.xlsx",
    sheet_name="date-named daily sheets",
    header_row=1,
    version=2,
    history_policy="DAILY_REPLACE_DATES",
    grain_description=(
        "Uma linha por linha física das abas diárias do Bot 02; cada data importada "
        "substitui sua partição integral e preserva a aba e a linha de origem."
    ),
    columns=_PDD_COLLECTION_FAILURE_V2,
    expected_sample_rows=None,
)

COLLECTION_RATE_V2_CONTRACT = SourceContract(
    source_id="collection_rate",
    display_name="Taxa de Coleta",
    workbook_name="taxa_coleta.xlsx",
    sheet_name="Dados",
    header_row=1,
    version=2,
    history_policy="DAILY_REPLACE_DATES",
    grain_description=(
        "Uma linha por linha física da aba Dados do Bot 03; cada data de referência "
        "importada substitui integralmente sua partição diária. Códigos são associados "
        "somente por correspondência exata no De-para oficial DoomsDay."
    ),
    columns=_COLLECTION_RATE_V2,
    expected_sample_rows=None,
)

COLLECTION_RATE_V3_CONTRACT = SourceContract(
    source_id="collection_rate",
    display_name="Taxa de Coleta",
    workbook_name="taxa_coleta_mensal_validacao.xlsx",
    sheet_name="Dados",
    header_row=1,
    version=3,
    history_policy="DAILY_REPLACE_DATES",
    grain_description=(
        "Uma linha por linha física da aba Dados da exportação mensal oficial JMS; "
        "cada data presente substitui somente sua partição diária. O horário da "
        "primeira coluna é preservado, e a data da partição é derivada desse campo. "
        "A identificação organizacional usa exclusivamente correspondência única "
        "exata ou normalizada de forma conservadora com o DoomsDay publicado."
    ),
    columns=_COLLECTION_RATE,
    expected_sample_rows=None,
)

COLLECTION_MONITORING_V2_CONTRACT = SourceContract(
    source_id="collection_monitoring",
    display_name="Monitoramento de Coleta",
    workbook_name="揽收监控Resumo26331320261020082216.xlsx",
    sheet_name="sheet0",
    header_row=1,
    version=2,
    history_policy="DAILY_REPLACE_DATES",
    grain_description=(
        "Uma linha por linha física da aba sheet0 do resumo JMS. A publicação "
        "substitui somente as datas presentes; nomes PDD são associados apenas "
        "pelo mecanismo oficial de correspondência única por nome."
    ),
    columns=_COLLECTION_MONITORING_V2,
    expected_sample_rows=None,
)

CONTRACT_VERSIONS: dict[tuple[str, int], SourceContract] = {
    (source_id, contract.version): contract for source_id, contract in CONTRACTS.items()
}
CONTRACT_VERSIONS[("pdd_collection_failure", 2)] = PDD_COLLECTION_FAILURE_V2_CONTRACT
CONTRACT_VERSIONS[("collection_rate", 2)] = COLLECTION_RATE_V2_CONTRACT
CONTRACT_VERSIONS[("collection_rate", 3)] = COLLECTION_RATE_V3_CONTRACT
CONTRACT_VERSIONS[("collection_monitoring", 2)] = COLLECTION_MONITORING_V2_CONTRACT


def get_contract(source_id: str, version: int | None = None) -> SourceContract:
    versions = [
        (contract_version, contract)
        for (registered_source_id, contract_version), contract in CONTRACT_VERSIONS.items()
        if registered_source_id == source_id
    ]
    if version is not None:
        contract = CONTRACT_VERSIONS.get((source_id, version))
        if contract is None:
            raise KeyError("data_source_contract_version_not_supported")
        return contract
    if not versions:
        raise KeyError("data_source_not_supported")
    return max(versions, key=lambda item: item[0])[1]


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
