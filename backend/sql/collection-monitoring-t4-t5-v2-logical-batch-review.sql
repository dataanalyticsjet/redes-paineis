-- Revisão manual — lote lógico T4/T5 V2.
-- NÃO executar automaticamente. DDL MySQL causa commit implícito.
-- Pré-condições: schema confirmado, V1 permanece registrado, fonte ativa e sem alteração,
-- mapa DoomsDay disponível. Escopo V2 inicia inativo; escopo V1 não deve ser alterado.
-- Fingerprint canônico do código: 49bccfa5e597fa7c26928d10e445afd198a1c099406ae62cdaf173215da4e547

-- ETAPA 1 — leitura prévia
SELECT source_id, source_state, history_policy
FROM redes_paineis_dados.data_source_registry
WHERE source_id='collection_monitoring_t4_t5';

SELECT source_id, contract_version, contract_state, history_policy, HEX(contract_sha256) AS contract_sha256
FROM redes_paineis_dados.source_contract_versions
WHERE source_id='collection_monitoring_t4_t5' AND contract_version IN (1,2)
ORDER BY contract_version;

SELECT service_principal_id, source_id, contract_version, is_active
FROM redes_paineis_dados.data_service_principal_contract_scopes
WHERE service_principal_id='windows-newbi-publisher'
  AND source_id='collection_monitoring_t4_t5'
ORDER BY contract_version;

-- Confirmar em SHOW CREATE TABLE antes de seguir:
SHOW CREATE TABLE redes_paineis_dados.import_jobs;
SHOW CREATE TABLE redes_paineis_dados.source_publications;
SHOW CREATE TABLE redes_paineis_dados.source_publication_dates;
SHOW CREATE TABLE redes_paineis_dados.fact_collection_monitoring_t4_t5;

