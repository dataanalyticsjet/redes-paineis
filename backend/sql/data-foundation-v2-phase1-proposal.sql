-- RASCUNHO HISTÓRICO SUPERSEDIDO — NÃO EXECUTAR.
-- A arquitetura completa baseada nos cinco Excels oficiais está em
-- backend/sql/data-foundation-v2-proposal.sql. Este arquivo permanece apenas
-- como registro do piloto anterior de Sem Movimentação.
-- Revisão manual antes de qualquer uso. Sem seeds, migrations ou conexão.
-- Alvo declarado: Tencent TXSQL compatível com MySQL 8.0.30, InnoDB.
-- Confirmar versão de kernel, grants, charset, limites e capacidade em ambiente
-- descartável de teste antes de aprovar. Esta proposta não declara compatibilidade
-- com MySQL 5.7: usa CHECK para preservar a fonte exclusiva do fato movement.
-- Não contém dados operacionais, credenciais, nem comandos de alteração destrutiva.
-- ADMIN é papel de escrita, não escopo nacional. A autorização de leitura e a
-- capability nacional ficam no serviço de aplicação, fora deste schema.
-- IDs UUID são entregues pelo backend em BINARY(16); não depende de UUID_TO_BIN.

CREATE DATABASE IF NOT EXISTS redes_paineis_dados
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE redes_paineis_dados;

