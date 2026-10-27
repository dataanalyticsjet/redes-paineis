-- Manual schema review only. Do not execute automatically and do not execute
-- this script as part of deployment. No production database is accessed here.
-- Supports only collection_rate V3 and pdd_collection_failure V2.

CREATE TABLE operational_feishu_reports (
  report_id BINARY(16) NOT NULL,
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  publication_id BINARY(16) NOT NULL,
  publication_version BIGINT UNSIGNED NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  map_version_id BINARY(16) NOT NULL,
  region_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  recipient_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  recipient_email VARCHAR(254) NOT NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  analysis_text MEDIUMTEXT NOT NULL,
  record_count BIGINT UNSIGNED NOT NULL,
  dataset_sha256 BINARY(32) NOT NULL,
  rules_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  report_state ENUM('PREPARED','CONFIRMED','SENDING','PARTIAL','PENDING','SENT','FAILED','SUPERSEDED') NOT NULL,
  delivery_context JSON NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  confirmed_at DATETIME(6) NULL,
  sent_at DATETIME(6) NULL,
  PRIMARY KEY (report_id),
  KEY ix_operational_feishu_report_scope (source_id, publication_id, region_key, recipient_key, rules_version, report_state),
  KEY ix_operational_feishu_report_actor (actor_user_id, report_state, created_at),
  CONSTRAINT chk_operational_feishu_report_source_contract CHECK (
    (source_id = 'collection_rate' AND contract_version = 3) OR
    (source_id = 'pdd_collection_failure' AND contract_version = 2)
  ),
  CONSTRAINT fk_operational_feishu_report_publication
    FOREIGN KEY (source_id, publication_id, map_version_id)
    REFERENCES source_publications(source_id, publication_id, map_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Post-validation statements for a manually approved future installation:
SHOW CREATE TABLE operational_feishu_reports;
SELECT COUNT(*) AS report_rows FROM operational_feishu_reports;
