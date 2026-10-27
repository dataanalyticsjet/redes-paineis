-- Schema reference for manual review only. The table was created manually in
-- TencentDB; do not execute this file again or through application startup/migrations.
-- Real Feishu delivery remains disabled by default.

CREATE TABLE no_movement_feishu_reports (
  report_id BINARY(16) NOT NULL,
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'no_movement',
  publication_id BINARY(16) NOT NULL,
  publication_version BIGINT UNSIGNED NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  map_version_id BINARY(16) NOT NULL,
  region_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  recipient_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  recipient_email VARCHAR(254) NOT NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  analysis_text MEDIUMTEXT NOT NULL,
  interpretation TEXT NOT NULL,
  comments TEXT NOT NULL,
  recommendations TEXT NOT NULL,
  record_count BIGINT UNSIGNED NOT NULL,
  total_stopped_orders BIGINT UNSIGNED NOT NULL,
  dataset_sha256 BINARY(32) NOT NULL,
  rules_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  report_state ENUM('PREPARED','CONFIRMED','SENDING','PARTIAL','PENDING','SENT','FAILED','SUPERSEDED') NOT NULL,
  delivery_context JSON NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  confirmed_at DATETIME(6) NULL,
  sent_at DATETIME(6) NULL,
  PRIMARY KEY (report_id),
  KEY ix_nm_feishu_report_actor_state (actor_user_id, report_state, created_at),
  KEY ix_nm_feishu_report_publication (publication_id, region_key, recipient_key, report_state),
  CONSTRAINT chk_nm_feishu_report_source CHECK (source_id = 'no_movement'),
  CONSTRAINT chk_nm_feishu_report_contract CHECK (contract_version = 2),
  CONSTRAINT fk_nm_feishu_report_publication
    FOREIGN KEY (source_id, publication_id, map_version_id)
    REFERENCES source_publications(source_id, publication_id, map_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Post-validation (read-only): confirm the table and columns before enabling code.
SHOW CREATE TABLE no_movement_feishu_reports;
SELECT COUNT(*) AS report_rows FROM no_movement_feishu_reports;