CREATE TABLE data_source_registry (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  description VARCHAR(500) NOT NULL,
  source_state ENUM('PENDING', 'ACTIVE', 'PAUSED', 'RETIRED') NOT NULL DEFAULT 'PENDING',
  history_policy ENUM('SNAPSHOT_REPLACE_ALL', 'PENDING') NOT NULL DEFAULT 'PENDING',
  last_version_no BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE source_contract_versions (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  contract_state ENUM('DISCOVERED', 'APPROVED', 'RETIRED') NOT NULL DEFAULT 'DISCOVERED',
  expected_sheet VARCHAR(160) NULL,
  header_row SMALLINT UNSIGNED NULL,
  expected_extension ENUM('xlsx', 'xls') NOT NULL DEFAULT 'xlsx',
  grain_description VARCHAR(500) NULL,
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
  canonical_header VARCHAR(191) NOT NULL,
  semantic_role VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  data_type ENUM('TEXT', 'BASE_CODE', 'DATETIME', 'INTEGER', 'DECIMAL') NOT NULL,
  is_required TINYINT(1) NOT NULL,
  is_nullable TINYINT(1) NOT NULL,
  validation_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
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
  submitted_by_user_id BIGINT UNSIGNED NOT NULL,
  job_state ENUM('RECEIVED', 'PARSING', 'INVALID', 'VALIDATED', 'PUBLISHED', 'FAILED', 'ABORTED') NOT NULL,
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
  UNIQUE KEY uq_import_source_job_contract_map
    (source_id, job_id, contract_version, validation_map_version_id),
  KEY ix_import_contract (source_id, contract_version),
  KEY ix_import_validation_map (validation_map_version_id),
  KEY ix_import_source_created (source_id, created_at),
  KEY ix_import_state_created (job_state, created_at),
  KEY ix_import_actor_created (submitted_by_user_id, created_at),
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
  safe_context VARCHAR(1000) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (error_id),
  KEY ix_import_errors_job_row (job_id, source_row_no, error_id),
  CONSTRAINT fk_import_error_job FOREIGN KEY (job_id)
    REFERENCES import_jobs(job_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE base_mapping_versions (
  map_version_id BINARY(16) NOT NULL,
  version_no BIGINT UNSIGNED NOT NULL,
  version_state ENUM('PREPARED', 'PUBLISHED', 'ABORTED') NOT NULL,
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'base_mapping_official',
  source_job_id BINARY(16) NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  file_sha256 BINARY(32) NOT NULL,
  mapping_row_count BIGINT UNSIGNED NOT NULL,
  published_by_user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  published_at DATETIME(6) NULL,
  PRIMARY KEY (map_version_id),
  UNIQUE KEY uq_mapping_version_no (version_no),
  UNIQUE KEY uq_mapping_source_job (source_job_id),
  KEY ix_mapping_source_job_contract (source_id, source_job_id, contract_version),
  KEY ix_mapping_version_published (published_at),
  CONSTRAINT chk_mapping_official_source
    CHECK (source_id = 'base_mapping_official' AND CHAR_LENGTH(source_id) = 21),
  CONSTRAINT fk_mapping_source FOREIGN KEY (source_id)
    REFERENCES data_source_registry(source_id),
  CONSTRAINT fk_mapping_source_job_contract
    FOREIGN KEY (source_id, source_job_id, contract_version)
    REFERENCES import_jobs(source_id, job_id, contract_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Movement jobs pinam o mapa usado na prévia; jobs de importação do próprio
-- mapa deixam validation_map_version_id nulo. A FK é adicionada após criar a
-- tabela de versões para evitar dependência circular na ordem de criação.
ALTER TABLE import_jobs
  ADD CONSTRAINT fk_import_validation_map
  FOREIGN KEY (validation_map_version_id)
  REFERENCES base_mapping_versions(map_version_id);

-- Nomes internos correspondem ao inventário documentado: regional_name=Regional,
-- uf_code=UF, rm_region=Região RM, rm_responsible=Responsável Rm, base_code=Código
-- da base, base_name=Nome da base, base_description=Descrição. O arquivo oficial
-- .xlsx não está disponível na worktree; o inventário não inclui RGM. Não inferir
-- nem acrescentar RGM, status ou vigência sem evidência da fonte oficial.
-- base_code usa collation case-sensitive NO PAD para que caixa e espaços finais
-- participem da igualdade exata usada no mapeamento.
CREATE TABLE base_mapping_entries (
  map_version_id BINARY(16) NOT NULL,
  base_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  base_name VARCHAR(191) NOT NULL,
  regional_name VARCHAR(64) NULL,
  uf_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL,
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

-- ENUM de valor único e PK impedem mais de um ponteiro oficial vigente,
-- sem depender de CHECK ou de convenção sobre uma chave textual.
-- Publicar mapa exige criar versão imutável e trocar este ponteiro na mesma
-- transação que marca a versão PUBLISHED e grava a auditoria. A FK só confirma
-- que a versão existe; protocolo/grants devem impedir edição de versão publicada.
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

-- Protocolo obrigatório da aplicação: preparar publicação/fatos sem expor o head;
-- em transação, bloquear a fonte, alocar version_no, marcar PUBLISHED, trocar o
-- source_snapshot_head e gravar auditoria. Falha antes do commit preserva o head
-- anterior. Versões antigas não são removidas. As FKs não impõem o estado PUBLISHED.
CREATE TABLE source_publications (
  publication_id BINARY(16) NOT NULL,
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_no BIGINT UNSIGNED NOT NULL,
  job_id BINARY(16) NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  map_version_id BINARY(16) NOT NULL,
  publication_state ENUM('PREPARED', 'PUBLISHED', 'FAILED', 'ABORTED') NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  published_at DATETIME(6) NULL,
  snapshot_as_of DATETIME(6) NULL,
  row_count BIGINT UNSIGNED NOT NULL,
  mapped_row_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  unmapped_row_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (publication_id),
  UNIQUE KEY uq_publication_source_id (source_id, publication_id),
  UNIQUE KEY uq_publication_version (source_id, version_no),
  UNIQUE KEY uq_publication_source_job (source_id, job_id),
  UNIQUE KEY uq_publication_mapping_version (publication_id, map_version_id),
  KEY ix_publication_map_version (map_version_id),
  KEY ix_publication_source_created (source_id, created_at),
  KEY ix_publication_source_state (source_id, publication_state, created_at),
  CONSTRAINT fk_publication_source FOREIGN KEY (source_id)
    REFERENCES data_source_registry(source_id),
  CONSTRAINT fk_publication_job_contract
    FOREIGN KEY (source_id, job_id, contract_version, map_version_id)
    REFERENCES import_jobs(source_id, job_id, contract_version, validation_map_version_id),
  CONSTRAINT fk_publication_map_version FOREIGN KEY (map_version_id)
    REFERENCES base_mapping_versions(map_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE source_snapshot_head (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  publication_id BINARY(16) NOT NULL,
  changed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (source_id),
  KEY ix_snapshot_head_publication (source_id, publication_id),
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
  safe_context VARCHAR(2000) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (audit_id),
  KEY ix_data_audit_actor_time (actor_user_id, created_at),
  KEY ix_data_audit_object_time (object_type, created_at),
  KEY ix_data_audit_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Esta tabela só contém o snapshot Sem Movimentação. O contrato descrito na
-- documentação registra 18 cabeçalhos candidatos; sem o Excel operacional real,
-- nomes, nulidade, formatos e tipos abaixo continuam sujeitos à aprovação.
-- A estrutura abaixo do fato segue o contrato documentado como candidato; o Excel
-- operacional real não está na worktree e ainda precisa validar os campos.
-- source_id usa exatamente o tipo/charset/collation da fonte de publicações e o
-- CHECK mantém a restrição de que esta tabela só possa representar 'movement'.
-- As FKs compostas impedem usar publicação de outra fonte e fixam o mapa usado.
-- O mapa é resolvido por igualdade exata (map_version_id, base_code), usando
-- LEFT JOIN para conservar códigos sem correspondência sem atribuir regional.
-- Código vazio é inválido; código não encontrado no mapa permanece no fato como
-- unmapped. Reconciliar as contagens armazenadas na publicação com o LEFT JOIN.
CREATE TABLE fact_movement_snapshot (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'movement',
  publication_id BINARY(16) NOT NULL,
  map_version_id BINARY(16) NOT NULL,
  source_row_no BIGINT UNSIGNED NOT NULL,
  base_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  source_base_name VARCHAR(191) NOT NULL,
  reported_region VARCHAR(64) NULL,
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
  last_operation_at DATETIME(6) NULL,
  stopped_14_day_rate DECIMAL(12,8) NULL,
  stopped_30_day_rate DECIMAL(12,8) NULL,
  PRIMARY KEY (publication_id, source_row_no),
  KEY ix_movement_publication_base (source_id, publication_id, base_code, source_row_no),
  KEY ix_movement_mapping_join (publication_id, map_version_id, base_code),
  CONSTRAINT chk_fact_movement_source
    CHECK (source_id = 'movement' AND CHAR_LENGTH(source_id) = 8),
  CONSTRAINT chk_fact_movement_base_code_nonblank
    CHECK (CHAR_LENGTH(TRIM(base_code)) > 0),
  CONSTRAINT fk_movement_publication_source
    FOREIGN KEY (source_id, publication_id)
    REFERENCES source_publications(source_id, publication_id),
  CONSTRAINT fk_movement_publication_mapping
    FOREIGN KEY (publication_id, map_version_id)
    REFERENCES source_publications(publication_id, map_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
