import type { ParsedWorkbook } from "../workbook";
import type { DashboardSourceId, DataSourcePreview, ManualDataSource } from "./api";
import {
  importMonitoringSource,
  normalizeMonitoringWorkbook,
  parseMonitoringWorkbookFile,
  previewMonitoringSource,
  removeMonitoringSource,
} from "./monitoring.ts";
import {
  importTaxaSource,
  normalizeTaxaWorkbook,
  parseTaxaWorkbookFile,
  previewTaxaSource,
  removeTaxaSource,
} from "./taxa.ts";
import {
  importSellerMonitoringSource,
  normalizeSellerMonitoringWorkbook,
  parseSellerMonitoringWorkbookFile,
  previewSellerMonitoringSource,
  removeSellerMonitoringSource,
} from "./seller-monitoring.ts";

export type DataSourceMode = "MANUAL" | "AUTOMATIC";
export type DashboardDataSourceStatus = "SOURCE_CONFIGURED" | "SOURCE_NOT_CONFIGURED";

export interface DashboardDataSourceConfig {
  id: DashboardSourceId;
  title: string;
  description: string;
  status: DashboardDataSourceStatus;
  configured: boolean;
  sourceModes: readonly DataSourceMode[];
  acceptedFormats: readonly string[];
  requiredFields: readonly string[];
  optionalFields: readonly string[];
  parse?: (file: File) => Promise<ParsedWorkbook>;
  normalize?: (parsed: ParsedWorkbook) => ParsedWorkbook | Promise<ParsedWorkbook>;
  preview?: (file: File, parsed: ParsedWorkbook) => Promise<DataSourcePreview>;
  import?: (previewId: string) => Promise<ManualDataSource>;
  remove?: () => Promise<void>;
}

export const DASHBOARD_SOURCE_IDS: Record<DashboardSourceId, DashboardSourceId> = {
  monitoring: "monitoring",
  taxa: "taxa",
  epop: "epop",
  movement: "movement",
  sellerPerformance: "sellerPerformance",
  bipagem: "bipagem",
  damage: "damage",
  tt5cd: "tt5cd",
  loss: "loss",
  "last-mile-damage": "last-mile-damage",
  volumetry: "volumetry",
  "no-movement-10-days": "no-movement-10-days",
  "no-movement-3-14-days": "no-movement-3-14-days",
  "retained-10-days": "retained-10-days",
  return: "return",
  "last-mile-sla": "last-mile-sla",
  t0: "t0",
  rollover: "rollover",
  "pod-approval-rate": "pod-approval-rate",
  "pnr-rate": "pnr-rate",
  "pnr-packages-target": "pnr-packages-target",
  "dispatch-delivery-window": "dispatch-delivery-window",
  "shipping-time": "shipping-time",
  "driver-attendance": "driver-attendance",
  "bagging-consolidated-report": "bagging-consolidated-report",
};

