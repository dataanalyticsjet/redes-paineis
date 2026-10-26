-- Manual review only. Do not execute automatically.
-- This schema gives the Windows publisher its own auditable identity and
-- leaves all existing platform-user ownership intact.

CREATE TABLE data_service_principals (
  service_principal_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  revoked_at DATETIME(6) NULL,
  PRIMARY KEY (service_principal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE data_service_principal_credentials (
  credential_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_principal_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_sha256 BINARY(32) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at DATETIME(6) NULL,
  revoked_at DATETIME(6) NULL,
  last_used_at DATETIME(6) NULL,
  PRIMARY KEY (credential_id),
  UNIQUE KEY uq_service_credential_hash (token_sha256),
  KEY ix_service_credential_principal (service_principal_id, is_active, expires_at),
  CONSTRAINT fk_service_credential_principal
    FOREIGN KEY (service_principal_id) REFERENCES data_service_principals(service_principal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE data_service_principal_contract_scopes (
  service_principal_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (service_principal_id, source_id, contract_version),
  CONSTRAINT fk_service_scope_principal
    FOREIGN KEY (service_principal_id) REFERENCES data_service_principals(service_principal_id),
  CONSTRAINT fk_service_scope_contract
    FOREIGN KEY (source_id, contract_version)
    REFERENCES source_contract_versions(source_id, contract_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE import_jobs
  MODIFY submitted_by_user_id BIGINT UNSIGNED NULL,
  ADD COLUMN submitted_by_service_principal_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL
    AFTER submitted_by_user_id,
  ADD CONSTRAINT fk_import_job_service_principal
    FOREIGN KEY (submitted_by_service_principal_id)
    REFERENCES data_service_principals(service_principal_id),
  ADD CONSTRAINT chk_import_job_single_actor
    CHECK ((submitted_by_user_id IS NULL) <> (submitted_by_service_principal_id IS NULL));

ALTER TABLE data_audit_events
  ADD COLUMN actor_service_principal_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL
    AFTER actor_user_id,
  ADD KEY ix_data_audit_service_actor_time (actor_service_principal_id, created_at),
  ADD CONSTRAINT fk_data_audit_service_actor
    FOREIGN KEY (actor_service_principal_id)
    REFERENCES data_service_principals(service_principal_id);

-- Provisioning/revocation is intentionally separate from DDL. Generate a
-- random credential outside SQL, store only SHA-256 here, and install the
-- raw value in Windows Credential Manager. Grant only these four scopes after
-- each contract is confirmed APPROVED:
-- no_movement V2, pdd_collection_failure V2, collection_rate V3,
-- collection_monitoring V2.
-- Rotation: insert a second credential hash, verify it, then revoke the old
-- credential by setting is_active=0 and revoked_at=CURRENT_TIMESTAMP(6).

-- Provisioning template after the DDL is reviewed and the four contract rows
-- are confirmed APPROVED. Generate a high-entropy token out of band, keep its
-- raw value only in Windows Credential Manager, and bind these parameters in
-- the controlled SQL client; never paste the raw token into this script.
-- INSERT INTO data_service_principals (service_principal_id, display_name)
-- VALUES ('windows-newbi-publisher', 'NEW BI Windows bot publisher');
-- INSERT INTO data_service_principal_credentials
--   (credential_id, service_principal_id, token_sha256, expires_at)
-- VALUES ('windows-publisher-key-2026-01', 'windows-newbi-publisher',
--         UNHEX(:sha256_hex_of_random_token), :expiry_datetime_or_null);
-- INSERT INTO data_service_principal_contract_scopes
--   (service_principal_id, source_id, contract_version)
-- VALUES
--   ('windows-newbi-publisher', 'no_movement', 2),
--   ('windows-newbi-publisher', 'pdd_collection_failure', 2),
--   ('windows-newbi-publisher', 'collection_rate', 3),
--   ('windows-newbi-publisher', 'collection_monitoring', 2);

-- Post-validation (read-only): verify principals, active hash-only credential,
-- exact scopes, nullable user actor plus service actor columns, and audit FK.
SELECT service_principal_id, display_name, is_active, revoked_at
FROM data_service_principals;

SELECT credential_id, service_principal_id, is_active, expires_at, revoked_at, last_used_at,
       CASE WHEN token_sha256 IS NULL THEN 'MISSING' ELSE 'HASH_PRESENT' END AS credential_storage
FROM data_service_principal_credentials;

SELECT service_principal_id, source_id, contract_version, is_active
FROM data_service_principal_contract_scopes
ORDER BY source_id, contract_version;

SELECT column_name, is_nullable, column_type
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'import_jobs'
  AND column_name IN ('submitted_by_user_id', 'submitted_by_service_principal_id');

SELECT column_name, is_nullable, column_type
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'data_audit_events'
  AND column_name IN ('actor_user_id', 'actor_service_principal_id');
