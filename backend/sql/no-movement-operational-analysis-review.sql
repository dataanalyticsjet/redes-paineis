-- Manual-review DDL only. Do not execute automatically.
-- Retains one deterministic bilingual analysis per newly published no_movement snapshot.
CREATE TABLE no_movement_operational_analyses (
  analysis_id BINARY(16) NOT NULL,
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'no_movement',
  publication_id BINARY(16) NOT NULL,
  publication_version BIGINT UNSIGNED NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  map_version_id BINARY(16) NOT NULL,
  operational_date DATE NOT NULL,
  export_time_local DATETIME(6) NULL,
  export_time_zone VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'America/Sao_Paulo',
  export_time_source ENUM('BOT_METADATA','ADMIN_CONFIRMATION','UNKNOWN') NOT NULL,
  confirmation_user_id BIGINT UNSIGNED NULL,
  confirmed_at DATETIME(6) NULL,
  analysis_state ENUM('PENDING','PROCESSING','READY','FAILED') NOT NULL,
  total_stopped_orders BIGINT UNSIGNED NULL,
  rules_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  message_pt_zh LONGTEXT NULL,
  error_code VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NULL,
  generated_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (analysis_id),
  UNIQUE KEY uq_no_movement_analysis_publication_rules (publication_id, rules_version),
  KEY ix_no_movement_analysis_latest (operational_date, export_time_local, publication_version),
  KEY ix_no_movement_analysis_state (analysis_state, updated_at),
  CONSTRAINT chk_no_movement_analysis_source CHECK (source_id = 'no_movement'),
  CONSTRAINT fk_no_movement_analysis_publication
    FOREIGN KEY (source_id, publication_id, map_version_id)
    REFERENCES source_publications(source_id, publication_id, map_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- confirmation_user_id is an audit reference to the authenticated platform user id;
-- it intentionally has no FK because the Data Foundation database is separate.