export const DASHBOARD_DATA_SOURCES: Record<DashboardSourceId, DashboardDataSourceConfig> = {
  monitoring: {
    id: "monitoring",
    title: "Monitoramento de coletas",
    description: "Fonte de dados do monitoramento de coletas.",
    status: "SOURCE_CONFIGURED",
    configured: true,
    sourceModes: ["MANUAL"],
    acceptedFormats: [".xlsx", ".xls"],
    requiredFields: ["Data", "Base", "Status numérico"],
    optionalFields: ["Regional", "Origem do pedido", "Status categórico"],
    parse: parseMonitoringWorkbookFile,
    normalize: normalizeMonitoringWorkbook,
    preview: previewMonitoringSource,
    import: importMonitoringSource,
    remove: removeMonitoringSource,
  },
  taxa: {
    id: "taxa",
    title: "Taxa de coleta",
    description: "Fonte de dados do painel Taxa de coleta.",
    status: "SOURCE_CONFIGURED",
    configured: true,
    sourceModes: ["MANUAL"],
    acceptedFormats: [".xlsx", ".xls"],
    requiredFields: [
      "Horário de término do prazo de coleta",
      "Nome da regional",
      "Nome da base de coleta",
      "Origem do Pedido",
      "Tipo de produto",
      "Quantidade de pedidos",
      "Qtd a coletar",
      "Qtd cancelada",
      "Taxa de coleta",
      "揽收量",
      "未揽收量",
      "Qtd não coletada no prazo",
      "Qtd coletada no prazo",
      "Taxa de coleta no prazo",
      "Pedidos coletados + Tentativas de coleta",
      "Taxa de coleta com tentativas de coleta",
      "Prazo médio demorado para coleta(h)",
      "已做问题件的量",
      "未做问题件的量",
      "Taxa de coleta do vendedor",
      "应上门商家量",
      "未上门商家量",
    ],
    optionalFields: [],
    parse: parseTaxaWorkbookFile,
    normalize: normalizeTaxaWorkbook,
    preview: previewTaxaSource,
    import: importTaxaSource,
    remove: removeTaxaSource,
  },
  epop: pendingSource("epop", "Cobertura EPOP"),
  movement: pendingSource("movement", "Sem movimentação"),
  sellerPerformance: {
    id: "sellerPerformance",
    title: "Monitoramento J&T",
    description: "Fonte compartilhada do Monitoramento J&T.",
    status: "SOURCE_CONFIGURED",
    configured: true,
    sourceModes: ["MANUAL"],
    acceptedFormats: [".xlsx", ".xls"],
    requiredFields: ["Data", "Regional Origem", "PDD de saida", "Id Seller/remetente", "Status numérico"],
    optionalFields: ["Cliente", "Loja", "Motorista Designado", "Origem do Pedido"],
    parse: parseSellerMonitoringWorkbookFile,
    normalize: normalizeSellerMonitoringWorkbook,
    preview: previewSellerMonitoringSource,
    import: importSellerMonitoringSource,
    remove: removeSellerMonitoringSource,
  },
  bipagem: pendingSource("bipagem", "Falha na coleta PDD"),
  damage: pendingSource("damage", "Extravio"),
  tt5cd: pendingSource("tt5cd", "TT5CD"),
  loss: pendingSource("loss", "Extravio"),
  "last-mile-damage": pendingSource("last-mile-damage", "Avaria"),
  volumetry: pendingSource("volumetry", "Volumetria"),
  "no-movement-10-days": pendingSource("no-movement-10-days", "Sem movimentação 10 dias"),
  "no-movement-3-14-days": pendingSource("no-movement-3-14-days", "Sem movimentação 3 a 14 dias"),
  "retained-10-days": pendingSource("retained-10-days", "Retidos 10 dias"),
  return: pendingSource("return", "Devolução"),
  "last-mile-sla": pendingSource("last-mile-sla", "Taxa de Last Mile - SLA"),
  t0: pendingSource("t0", "T0"),
  rollover: pendingSource("rollover", "Capotamento"),
  "pod-approval-rate": pendingSource("pod-approval-rate", "Taxa de aprovação POD"),
  "pnr-rate": pendingSource("pnr-rate", "Taxa de PNR (%)"),
  "pnr-packages-target": pendingSource("pnr-packages-target", "Taxa de PNR (meta de pacotes/10.000)"),
  "dispatch-delivery-window": pendingSource("dispatch-delivery-window", "Expedição as 8h, entrega as 12h e 14h"),
  "shipping-time": pendingSource("shipping-time", "Shipping time"),
  "driver-attendance": pendingSource("driver-attendance", "Assiduidade do motorista"),
  "bagging-consolidated-report": pendingSource("bagging-consolidated-report", "Relatório consolidado de ensacamento"),
};

function pendingSource(id: DashboardSourceId, title: string): DashboardDataSourceConfig {
  return {
    id,
    title,
    description: "Fonte de dados ainda não configurada para este painel.",
    status: "SOURCE_NOT_CONFIGURED",
    configured: false,
    sourceModes: ["MANUAL", "AUTOMATIC"],
    acceptedFormats: [],
    requiredFields: [],
    optionalFields: [],
  };
}
