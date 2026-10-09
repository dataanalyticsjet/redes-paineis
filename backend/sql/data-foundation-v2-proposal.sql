-- PROPOSTA PARA REVISÃO MANUAL — NÃO EXECUTAR NESTA ETAPA.
-- Baseada nos cinco workbooks oficiais auditados em modo somente leitura.
-- Alvo: Tencent TXSQL compatível com MySQL 8.0.30; validar o kernel exato,
-- CHECK/FK, collation, grants, capacidade e plano de backup antes de aprovar.
-- Não contém dados de produção, credenciais, migrations ou comandos de carga.
-- IDs binários são fornecidos pela aplicação; não dependem de UUID_TO_BIN().
-- Identidade/autorização residem em redes_paineis; actor_user_id não tem FK cruzada.

CREATE DATABASE IF NOT EXISTS redes_paineis_dados
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE redes_paineis_dados;

CREATE TABLE data_source_registry (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  description VARCHAR(500) NOT NULL,
  source_state ENUM('PENDING', 'ACTIVE', 'PAUSED', 'RETIRED') NOT NULL DEFAULT 'PENDING',
  history_policy ENUM('DAILY_REPLACE_DATES', 'SNAPSHOT_REPLACE_ALL', 'PENDING') NOT NULL DEFAULT 'PENDING',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- source_id values proposed for initial registry rows:
-- collection_monitoring, collection_rate, jt_monitoring, no_movement,
-- pdd_collection_failure, base_mapping_official.

CREATE TABLE source_contract_versions (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  contract_state ENUM('DISCOVERED', 'APPROVED', 'RETIRED') NOT NULL DEFAULT 'DISCOVERED',
  expected_sheet VARCHAR(160) NULL,
  header_row SMALLINT UNSIGNED NULL,
  expected_extension ENUM('xlsx') NOT NULL DEFAULT 'xlsx',
  grain_description VARCHAR(500) NULL,
  history_policy ENUM('DAILY_REPLACE_DATES', 'SNAPSHOT_REPLACE_ALL', 'PENDING') NOT NULL,
  contract_sha256 BINARY(32) NULL,
  approved_by_user_id BIGINT UNSIGNED NULL,
  approved_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (source_id, contract_version),
  CONSTRAINT fk_contract_source FOREIGN KEY (source_id)
    REFERENCES data_source_registry(source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE source_contract_columns (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  column_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ordinal_position SMALLINT UNSIGNED NOT NULL,
  source_header VARCHAR(191) NOT NULL,
  semantic_role VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  data_type ENUM('TEXT', 'BASE_CODE', 'DATE', 'DATETIME', 'INTEGER', 'DECIMAL', 'RATE') NOT NULL,
  is_required TINYINT(1) NOT NULL,
  is_nullable TINYINT(1) NOT NULL,
  validation_rules JSON NULL,
  PRIMARY KEY (source_id, contract_version, column_key),
  UNIQUE KEY uq_contract_column_order (source_id, contract_version, ordinal_position),
  CONSTRAINT fk_contract_column_version
    FOREIGN KEY (source_id, contract_version)
    REFERENCES source_contract_versions(source_id, contract_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE source_contract_aliases (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  normalized_alias VARCHAR(191) NOT NULL,
  column_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (source_id, contract_version, normalized_alias),
  KEY ix_contract_alias_column (source_id, contract_version, column_key),
  CONSTRAINT fk_contract_alias_column
    FOREIGN KEY (source_id, contract_version, column_key)
    REFERENCES source_contract_columns(source_id, contract_version, column_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE import_jobs (
  job_id BINARY(16) NOT NULL,
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  validation_map_version_id BINARY(16) NULL,
  reused_publication_id BINARY(16) NULL,
  submitted_by_user_id BIGINT UNSIGNED NOT NULL,
  job_state ENUM('RECEIVED', 'PARSING', 'INVALID', 'VALIDATED', 'PUBLISHED', 'REUSED', 'FAILED', 'ABORTED') NOT NULL,
  original_file_name VARCHAR(255) NOT NULL,
  stored_file_key VARCHAR(512) NOT NULL,
  file_size_bytes BIGINT UNSIGNED NOT NULL,
  file_sha256 BINARY(32) NOT NULL,
  input_row_count BIGINT UNSIGNED NULL,
  valid_row_count BIGINT UNSIGNED NULL,
  error_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  request_id VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  validated_at DATETIME(6) NULL,
  finished_at DATETIME(6) NULL,
  PRIMARY KEY (job_id),
  UNIQUE KEY uq_import_source_job_contract (source_id, job_id, contract_version),
  UNIQUE KEY uq_import_source_job_map (source_id, job_id, contract_version, validation_map_version_id),
  KEY ix_import_contract (source_id, contract_version),
  KEY ix_import_reused_publication (source_id, reused_publication_id),
  KEY ix_import_source_created (source_id, created_at),
  KEY ix_import_state_created (job_state, created_at),
  KEY ix_import_actor_created (submitted_by_user_id, created_at),
  KEY ix_import_validation_map (validation_map_version_id),
  CONSTRAINT fk_import_contract
    FOREIGN KEY (source_id, contract_version)
    REFERENCES source_contract_versions(source_id, contract_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE import_job_errors (
  error_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id BINARY(16) NOT NULL,
  source_row_no BIGINT UNSIGNED NULL,
  column_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_code VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  safe_context JSON NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (error_id),
  KEY ix_import_errors_job_row (job_id, source_row_no, error_id),
  CONSTRAINT fk_import_error_job FOREIGN KEY (job_id)
    REFERENCES import_jobs(job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE base_mapping_versions (
  map_version_id BINARY(16) NOT NULL,
  version_no BIGINT UNSIGNED NOT NULL,
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'base_mapping_official',
  source_job_id BINARY(16) NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  version_state ENUM('PREPARED', 'PUBLISHED', 'ABORTED') NOT NULL,
  original_file_name VARCHAR(255) NOT NULL,
  file_sha256 BINARY(32) NOT NULL,
  mapping_row_count BIGINT UNSIGNED NOT NULL,
  published_by_user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  published_at DATETIME(6) NULL,
  PRIMARY KEY (map_version_id),
  UNIQUE KEY uq_mapping_version_no (version_no),
  UNIQUE KEY uq_mapping_source_job (source_id, source_job_id),
  KEY ix_mapping_source_job_contract (source_id, source_job_id, contract_version),
  KEY ix_mapping_version_state_time (version_state, published_at),
  CONSTRAINT chk_mapping_official_source CHECK (source_id = 'base_mapping_official'),
  CONSTRAINT fk_mapping_source_job_contract
    FOREIGN KEY (source_id, source_job_id, contract_version)
    REFERENCES import_jobs(source_id, job_id, contract_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Added after base_mapping_versions to avoid a creation-order cycle. Mapping
-- import jobs leave validation_map_version_id NULL; dashboard jobs pin a map.
ALTER TABLE import_jobs
  ADD CONSTRAINT fk_import_validation_map
    FOREIGN KEY (validation_map_version_id)
    REFERENCES base_mapping_versions(map_version_id);

-- Only fields known from the previously declared official mapping contract are
-- modeled. The mapping workbook itself was not among the five audited files.
-- Codes remain text and use a NO PAD binary collation for exact comparisons.
CREATE TABLE base_mapping_entries (
  map_version_id BINARY(16) NOT NULL,
  base_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  base_name VARCHAR(191) NOT NULL,
  regional_name VARCHAR(64) NULL,
  uf_code VARCHAR(8) NULL,
  rm_region VARCHAR(96) NULL,
  rm_responsible VARCHAR(160) NULL,
  base_description VARCHAR(500) NULL,
  source_row_no BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (map_version_id, base_code),
  UNIQUE KEY uq_mapping_version_row (map_version_id, source_row_no),
  KEY ix_mapping_region_code (map_version_id, regional_name, base_code),
  KEY ix_mapping_base_name (map_version_id, base_name),
  CONSTRAINT chk_mapping_code_nonblank CHECK (CHAR_LENGTH(TRIM(base_code)) > 0),
  CONSTRAINT fk_mapping_entry_version FOREIGN KEY (map_version_id)
    REFERENCES base_mapping_versions(map_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- For the three source workbooks without a base code: this is a human-reviewed,
-- exact-string decision. No normalized/fuzzy name is used for authorization.
CREATE TABLE base_mapping_name_decisions (
  map_version_id BINARY(16) NOT NULL,
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_base_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  resolution_state ENUM('UNREVIEWED', 'LINKED', 'AMBIGUOUS', 'REJECTED') NOT NULL,
  target_base_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  reviewed_by_user_id BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(6) NULL,
  review_note VARCHAR(500) NULL,
  PRIMARY KEY (map_version_id, source_id, source_base_name),
  UNIQUE KEY uq_mapping_name_target
    (map_version_id, source_id, source_base_name, target_base_code),
  KEY ix_mapping_name_source (source_id),
  KEY ix_mapping_name_target (map_version_id, target_base_code),
  KEY ix_mapping_name_state (map_version_id, source_id, resolution_state),
  CONSTRAINT chk_mapping_name_source CHECK (
    source_id IN ('collection_monitoring', 'collection_rate', 'jt_monitoring')
  ),
  CONSTRAINT chk_mapping_name_target CHECK (
    (resolution_state = 'LINKED' AND target_base_code IS NOT NULL)
    OR (resolution_state <> 'LINKED' AND target_base_code IS NULL)
  ),
  CONSTRAINT chk_mapping_name_nonblank CHECK (CHAR_LENGTH(TRIM(source_base_name)) > 0),
  CONSTRAINT fk_mapping_name_version FOREIGN KEY (map_version_id)
    REFERENCES base_mapping_versions(map_version_id),
  CONSTRAINT fk_mapping_name_source FOREIGN KEY (source_id)
    REFERENCES data_source_registry(source_id),
  CONSTRAINT fk_mapping_name_target FOREIGN KEY (map_version_id, target_base_code)
    REFERENCES base_mapping_entries(map_version_id, base_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE base_mapping_current (
  current_key ENUM('OFFICIAL') NOT NULL DEFAULT 'OFFICIAL',
  map_version_id BINARY(16) NOT NULL,
  changed_by_user_id BIGINT UNSIGNED NOT NULL,
  changed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (current_key),
  KEY ix_mapping_current_version (map_version_id),
  CONSTRAINT fk_mapping_current_version FOREIGN KEY (map_version_id)
    REFERENCES base_mapping_versions(map_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE source_publications (
  publication_id BINARY(16) NOT NULL,
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_no BIGINT UNSIGNED NOT NULL,
  job_id BINARY(16) NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  map_version_id BINARY(16) NOT NULL,
  file_sha256 BINARY(32) NOT NULL,
  publication_state ENUM('PREPARED', 'PUBLISHED', 'FAILED', 'ABORTED') NOT NULL,
  history_policy ENUM('DAILY_REPLACE_DATES', 'SNAPSHOT_REPLACE_ALL') NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  published_at DATETIME(6) NULL,
  period_start DATE NULL,
  period_end DATE NULL,
  snapshot_as_of DATETIME(6) NULL,
  row_count BIGINT UNSIGNED NOT NULL,
  mapped_row_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  unmapped_row_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  missing_identifier_row_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ambiguous_row_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (publication_id),
  UNIQUE KEY uq_publication_source_id (source_id, publication_id),
  UNIQUE KEY uq_publication_source_map (source_id, publication_id, map_version_id),
  UNIQUE KEY uq_publication_version (source_id, version_no),
  UNIQUE KEY uq_publication_source_job (source_id, job_id),
  UNIQUE KEY uq_publication_fingerprint
    (source_id, contract_version, map_version_id, file_sha256),
  KEY ix_publication_job_map (source_id, job_id, contract_version, map_version_id),
  KEY ix_publication_map_version (map_version_id),
  KEY ix_publication_source_created (source_id, created_at),
  KEY ix_publication_source_state (source_id, publication_state, created_at),
  CONSTRAINT fk_publication_source FOREIGN KEY (source_id)
    REFERENCES data_source_registry(source_id),
  CONSTRAINT fk_publication_contract FOREIGN KEY (source_id, contract_version)
    REFERENCES source_contract_versions(source_id, contract_version),
  CONSTRAINT fk_publication_job_map
    FOREIGN KEY (source_id, job_id, contract_version, map_version_id)
    REFERENCES import_jobs(source_id, job_id, contract_version, validation_map_version_id),
  CONSTRAINT fk_publication_map_version FOREIGN KEY (map_version_id)
    REFERENCES base_mapping_versions(map_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE import_jobs
  ADD CONSTRAINT fk_import_reused_publication
    FOREIGN KEY (source_id, reused_publication_id)
    REFERENCES source_publications(source_id, publication_id);

CREATE TABLE source_publication_dates (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  publication_id BINARY(16) NOT NULL,
  data_date DATE NOT NULL,
  row_count BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (source_id, publication_id, data_date),
  KEY ix_publication_date_lookup (source_id, data_date, publication_id),
  CONSTRAINT fk_publication_date_source
    FOREIGN KEY (source_id, publication_id)
    REFERENCES source_publications(source_id, publication_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE source_daily_head (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  data_date DATE NOT NULL,
  publication_id BINARY(16) NOT NULL,
  changed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (source_id, data_date),
  KEY ix_daily_head_publication (source_id, publication_id, data_date),
  CONSTRAINT chk_daily_head_source CHECK (
    source_id IN ('collection_monitoring', 'collection_rate', 'jt_monitoring', 'pdd_collection_failure')
  ),
  CONSTRAINT fk_daily_head_publication_date
    FOREIGN KEY (source_id, publication_id, data_date)
    REFERENCES source_publication_dates(source_id, publication_id, data_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE source_snapshot_head (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  publication_id BINARY(16) NOT NULL,
  changed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (source_id),
  KEY ix_snapshot_head_publication (source_id, publication_id),
  CONSTRAINT chk_snapshot_head_source CHECK (source_id = 'no_movement'),
  CONSTRAINT fk_snapshot_head_publication
    FOREIGN KEY (source_id, publication_id)
    REFERENCES source_publications(source_id, publication_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE data_audit_events (
  audit_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id BIGINT UNSIGNED NULL,
  action_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_id BINARY(16) NULL,
  request_id VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NULL,
  event_context JSON NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (audit_id),
  KEY ix_data_audit_actor_time (actor_user_id, created_at),
  KEY ix_data_audit_object_time (object_type, created_at),
  KEY ix_data_audit_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Each fact has its own official columns. source_row_no is the physical Excel
-- row number; therefore identical input rows remain distinguishable/preserved.
-- resolved_base_code and map_version_id are technical provenance fields.

CREATE TABLE fact_collection_monitoring (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'collection_monitoring',
  publication_id BINARY(16) NOT NULL,
  map_version_id BINARY(16) NOT NULL,
  source_row_no BIGINT UNSIGNED NOT NULL,
  data_date DATE NOT NULL,
  reported_region VARCHAR(64) NULL,
  source_base_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  seller_collection_rate DECIMAL(38,24) NULL,
  collection_visit_rate DECIMAL(38,24) NULL,
  expected_dropoff_collection BIGINT UNSIGNED NOT NULL,
  expected_pickup_collection BIGINT UNSIGNED NOT NULL,
  awaiting_collection_dropoff BIGINT UNSIGNED NOT NULL,
  awaiting_collection_pickup BIGINT UNSIGNED NOT NULL,
  collected_current BIGINT UNSIGNED NOT NULL,
  received_at_base_current BIGINT UNSIGNED NOT NULL,
  dispatched_by_base BIGINT UNSIGNED NOT NULL,
  in_transit_from_base BIGINT UNSIGNED NOT NULL,
  branch_outbound_transit_center BIGINT UNSIGNED NOT NULL,
  branch_outbound_transit_sorting BIGINT UNSIGNED NOT NULL,
  arrived_at_sorting_center BIGINT UNSIGNED NOT NULL,
  dispatched_by_sorting_center BIGINT UNSIGNED NOT NULL,
  sorting_outbound_transit BIGINT UNSIGNED NOT NULL,
  arrived_at_sc BIGINT UNSIGNED NOT NULL,
  package_created_by_base BIGINT UNSIGNED NOT NULL,
  processed_problem_items BIGINT UNSIGNED NOT NULL,
  unprocessed_problem_items BIGINT UNSIGNED NOT NULL,
  resolved_base_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  mapping_resolution ENUM('NAME_APPROVED', 'UNMAPPED', 'MISSING_IDENTIFIER', 'AMBIGUOUS') NOT NULL,
  PRIMARY KEY (publication_id, source_row_no),
  KEY ix_collection_monitor_publication_map (source_id, publication_id, map_version_id),
  KEY ix_collection_monitor_publication_date (source_id, publication_id, data_date),
  KEY ix_collection_monitor_mapping (map_version_id, resolved_base_code),
  KEY ix_collection_monitor_name_mapping
    (map_version_id, source_id, source_base_name, resolved_base_code),
  KEY ix_collection_monitor_date_base (data_date, resolved_base_code, publication_id),
  KEY ix_collection_monitor_publication_base (publication_id, resolved_base_code),
  KEY ix_collection_monitor_resolution (publication_id, mapping_resolution),
  CONSTRAINT chk_collection_monitor_source CHECK (source_id = 'collection_monitoring'),
  CONSTRAINT chk_collection_monitor_resolution CHECK (
    (mapping_resolution = 'NAME_APPROVED' AND source_base_name IS NOT NULL
      AND CHAR_LENGTH(TRIM(source_base_name)) > 0 AND resolved_base_code IS NOT NULL)
    OR (mapping_resolution = 'MISSING_IDENTIFIER'
      AND (source_base_name IS NULL OR CHAR_LENGTH(TRIM(source_base_name)) = 0)
      AND resolved_base_code IS NULL)
    OR (mapping_resolution IN ('UNMAPPED', 'AMBIGUOUS') AND source_base_name IS NOT NULL
      AND CHAR_LENGTH(TRIM(source_base_name)) > 0 AND resolved_base_code IS NULL)
  ),
  CONSTRAINT fk_collection_monitor_publication
    FOREIGN KEY (source_id, publication_id, map_version_id)
    REFERENCES source_publications(source_id, publication_id, map_version_id),
  CONSTRAINT fk_collection_monitor_publication_date
    FOREIGN KEY (source_id, publication_id, data_date)
    REFERENCES source_publication_dates(source_id, publication_id, data_date),
  CONSTRAINT fk_collection_monitor_mapping
    FOREIGN KEY (map_version_id, resolved_base_code)
    REFERENCES base_mapping_entries(map_version_id, base_code),
  CONSTRAINT fk_collection_monitor_name_mapping
    FOREIGN KEY (map_version_id, source_id, source_base_name, resolved_base_code)
    REFERENCES base_mapping_name_decisions(map_version_id, source_id, source_base_name, target_base_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fact_collection_rate (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'collection_rate',
  publication_id BINARY(16) NOT NULL,
  map_version_id BINARY(16) NOT NULL,
  source_row_no BIGINT UNSIGNED NOT NULL,
  deadline_at DATETIME(6) NOT NULL,
  data_date DATE GENERATED ALWAYS AS (DATE(deadline_at)) STORED,
  reported_region VARCHAR(64) NULL,
  source_base_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  order_origin VARCHAR(96) NOT NULL,
  product_type VARCHAR(64) NOT NULL,
  order_quantity BIGINT UNSIGNED NOT NULL,
  quantity_to_collect BIGINT UNSIGNED NOT NULL,
  cancelled_quantity BIGINT UNSIGNED NOT NULL,
  collection_rate DECIMAL(38,24) NOT NULL,
  collected_quantity BIGINT UNSIGNED NOT NULL,
  not_collected_quantity BIGINT UNSIGNED NOT NULL,
  not_collected_on_time_quantity BIGINT UNSIGNED NOT NULL,
  collected_on_time_quantity BIGINT UNSIGNED NOT NULL,
  collection_on_time_rate DECIMAL(38,24) NOT NULL,
  collected_plus_attempts_quantity BIGINT UNSIGNED NOT NULL,
  collection_rate_with_attempts DECIMAL(38,24) NOT NULL,
  average_collection_delay_hours DECIMAL(38,24) NULL,
  processed_problem_items BIGINT UNSIGNED NOT NULL,
  unprocessed_problem_items BIGINT UNSIGNED NOT NULL,
  seller_collection_rate DECIMAL(38,24) NOT NULL,
  expected_merchant_visits BIGINT UNSIGNED NOT NULL,
  merchants_not_visited BIGINT UNSIGNED NOT NULL,
  resolved_base_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  mapping_resolution ENUM('NAME_APPROVED', 'UNMAPPED', 'MISSING_IDENTIFIER', 'AMBIGUOUS') NOT NULL,
  PRIMARY KEY (publication_id, source_row_no),
  KEY ix_collection_rate_publication_map (source_id, publication_id, map_version_id),
  KEY ix_collection_rate_publication_date (source_id, publication_id, data_date),
  KEY ix_collection_rate_mapping (map_version_id, resolved_base_code),
  KEY ix_collection_rate_name_mapping
    (map_version_id, source_id, source_base_name, resolved_base_code),
  KEY ix_collection_rate_date_base (data_date, resolved_base_code, publication_id),
  KEY ix_collection_rate_publication_base (publication_id, resolved_base_code),
  KEY ix_collection_rate_origin_product (data_date, order_origin, product_type),
  KEY ix_collection_rate_resolution (publication_id, mapping_resolution),
  CONSTRAINT chk_collection_rate_source CHECK (source_id = 'collection_rate'),
  CONSTRAINT chk_collection_rate_resolution CHECK (
    (mapping_resolution = 'NAME_APPROVED' AND source_base_name IS NOT NULL
      AND CHAR_LENGTH(TRIM(source_base_name)) > 0 AND resolved_base_code IS NOT NULL)
    OR (mapping_resolution = 'MISSING_IDENTIFIER'
      AND (source_base_name IS NULL OR CHAR_LENGTH(TRIM(source_base_name)) = 0)
      AND resolved_base_code IS NULL)
    OR (mapping_resolution IN ('UNMAPPED', 'AMBIGUOUS') AND source_base_name IS NOT NULL
      AND CHAR_LENGTH(TRIM(source_base_name)) > 0 AND resolved_base_code IS NULL)
  ),
  CONSTRAINT fk_collection_rate_publication
    FOREIGN KEY (source_id, publication_id, map_version_id)
    REFERENCES source_publications(source_id, publication_id, map_version_id),
  CONSTRAINT fk_collection_rate_publication_date
    FOREIGN KEY (source_id, publication_id, data_date)
    REFERENCES source_publication_dates(source_id, publication_id, data_date),
  CONSTRAINT fk_collection_rate_mapping
    FOREIGN KEY (map_version_id, resolved_base_code)
    REFERENCES base_mapping_entries(map_version_id, base_code),
  CONSTRAINT fk_collection_rate_name_mapping
    FOREIGN KEY (map_version_id, source_id, source_base_name, resolved_base_code)
    REFERENCES base_mapping_name_decisions(map_version_id, source_id, source_base_name, target_base_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fact_jt_monitoring (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'jt_monitoring',
  publication_id BINARY(16) NOT NULL,
  map_version_id BINARY(16) NOT NULL,
  source_row_no BIGINT UNSIGNED NOT NULL,
  data_date DATE NOT NULL,
  reported_region VARCHAR(64) NULL,
  source_base_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  customer_name VARCHAR(191) NOT NULL,
  store_name VARCHAR(191) NOT NULL,
  seller_id VARCHAR(64) NOT NULL,
  assigned_driver VARCHAR(191) NOT NULL,
  order_origin VARCHAR(96) NOT NULL,
  awaiting_collection BIGINT UNSIGNED NOT NULL,
  received_at_dropoff BIGINT UNSIGNED NOT NULL,
  collected BIGINT UNSIGNED NOT NULL,
  received BIGINT UNSIGNED NOT NULL,
  received_at_base BIGINT UNSIGNED NOT NULL,
  in_base_dispatch_flow BIGINT UNSIGNED NOT NULL,
  arrived_at_sc BIGINT UNSIGNED NOT NULL,
  resolved_base_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  mapping_resolution ENUM('NAME_APPROVED', 'UNMAPPED', 'MISSING_IDENTIFIER', 'AMBIGUOUS') NOT NULL,
  PRIMARY KEY (publication_id, source_row_no),
  KEY ix_jt_monitor_publication_map (source_id, publication_id, map_version_id),
  KEY ix_jt_monitor_publication_date (source_id, publication_id, data_date),
  KEY ix_jt_monitor_mapping (map_version_id, resolved_base_code),
  KEY ix_jt_monitor_name_mapping
    (map_version_id, source_id, source_base_name, resolved_base_code),
  KEY ix_jt_monitor_date_base (data_date, resolved_base_code, publication_id),
  KEY ix_jt_monitor_publication_base (publication_id, resolved_base_code),
  KEY ix_jt_monitor_seller_date (seller_id, data_date),
  KEY ix_jt_monitor_resolution (publication_id, mapping_resolution),
  CONSTRAINT chk_jt_monitor_source CHECK (source_id = 'jt_monitoring'),
  CONSTRAINT chk_jt_monitor_resolution CHECK (
    (mapping_resolution = 'NAME_APPROVED' AND source_base_name IS NOT NULL
      AND CHAR_LENGTH(TRIM(source_base_name)) > 0 AND resolved_base_code IS NOT NULL)
    OR (mapping_resolution = 'MISSING_IDENTIFIER'
      AND (source_base_name IS NULL OR CHAR_LENGTH(TRIM(source_base_name)) = 0)
      AND resolved_base_code IS NULL)
    OR (mapping_resolution IN ('UNMAPPED', 'AMBIGUOUS') AND source_base_name IS NOT NULL
      AND CHAR_LENGTH(TRIM(source_base_name)) > 0 AND resolved_base_code IS NULL)
  ),
  CONSTRAINT fk_jt_monitor_publication
    FOREIGN KEY (source_id, publication_id, map_version_id)
    REFERENCES source_publications(source_id, publication_id, map_version_id),
  CONSTRAINT fk_jt_monitor_publication_date
    FOREIGN KEY (source_id, publication_id, data_date)
    REFERENCES source_publication_dates(source_id, publication_id, data_date),
  CONSTRAINT fk_jt_monitor_mapping
    FOREIGN KEY (map_version_id, resolved_base_code)
    REFERENCES base_mapping_entries(map_version_id, base_code),
  CONSTRAINT fk_jt_monitor_name_mapping
    FOREIGN KEY (map_version_id, source_id, source_base_name, resolved_base_code)
    REFERENCES base_mapping_name_decisions(map_version_id, source_id, source_base_name, target_base_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fact_no_movement_snapshot (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'no_movement',
  publication_id BINARY(16) NOT NULL,
  map_version_id BINARY(16) NOT NULL,
  source_row_no BIGINT UNSIGNED NOT NULL,
  reported_region VARCHAR(64) NOT NULL,
  source_base_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  source_base_name VARCHAR(191) NOT NULL,
  stopped_orders BIGINT UNSIGNED NOT NULL,
  orders_in_transit BIGINT UNSIGNED NOT NULL,
  stopped_over_1_day BIGINT UNSIGNED NOT NULL,
  stopped_over_2_days BIGINT UNSIGNED NOT NULL,
  stopped_over_3_days BIGINT UNSIGNED NOT NULL,
  stopped_over_4_days BIGINT UNSIGNED NOT NULL,
  stopped_over_5_days BIGINT UNSIGNED NOT NULL,
  stopped_over_6_days BIGINT UNSIGNED NOT NULL,
  stopped_over_7_days BIGINT UNSIGNED NOT NULL,
  stopped_over_10_days BIGINT UNSIGNED NOT NULL,
  stopped_over_14_days BIGINT UNSIGNED NOT NULL,
  stopped_over_30_days BIGINT UNSIGNED NOT NULL,
  last_operation_at DATETIME(6) NOT NULL,
  stopped_14_plus_days_rate DECIMAL(38,24) NOT NULL,
  stopped_30_plus_days_rate DECIMAL(38,24) NOT NULL,
  resolved_base_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  mapping_resolution ENUM('CODE_MATCH', 'UNMAPPED') NOT NULL,
  PRIMARY KEY (publication_id, source_row_no),
  KEY ix_no_movement_publication_map (source_id, publication_id, map_version_id),
  KEY ix_no_movement_mapping (map_version_id, resolved_base_code),
  KEY ix_no_movement_publication_base (publication_id, resolved_base_code),
  KEY ix_no_movement_source_code (source_base_code),
  KEY ix_no_movement_resolution (publication_id, mapping_resolution),
  CONSTRAINT chk_no_movement_source CHECK (source_id = 'no_movement'),
  CONSTRAINT chk_no_movement_source_code_nonblank CHECK (CHAR_LENGTH(TRIM(source_base_code)) > 0),
  CONSTRAINT chk_no_movement_resolution CHECK (
    (mapping_resolution = 'CODE_MATCH' AND resolved_base_code = source_base_code)
    OR (mapping_resolution = 'UNMAPPED' AND resolved_base_code IS NULL)
  ),
  CONSTRAINT fk_no_movement_publication
    FOREIGN KEY (source_id, publication_id, map_version_id)
    REFERENCES source_publications(source_id, publication_id, map_version_id),
  CONSTRAINT fk_no_movement_mapping
    FOREIGN KEY (map_version_id, resolved_base_code)
    REFERENCES base_mapping_entries(map_version_id, base_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fact_pdd_collection_failure (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pdd_collection_failure',
  publication_id BINARY(16) NOT NULL,
  map_version_id BINARY(16) NOT NULL,
  source_row_no BIGINT UNSIGNED NOT NULL,
  data_date DATE NOT NULL,
  source_base_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  source_base_name VARCHAR(191) NOT NULL,
  source_region_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  reported_region VARCHAR(64) NOT NULL,
  orders_to_scan BIGINT UNSIGNED NOT NULL,
  orders_unscanned_at_receipt BIGINT UNSIGNED NOT NULL,
  rate_unscanned_at_receipt DECIMAL(38,24) NOT NULL,
  orders_unscanned_for_delivery BIGINT UNSIGNED NOT NULL,
  rate_unscanned_for_delivery DECIMAL(38,24) NOT NULL,
  overall_unscanned_rate DECIMAL(38,24) NOT NULL,
  resolved_base_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  mapping_resolution ENUM('CODE_MATCH', 'UNMAPPED') NOT NULL,
  PRIMARY KEY (publication_id, source_row_no),
  KEY ix_pdd_failure_publication_map (source_id, publication_id, map_version_id),
  KEY ix_pdd_failure_publication_date (source_id, publication_id, data_date),
  KEY ix_pdd_failure_mapping (map_version_id, resolved_base_code),
  KEY ix_pdd_failure_date_base (data_date, resolved_base_code, publication_id),
  KEY ix_pdd_failure_publication_base (publication_id, resolved_base_code),
  KEY ix_pdd_failure_resolution (publication_id, mapping_resolution),
  CONSTRAINT chk_pdd_failure_source CHECK (source_id = 'pdd_collection_failure'),
  CONSTRAINT chk_pdd_failure_source_code_nonblank CHECK (CHAR_LENGTH(TRIM(source_base_code)) > 0),
  CONSTRAINT chk_pdd_failure_resolution CHECK (
    (mapping_resolution = 'CODE_MATCH' AND resolved_base_code = source_base_code)
    OR (mapping_resolution = 'UNMAPPED' AND resolved_base_code IS NULL)
  ),
  CONSTRAINT fk_pdd_failure_publication
    FOREIGN KEY (source_id, publication_id, map_version_id)
    REFERENCES source_publications(source_id, publication_id, map_version_id),
  CONSTRAINT fk_pdd_failure_publication_date
    FOREIGN KEY (source_id, publication_id, data_date)
    REFERENCES source_publication_dates(source_id, publication_id, data_date),
  CONSTRAINT fk_pdd_failure_mapping
    FOREIGN KEY (map_version_id, resolved_base_code)
    REFERENCES base_mapping_entries(map_version_id, base_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- No seed INSERTs are included. Registry/contracts, official map rows and
-- initial publications require separate review/approval before manual loading.
