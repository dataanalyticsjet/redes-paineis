import {
  Activity,
  BadgeCheck,
  CalendarDays,
  ChartNoAxesCombined,
  CircleAlert,
  ClipboardList,
  Clock3,
  Gauge,
  Layers3,
  PackageCheck,
  ShieldCheck,
  Target,
  Truck,
  Undo2,
  UserCheck,
} from "lucide-react";

export type DashboardPanel =
  | "monitoramento" | "taxa" | "epop" | "movimentacao" | "sellers" | "bipagem" | "damage"
  | "tt5cd" | "loss" | "last-mile-damage" | "volumetry" | "no-movement-10-days" | "no-movement-3-14-days"
  | "retained-10-days" | "return" | "last-mile-sla" | "t0" | "rollover" | "pod-approval-rate" | "pnr-rate"
  | "pnr-packages-target" | "dispatch-delivery-window" | "shipping-time" | "driver-attendance" | "bagging-consolidated-report";

export type DashboardCategory = "first-mile" | "last-mile";

export const dashboardCategories: { id: DashboardCategory; label: string }[] = [
  { id: "first-mile", label: "First Mile" },
  { id: "last-mile", label: "Last Mile" },
];

export const dashboardCards: { id: DashboardPanel; title: string; description: string; icon: typeof PackageCheck; tone: string; category: DashboardCategory }[] = [
  { id: "monitoramento", title: "Monitoramento de coleta", description: "Pedidos, status e períodos.", icon: PackageCheck, tone: "red", category: "first-mile" },
  { id: "taxa", title: "Taxa de coleta", description: "Desempenho e tentativas.", icon: Target, tone: "gray", category: "first-mile" },
  { id: "epop", title: "Cobertura EPOP", description: "Comprovantes por regional e base.", icon: BadgeCheck, tone: "red", category: "first-mile" },
  { id: "sellers", title: "Monitoramento de sellers prioritários J&T", description: "Acompanhamento de sellers.", icon: ShieldCheck, tone: "gray", category: "first-mile" },
  { id: "movimentacao", title: "Sem movimentação", description: "Pedidos por aging e origem.", icon: ChartNoAxesCombined, tone: "red", category: "first-mile" },
  { id: "bipagem", title: "Falha na coleta PDD", description: "Digitalização e falhas por equipe.", icon: ClipboardList, tone: "gray", category: "first-mile" },
  { id: "damage", title: "Extravio", description: "Qualidade, motivos e arbitragem.", icon: CircleAlert, tone: "red", category: "first-mile" },
  { id: "tt5cd", title: "TT5CD", description: "Fonte de dados ainda não configurada para este painel.", icon: Activity, tone: "red", category: "last-mile" },
  { id: "loss", title: "Extravio", description: "Fonte de dados ainda não configurada para este painel.", icon: CircleAlert, tone: "red", category: "last-mile" },
  { id: "last-mile-damage", title: "Avaria", description: "Fonte de dados ainda não configurada para este painel.", icon: ShieldCheck, tone: "gray", category: "last-mile" },
  { id: "volumetry", title: "Volumetria", description: "Fonte de dados ainda não configurada para este painel.", icon: Layers3, tone: "red", category: "last-mile" },
  { id: "no-movement-10-days", title: "Sem movimentação 10 dias", description: "Fonte de dados ainda não configurada para este painel.", icon: ChartNoAxesCombined, tone: "gray", category: "last-mile" },
  { id: "no-movement-3-14-days", title: "Sem movimentação 3 a 14 dias", description: "Fonte de dados ainda não configurada para este painel.", icon: CalendarDays, tone: "red", category: "last-mile" },
  { id: "retained-10-days", title: "Retidos 10 dias", description: "Fonte de dados ainda não configurada para este painel.", icon: PackageCheck, tone: "gray", category: "last-mile" },
  { id: "return", title: "Devolução", description: "Fonte de dados ainda não configurada para este painel.", icon: Undo2, tone: "red", category: "last-mile" },
  { id: "last-mile-sla", title: "Taxa de Last Mile - SLA", description: "Fonte de dados ainda não configurada para este painel.", icon: Target, tone: "gray", category: "last-mile" },
  { id: "t0", title: "T0", description: "Fonte de dados ainda não configurada para este painel.", icon: Gauge, tone: "red", category: "last-mile" },
  { id: "rollover", title: "Capotamento", description: "Fonte de dados ainda não configurada para este painel.", icon: CircleAlert, tone: "gray", category: "last-mile" },
  { id: "pod-approval-rate", title: "Taxa de aprovação POD", description: "Fonte de dados ainda não configurada para este painel.", icon: BadgeCheck, tone: "red", category: "last-mile" },
  { id: "pnr-rate", title: "Taxa de PNR (%)", description: "Fonte de dados ainda não configurada para este painel.", icon: ChartNoAxesCombined, tone: "gray", category: "last-mile" },
  { id: "pnr-packages-target", title: "Taxa de PNR (meta de pacotes/10.000)", description: "Fonte de dados ainda não configurada para este painel.", icon: Target, tone: "red", category: "last-mile" },
  { id: "dispatch-delivery-window", title: "Expedição as 8h, entrega as 12h e 14h", description: "Fonte de dados ainda não configurada para este painel.", icon: Truck, tone: "gray", category: "last-mile" },
  { id: "shipping-time", title: "Shipping time", description: "Fonte de dados ainda não configurada para este painel.", icon: Clock3, tone: "red", category: "last-mile" },
  { id: "driver-attendance", title: "Assiduidade do motorista", description: "Fonte de dados ainda não configurada para este painel.", icon: UserCheck, tone: "gray", category: "last-mile" },
  { id: "bagging-consolidated-report", title: "Relatório consolidado de ensacamento", description: "Fonte de dados ainda não configurada para este painel.", icon: ClipboardList, tone: "red", category: "last-mile" },
];
