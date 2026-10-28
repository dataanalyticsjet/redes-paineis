import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");
const editor = read("src/features/users/user-control.tsx");
const api = read("src/lib/admin-users.ts");
const backend = read("backend/app/services/user_access.py");
const adminApi = read("backend/app/api/admin_users.py");
const authApi = read("backend/app/api/auth.py");
const translations = read("src/lib/i18n.ts");

test("admin UI distinguishes automatic Feishu scope from replacement override", () => {
  assert.match(editor, /Usar regional automática do Feishu/);
  assert.match(editor, /Permissões personalizadas pelo administrador/);
  assert.match(editor, /adminOverrideEnabled: draftOverrideEnabled/);
  assert.match(editor, /adminAllowedRegions: draftOverrideEnabled \? draftRegions : \[\]/);
  assert.match(editor, /draftRegions\.length === 0/);
  assert.doesNotMatch(editor, /region\.code === editingUser\.homeRegion/);
});

test("admin UI previews exactly the effective regions and retains Matrix classification independently", () => {
  assert.match(editor, /draftRegions\.map\(regionName\)\.join\(", "\)/);
  assert.match(editor, /user\.feishuRegionCode === "MATRIZ"/);
  assert.match(editor, /user\.adminOverrideEnabled[\s\S]*user\.effectiveRegions\.map\(regionName\)/);
  assert.match(editor, /effectiveScopeSource|effective_scope_source|Acesso efetivo após salvar/);
});

test("backend persists explicit replacement separately from legacy additional grants", () => {
  assert.match(adminApi, /admin_override_enabled/);
  assert.match(adminApi, /region_override=region_override/);
  assert.match(backend, /administrative_region_override_for_user/);
  assert.match(backend, /regional_override_created_from_legacy/);
  assert.match(backend, /regional_override_created_from_none/);
  assert.match(backend, /regional_override_removed_to_none/);
  assert.match(backend, /user_region_override_requires_admin_mode/);
  assert.match(backend, /override_enabled_before and additional_regions is not None and not region_override/);
});

test("auth and audit responses expose effective scope source without trusting frontend filters", () => {
  assert.match(authApi, /"admin_override_enabled"/);
  assert.match(authApi, /"admin_allowed_regions"/);
  assert.match(authApi, /"effective_scope_source"/);
  assert.match(adminApi, /"scopeSourceBefore"/);
  assert.match(adminApi, /"scopeSourceAfter"/);
  assert.match(api, /adminOverrideEnabled: boolean/);
  assert.match(api, /effectiveScopeSource:/);
});

test("permission labels and override errors are translated to Portuguese, English and Chinese", () => {
  for (const key of [
    "Origem das permissões",
    "Usar regional automática do Feishu",
    "Permissões personalizadas pelo administrador",
    "Acesso definido pelo Feishu",
    "Acesso personalizado pelo administrador",
    "ADMIN_OVERRIDE",
    "LEGACY_GRANT",
    "user_region_override_requires_regions",
    "Atualizando permissões…",
  ]) {
    assert.match(translations, new RegExp(`"${key}"\\s*:\\s*\\{[^}]*en:[^}]*zh:`, "s"));
  }
});