-- ETAPA 2 — tabelas do lote.
-- Pare se qualquer nome já existir com estrutura diferente.
CREATE TABLE redes_paineis_dados.data_import_batches (
  job_id BINARY(16) NOT NULL,
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  service_principal_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  manifest_json JSON NOT NULL,
  manifest_sha256 BINARY(32) NOT NULL,
  idempotency_key_sha256 BINARY(32) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  map_version_id BINARY(16) NOT NULL,
  expected_part_count SMALLINT UNSIGNED NOT NULL,
  expected_total_bytes BIGINT UNSIGNED NOT NULL,
  expected_total_rows BIGINT UNSIGNED NOT NULL,
  batch_state ENUM('RECEIVING','VALIDATING','VALIDATED','PUBLISHING','PUBLISHED','INVALID','FAILED') NOT NULL,
  publish_key_sha256 BINARY(32) NULL,
  publication_id BINARY(16) NULL,
  progress_rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
  validation_error_code VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (job_id),
  UNIQUE KEY uq_t4t5_batch_idempotency (service_principal_id,source_id,contract_version,idempotency_key_sha256),
  KEY ix_t4t5_batch_state (source_id,batch_state,updated_at),
  CONSTRAINT fk_t4t5_batch_job
    FOREIGN KEY (source_id,job_id,contract_version,map_version_id)
    REFERENCES redes_paineis_dados.import_jobs(source_id,job_id,contract_version,validation_map_version_id),
  CONSTRAINT fk_t4t5_batch_contract
    FOREIGN KEY (source_id,contract_version)
    REFERENCES redes_paineis_dados.source_contract_versions(source_id,contract_version),
  CONSTRAINT fk_t4t5_batch_principal
    FOREIGN KEY (service_principal_id)
    REFERENCES redes_paineis_dados.data_service_principals(service_principal_id),
  CONSTRAINT fk_t4t5_batch_map
    FOREIGN KEY (map_version_id)
    REFERENCES redes_paineis_dados.base_mapping_versions(map_version_id),
  CONSTRAINT fk_t4t5_batch_publication
    FOREIGN KEY (publication_id)
    REFERENCES redes_paineis_dados.source_publications(publication_id),
  CONSTRAINT chk_t4t5_batch_period CHECK (period_start <= period_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE redes_paineis_dados.data_import_batch_parts (
  job_id BINARY(16) NOT NULL,
  data_date DATE NOT NULL,
  part_no SMALLINT UNSIGNED NOT NULL,
  original_file_name VARCHAR(128) NOT NULL,
  expected_size_bytes BIGINT UNSIGNED NOT NULL,
  expected_sha256 BINARY(32) NOT NULL,
  expected_row_count BIGINT UNSIGNED NOT NULL,
  actual_size_bytes BIGINT UNSIGNED NULL,
  actual_sha256 BINARY(32) NULL,
  stored_file_key VARCHAR(256) NULL,
  upload_state ENUM('MISSING','RECEIVED') NOT NULL DEFAULT 'MISSING',
  validation_state ENUM('PENDING','VALID') NOT NULL DEFAULT 'PENDING',
  valid_row_count BIGINT UNSIGNED NULL,
  mapped_row_count BIGINT UNSIGNED NULL,
  unmapped_row_count BIGINT UNSIGNED NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (job_id,data_date),
  UNIQUE KEY uq_t4t5_batch_part_no (job_id,part_no),
  KEY ix_t4t5_batch_part_upload (job_id,upload_state,validation_state),
  CONSTRAINT fk_t4t5_batch_part_job
    FOREIGN KEY (job_id) REFERENCES redes_paineis_dados.data_import_batches(job_id),
  CONSTRAINT chk_t4t5_batch_part_size CHECK (actual_size_bytes IS NULL OR actual_size_bytes=expected_size_bytes),
  CONSTRAINT chk_t4t5_batch_part_hash CHECK (actual_sha256 IS NULL OR actual_sha256=expected_sha256),
  CONSTRAINT chk_t4t5_batch_part_rows CHECK (valid_row_count IS NULL OR valid_row_count=expected_row_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ETAPA 3 — registrar V2 como DISCOVERED; preservar integralmente a V1.
-- O cadastro V2 não autoriza publicação até aprovação explícita e escopo ativo.
INSERT INTO redes_paineis_dados.source_contract_versions
  (source_id,contract_version,contract_state,expected_sheet,header_row,expected_extension,
   grain_description,history_policy,contract_sha256)
SELECT source_id,2,'DISCOVERED',expected_sheet,header_row,expected_extension,
       'Lote lógico com uma partição diária por arquivo; todas as datas são publicadas juntas sob uma única publicação e um mapa DoomsDay fixado.',
       'DAILY_REPLACE_DATES',
       UNHEX('49bccfa5e597fa7c26928d10e445afd198a1c099406ae62cdaf173215da4e547')
FROM redes_paineis_dados.source_contract_versions
WHERE source_id='collection_monitoring_t4_t5' AND contract_version=1;

INSERT INTO redes_paineis_dados.source_contract_columns
  (source_id,contract_version,column_key,ordinal_position,source_header,semantic_role,data_type,
   is_required,is_nullable,validation_rules)
SELECT source_id,2,column_key,ordinal_position,source_header,semantic_role,data_type,
       is_required,is_nullable,validation_rules
FROM redes_paineis_dados.source_contract_columns
WHERE source_id='collection_monitoring_t4_t5' AND contract_version=1
ORDER BY ordinal_position;

-- Adicionar V2 inativa. Não atualizar nem ativar o escopo V1.
INSERT INTO redes_paineis_dados.data_service_principal_contract_scopes
  (service_principal_id,source_id,contract_version,is_active)
SELECT 'windows-newbi-publisher','collection_monitoring_t4_t5',2,0
WHERE EXISTS (
  SELECT 1 FROM redes_paineis_dados.data_service_principals
  WHERE service_principal_id='windows-newbi-publisher' AND is_active=1
);

-- ETAPA 4 — pós-verificação, somente leitura
SHOW CREATE TABLE redes_paineis_dados.data_import_batches;
SHOW CREATE TABLE redes_paineis_dados.data_import_batch_parts;

SELECT source_id,contract_version,contract_state,expected_sheet,header_row,history_policy,
       HEX(contract_sha256) AS contract_sha256
FROM redes_paineis_dados.source_contract_versions
WHERE source_id='collection_monitoring_t4_t5' AND contract_version IN (1,2)
ORDER BY contract_version;

SELECT contract_version,COUNT(*) AS column_count
FROM redes_paineis_dados.source_contract_columns
WHERE source_id='collection_monitoring_t4_t5' AND contract_version IN (1,2)
GROUP BY contract_version ORDER BY contract_version;

SELECT service_principal_id,source_id,contract_version,is_active
FROM redes_paineis_dados.data_service_principal_contract_scopes
WHERE service_principal_id='windows-newbi-publisher'
  AND source_id='collection_monitoring_t4_t5'
ORDER BY contract_version;

-- Rollback manual somente se nenhum job/publicação V2 foi criado:
-- 1) validar SELECT COUNT(*) em import_jobs/source_publications com contract_version=2.
-- 2) remover primeiro o escopo V2, depois colunas e contrato V2.
-- 3) DROP TABLE data_import_batch_parts; DROP TABLE data_import_batches.
-- Nunca remover contrato, escopo, publicações ou históricos V1.
