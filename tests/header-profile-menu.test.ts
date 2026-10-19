import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatCollaboratorName } from "../src/lib/profile-name.ts";

const appSource = readFileSync("src/features/dashboards/dashboard-app.tsx", "utf8");
const styleSource = readFileSync("src/styles/globals.css", "utf8");
const i18nSource = readFileSync("src/lib/i18n.ts", "utf8");

test("NEW BI stays beside the undistorted J&T logo and language control remains in the header", () => {
  const headerStart = appSource.indexOf('<header className="presentation-home-header">');
  const headerEnd = appSource.indexOf("</header>", headerStart);
  const header = appSource.slice(headerStart, headerEnd);

  assert.match(header, /className="presentation-brand-lockup"[\s\S]*?alt="J&T Express"[\s\S]*?className="presentation-brand-name">NEW BI/);
  assert.ok(header.indexOf("<LanguageSwitcher") < header.indexOf("<UserProfileMenu"));
  assert.doesNotMatch(header, /presentation-user-control-button|presentation-logout-button/);
});

test("profile formats names for display, shows avatar when valid and initials as fallback", () => {
  assert.match(appSource, /identity\.username\.trim\(\)/);
  assert.match(appSource, /identity\.avatar_url\?\.trim\(\)/);
  assert.match(appSource, /left\.avatar_url === right\.avatar_url/);
  assert.match(appSource, /failedAvatarUrl === avatarUrl/);
  assert.match(appSource, /onError=\{\(\) => setFailedAvatarUrl\(avatarUrl\)\}/);
  assert.match(appSource, /referrerPolicy="no-referrer"/);
  assert.match(appSource, /formatCollaboratorName\(rawName\)/);
  assert.match(appSource, /organizationalRegionLabel\([\s\S]*identity\.organizational_region_code[\s\S]*identity\.region_resolution_status/);
  assert.doesNotMatch(appSource, /const region = identity\.home_region/);
  assert.match(appSource, /avatarUrl && !avatarLoadFailed[\s\S]*?initials \|\| <UserRound size=\{size\} \/>/);
  assert.match(appSource, /\{fullName\}[\s\S]*?\{region\}/);
  assert.match(appSource, /Regional não identificada/);
  assert.match(styleSource, /\.profile-avatar img[\s\S]*?object-fit: cover/);
});

test("collaborator names preserve Latin accents, lowercase particles and non-Latin scripts", () => {
  assert.equal(formatCollaboratorName("PHELIPPE LUCIANO CARDOSO"), "Phelippe Luciano Cardoso");
  assert.equal(formatCollaboratorName("MARIA EDUARDA DA SILVA"), "Maria Eduarda da Silva");
  assert.equal(formatCollaboratorName("JOÃO PEDRO DOS SANTOS"), "João Pedro dos Santos");
  assert.equal(formatCollaboratorName("张三"), "张三");
  assert.equal(formatCollaboratorName("周正军 WENTONG DONG (WINTA)"), "周正军 Wentong Dong (Winta)");
});

test("administrative menu items use backend-authorized capabilities separate from data scope", () => {
  assert.match(appSource, /canManageDataSources=\{isMatrixAdminViewer\}/);
  assert.match(appSource, /canManageUsers=\{viewerIdentity\.can_manage_users === true\}/);
  assert.match(appSource, /\{canManageDataSources \? <button[\s\S]*?t\("Fontes de dados"\)/);
  assert.match(appSource, /\{canManageUsers \? <button[\s\S]*?t\("Controle de usuários"\)/);
  assert.match(appSource, /onOpenDataSources=\{\(\) => \{ setView\("data-foundation"\)/);
  assert.match(appSource, /onOpenUserControl=\{\(\) => \{ setView\("home"\); setShowUserControl\(true\); \}\}/);
});

test("profile menu supports outside click, Escape, arrow navigation and reduced motion", () => {
  assert.match(appSource, /document\.addEventListener\("pointerdown", closeWhenOutside, true\)/);
  assert.match(appSource, /event\.key === "Escape"/);
  assert.match(appSource, /\["ArrowDown", "ArrowUp", "Home", "End"\]/);
  assert.match(styleSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.profile-menu-popover \{ animation: none/);
});

test("theme preference is persisted separately from language and translated in all languages", () => {
  assert.match(appSource, /DASHBOARD_THEME_STORAGE_KEY = "jt-dashboard-theme"/);
  assert.match(appSource, /document\.documentElement\.dataset\.theme = theme/);
  assert.match(appSource, /window\.localStorage\.setItem\(DASHBOARD_THEME_STORAGE_KEY, theme\)/);
  assert.match(i18nSource, /"Ativar tema escuro": \{ en: "Enable dark theme", zh: "启用深色主题" \}/);
  assert.match(i18nSource, /"Ativar tema claro": \{ en: "Enable light theme", zh: "启用浅色主题" \}/);
});
