import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontend = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
const backend = await readFile(new URL("../backend/app/api/workbooks.py", import.meta.url), "utf8");
const backendTests = await readFile(new URL("../backend/tests/test_workbooks.py", import.meta.url), "utf8");
const actionBand = await readFile(new URL("../src/features/dashboards/dashboard-action-band.tsx", import.meta.url), "utf8");
const dialog = await readFile(new URL("../src/features/data-sources/responsibility-source-dialog.tsx", import.meta.url), "utf8");
const sourceApi = await readFile(new URL("../src/lib/data-sources/responsibility.ts", import.meta.url), "utf8");
const catalog = await readFile(new URL("../src/lib/data-sources/catalog.ts", import.meta.url), "utf8");
const translations = await readFile(new URL("../src/lib/i18n.ts", import.meta.url), "utf8");

test("dashboard uploads do not ask for a second username and password", () => {
  assert.doesNotMatch(frontend, /apiFetch\("\/api\/upload-auth"/);
  assert.doesNotMatch(frontend, /Autorizar envio de Excel/);
  assert.doesNotMatch(frontend, /uploadAuthorizationRef|uploadLoginOpen|submitUploadLogin/);
  assert.match(frontend, /apiFetch\("\/api\/workbook"/);
  assert.match(frontend, /const queueUpload = useCallback\([\s\S]*?void runUpload\(upload\)/);
  assert.match(frontend, /canManageUpload \? onAddSource \?/);
  assert.match(frontend, /canManageUpload=\{viewerIdentity\.platform_role === "ADMIN"\}/);
  assert.match(frontend, /viewerIdentity\.platform_role === "ADMIN" \? <label className="primary-upload-button" htmlFor="epop-upload"/);
  assert.match(backend, /async def verify_upload_auth\([\s\S]*?_admin: AuthenticatedViewer = Depends\(require_admin\)/);
  const workbookWriter = backend.slice(backend.indexOf("async def write_workbook("));
  assert.match(workbookWriter, /_admin: AuthenticatedViewer = Depends\(require_admin\)/);
  assert.doesNotMatch(workbookWriter, /_upload_error\(/);
  assert.match(backend, /hmac\.compare_digest/);
  assert.match(backendTests, /def test_legacy_upload_auth_remains_available_but_admin_session_publishes_without_it/);
  assert.match(backendTests, /def test_workbook_requires_authenticated_admin_session/);
});

test("modern source actions share one component and are limited to configured sources for admins", () => {
  assert.match(actionBand, /onDataSource \? <button type="button" onClick=\{onDataSource\}><Database size=\{16\} \/> \{t\("Fonte de dados"\)\}/);
  assert.match(frontend, /viewerIdentity\?\.platform_role === "ADMIN" && activeDataSourceConfig\?\.configured === true/);
  for (const mapping of [
    'monitoramento: "monitoring"',
    'taxa: "taxa"',
    'movimentacao: "movement"',
    'sellers: "sellerPerformance"',
  ]) assert.ok(frontend.includes(mapping), `missing configured dashboard source mapping: ${mapping}`);
  assert.match(catalog, /bipagem: pendingSource\("bipagem", "Falha na coleta PDD"\)/);
});

test("responsibility source dialog displays persisted current-source metadata and keeps it through preview", () => {
  assert.match(sourceApi, /export async function getResponsibilitySource\(/);
  assert.match(dialog, /getResponsibilitySource\(\)/);
  assert.match(dialog, /Fonte oficial atual/);
  assert.match(dialog, /currentSource\.fileName/);
  assert.match(dialog, /currentSource\.publishedAt \?\? currentSource\.updatedAt/);
  assert.match(dialog, /currentSource\.rowCount/);
  assert.match(dialog, /currentSource\.baseCount/);
  assert.match(dialog, /currentSource\.duplicateBaseCount/);
  assert.match(dialog, /setCurrentSource\(source\);\s*setPreview\(null\);/);
  assert.match(dialog, /Selecionar novo arquivo/);
  assert.match(backend, /"publishedAt": updated_at/);
  assert.match(backend, /"versionId": metadata\.get\("latestVersion"\)/);
});

test("new data-source labels are translated for English and Simplified Chinese", () => {
  for (const key of ["Fonte oficial atual", "Publicado em", "Ativa", "Selecionar novo arquivo", "Duplicidades", "Aba", "De-para publicado com sucesso."]) {
    assert.match(translations, new RegExp(`"${key}": \\{ en: .+, zh: .+ \\}`));
  }
});
