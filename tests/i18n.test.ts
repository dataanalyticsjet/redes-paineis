import assert from "node:assert/strict";
import test from "node:test";

import {
  DASHBOARD_LANGUAGES,
  dashboardHtmlLang,
  dashboardLocale,
  isDashboardLanguage,
  translateDashboardText,
} from "../src/lib/i18n.ts";

test("offers Portuguese, English, and Simplified Chinese", () => {
  assert.deepEqual(DASHBOARD_LANGUAGES.map(({ code }) => code), ["pt", "zh", "en"]);
  assert.equal(dashboardHtmlLang("pt"), "pt-BR");
  assert.equal(dashboardHtmlLang("en"), "en");
  assert.equal(dashboardHtmlLang("zh"), "zh-CN");
  assert.equal(dashboardLocale("en"), "en-US");
  assert.equal(dashboardLocale("zh"), "zh-CN");
});

test("translates labels and interpolates operational values", () => {
  assert.equal(translateDashboardText("pt", "Página {page} de {pages}", { page: 2, pages: 9 }), "Página 2 de 9");
  assert.equal(translateDashboardText("en", "Página {page} de {pages}", { page: 2, pages: 9 }), "Page 2 of 9");
  assert.equal(translateDashboardText("zh", "Página {page} de {pages}", { page: 2, pages: 9 }), "第 2 页，共 9 页");
  assert.equal(translateDashboardText("en", "Aguardando coleta"), "Awaiting collection");
  assert.equal(translateDashboardText("zh", "Parcial"), "部分完成");
  assert.equal(translateDashboardText("zh", "Status atual – Coletado"), "当前状态 – 已揽收");
  assert.equal(translateDashboardText("en", "Problemáticos Não Registrados"), "Unregistered exceptions");
});

test("preserves workbook data labels that are not in the translation catalog", () => {
  const sellerName = "Loja da Alane";
  const sellerCode = "7496278284308613842";
  assert.equal(translateDashboardText("en", sellerName), sellerName);
  assert.equal(translateDashboardText("zh", sellerCode), sellerCode);
  assert.equal(isDashboardLanguage("zh"), true);
  assert.equal(isDashboardLanguage("es"), false);
});
