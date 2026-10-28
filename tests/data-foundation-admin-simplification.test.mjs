import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const admin = readFileSync("src/features/data-foundation/data-foundation-admin.tsx", "utf8");
const candidateUi = readFileSync("src/features/data-foundation/network-directory-candidate.tsx", "utf8");
const queries = readFileSync("backend/app/services/data_foundation/queries.py", "utf8");
const versioning = readFileSync("backend/app/services/data_foundation/network_directory_versioning.py", "utf8");
const activation = readFileSync("backend/app/services/data_foundation/network_directory_activation.py", "utf8");

test("source list shows real file metadata and a single update action without contract/version internals", () => {
  assert.match(admin, /data-foundation-source-cards/);
  assert.match(admin, /publication\?\.fileName/);
  assert.match(admin, /publication\?\.attachedAt/);
  assert.match(admin, /America\/Sao_Paulo/);
  assert.match(admin, /function displayPanelName\(value: string\)[\s\S]*?replace\(\/\\s\+V\[123\]\$\/i, ""\)/);
  assert.match(admin, /Atualizar arquivo/);
  assert.doesNotMatch(admin, /Última publicação e histórico|CONTRATO OFICIAL|v\$\{last\.version\}/);
  assert.match(admin, /source\.source_id !== "base_mapping_official"/);
});

test("selecting an Excel opens the validation dialog; publishing is only available through its explicit confirmation", () => {
  assert.match(admin, /void makePreview\(source\.source_id, selectedFile\)/);
  assert.match(admin, /role="dialog" aria-modal="true"/);
  assert.match(admin, /Confirmar atualização/);
  assert.match(admin, /setOperationStartedAt\(new Date\(\)\.toISOString\(\)\)/);
  assert.match(admin, /formatDataFoundationDateTime\(operationStartedAt\)/);
  assert.match(admin, /onPublish=\{\(\) => void publish\(\)\}/);
  assert.doesNotMatch(admin, /window\.confirm/);
  assert.match(admin, /disabled=\{!canPublish\}/);
});

test("official mapping appears once and opens the versioned update and publication flow", () => {
  assert.match(admin, /<h2>\{t\("Depara"\)\}<\/h2>/);
  assert.match(admin, /mapping\.fileName/);
  assert.match(admin, /mapping\.attachedAt/);
  assert.match(admin, /import \{ NetworkDirectoryCandidate \} from/);
  assert.match(admin, /onClick=\{\(\) => setMappingCandidateOpen\(true\)\}/);
  assert.match(admin, /<NetworkDirectoryCandidate[\s\S]*?onPublished=\{\(\) => \{ void loadMetadata\(\); \}\}/);
  assert.doesNotMatch(admin, /base-mapping\/initial-migration/);
  assert.doesNotMatch(activation, /EXPECTED_CANDIDATE_VERSION\s*=\s*2|EXPECTED_CANDIDATE_ROWS\s*=\s*1783/);
  assert.match(activation, /candidate_metadata IS NOT NULL[\s\S]*?ORDER BY version_no DESC LIMIT 1/);
  assert.match(activation, /candidate\["version"\] \+ 1|candidate_version/);
  assert.match(versioning, /SELECT COALESCE\(MAX\(version_no\), 0\) FROM base_mapping_versions[\s\S]*?\+ 1/);
  assert.match(activation, /expectedOfficialMapVersionId/);
  assert.match(candidateUi, /if \(selected\) void run\(false, selected\)/);
  assert.match(candidateUi, /previousCount/);
  assert.match(candidateUi, /Atenção: esta revisão altera o conteúdo do mapa/);
  assert.match(candidateUi, /rollbackMapVersionId/);
  assert.match(candidateUi, /role="dialog" aria-modal="true"/);
  assert.match(queries, /version\.original_file_name/);
});
