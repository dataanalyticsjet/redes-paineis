import { createFileRoute } from "@tanstack/react-router";
import { DashboardApp } from "../features/dashboards/dashboard-app";

export const Route = createFileRoute("/")({
  component: DashboardApp,
});
