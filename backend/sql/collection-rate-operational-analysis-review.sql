-- Manual-review SQL only. Do not run automatically or as an application migration.
-- One immutable, bilingual operational analysis per newly published collection_rate publication/rules version.
USE redes_paineis_dados;

-- Pre-validation: do not execute the DDL unless the unique-key column sequence is exact.
-- Verify a unique index whose ordered columns are exactly source_id, publication_id, map_version_id exists.
-- Do not infer an index name from this report; compare the returned sequence with the FK below.
SELECT index_name, non_unique, seq_in_index, column_name
FROM information_schema.statistics
WHERE table_schema = DATABASE()
  AND table_name = 'source_publications'
  AND non_unique = 0
ORDER BY index_name, seq_in_index;

-- Confirm the referenced columns and V3 fields/types before manually running the following CREATE TABLE.
SELECT table_name, column_name, column_type, is_nullable
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND ((table_name = 'source_publications' AND column_name IN ('source_id','publication_id','map_version_id'))
    OR (table_name = 'fact_collection_rate_v3' AND column_name IN ('publication_id','map_version_id','deadline_at','collected_quantity','quantity_to_collect','resolved_base_code','mapping_resolution')))
ORDER BY table_name, ordinal_position;

-- DDL block: execute manually only after reviewing pre-validation output.
CREATE TABLE collection_rate_operational_analyses (
  analysis_id BINARY(16) NOT NULL,
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'collection_rate',
  publication_id BINARY(16) NOT NULL,
  publication_version BIGINT UNSIGNED NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  map_version_id BINARY(16) NOT NULL,
  operational_date DATE NULL,
  analysis_state ENUM('PENDING','PROCESSING','READY','FAILED') NOT NULL,
  national_collected_quantity BIGINT UNSIGNED NULL,
  national_quantity_to_collect BIGINT UNSIGNED NULL,
  national_rate DECIMAL(38,24) NULL,
  target_rate DECIMAL(5,4) NOT NULL DEFAULT 0.9800,
  results_json JSON NULL,
  message_pt_zh LONGTEXT NULL,
  rules_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  error_code VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NULL,
  generated_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (analysis_id),
  UNIQUE KEY uq_collection_rate_analysis_publication_rules (publication_id, rules_version),
  KEY ix_collection_rate_analysis_latest (publication_version, created_at),
  KEY ix_collection_rate_analysis_state (analysis_state, updated_at),
  CONSTRAINT chk_collection_rate_analysis_source_contract
    CHECK (source_id = 'collection_rate' AND contract_version = 3),
  CONSTRAINT fk_collection_rate_analysis_publication
    FOREIGN KEY (source_id, publication_id, map_version_id)
    REFERENCES source_publications(source_id, publication_id, map_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Post-validation for a separately approved manual execution.
SHOW CREATE TABLE collection_rate_operational_analyses;
SELECT COUNT(*) AS existing_analysis_rows FROM collection_rate_operational_analyses;
