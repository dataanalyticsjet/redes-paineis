-- REVISÃO MANUAL — Monitoramento de Coleta T4 e T5.
-- Este arquivo não foi executado. Nenhum dado foi importado.
-- Contrato do código: SHA-256 3d6f804ccad783b2d4cc33870a26f9d11f891430ff30505861251fd17d1d4a62.
-- Fonte nova: collection_monitoring_t4_t5, contrato 1, 15 colunas, DAILY_REPLACE_DATES.
-- Fonte e contrato serão registrados inicialmente como PENDING / DISCOVERED.
-- A aprovação e ativação são etapas administrativas posteriores e separadas.

USE redes_paineis_dados;

-- BLOCO 1 — PRÉ-CHECAGENS SOMENTE LEITURA.
-- Se a fonte, o contrato ou a tabela já existirem, pare e audite antes de prosseguir.
SELECT DATABASE() AS selected_schema;

SELECT source_id, source_state, history_policy
FROM redes_paineis_dados.data_source_registry
WHERE source_id = 'collection_monitoring_t4_t5';

SELECT source_id, contract_version, contract_state, expected_sheet, header_row,
       expected_extension, history_policy, HEX(contract_sha256) AS contract_sha256
FROM redes_paineis_dados.source_contract_versions
WHERE source_id = 'collection_monitoring_t4_t5'
ORDER BY contract_version;

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'redes_paineis_dados'
  AND table_name = 'fact_collection_monitoring_t4_t5';

SELECT table_name, column_name, column_type, character_set_name, collation_name,
       is_nullable, column_key, extra
FROM information_schema.columns
WHERE table_schema = 'redes_paineis_dados'
  AND table_name IN ('source_publications', 'source_publication_dates', 'base_mapping_entries')
  AND column_name IN ('source_id', 'publication_id', 'map_version_id', 'data_date', 'base_code')
ORDER BY table_name, ordinal_position;

-- A publicação diária também depende de source_daily_head aceitar este source_id.
-- Confira a definição existente; aplique manualmente o arquivo separado
-- collection-monitoring-t4-t5-daily-head-constraint-review.sql antes de publicar.
SELECT tc.constraint_name, cc.check_clause,
       LOCATE('collection_monitoring_t4_t5', LOWER(cc.check_clause)) > 0 AS permits_t4_t5
FROM information_schema.table_constraints AS tc
JOIN information_schema.check_constraints AS cc
  ON cc.constraint_schema = tc.constraint_schema
 AND cc.constraint_name = tc.constraint_name
WHERE tc.constraint_schema = 'redes_paineis_dados'
  AND tc.table_name = 'source_daily_head'
  AND tc.constraint_type = 'CHECK'
  AND tc.constraint_name = 'chk_daily_head_source';

-- Pré-condições para a DDL: a fonte não existe; o contrato 1 não existe; a
-- tabela de fatos não existe; as três FKs abaixo têm tipos, collations e índices
-- compatíveis com o schema. Pare se alguma condição não for verdadeira.
-- A ausência de collection_monitoring_t4_t5 no CHECK não impede este CREATE,
-- mas impedirá a publicação quando _switch_heads gravar source_daily_head.
-- Corrija e valide essa constraint pelo SQL separado antes da primeira publicação.

-- BLOCO 2 — DDL INDEPENDENTE; CREATE TABLE causa commit implícito no MySQL.
CREATE TABLE redes_paineis_dados.fact_collection_monitoring_t4_t5 (
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'collection_monitoring_t4_t5',
  publication_id BINARY(16) NOT NULL,
  map_version_id BINARY(16) NOT NULL,
  source_row_no BIGINT UNSIGNED NOT NULL,
  data_date DATE NOT NULL,
  reported_origin_region VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  source_base_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  customer_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  store_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  seller_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  assigned_driver VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  order_origin VARCHAR(96) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
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
  KEY ix_cm_t4t5_publication_map (source_id, publication_id, map_version_id),
  KEY ix_cm_t4t5_publication_date (source_id, publication_id, data_date),
  KEY ix_cm_t4t5_mapping (map_version_id, resolved_base_code),
  KEY ix_cm_t4t5_name_mapping (map_version_id, source_base_name, resolved_base_code),
  KEY ix_cm_t4t5_date_base (data_date, resolved_base_code, publication_id),
  KEY ix_cm_t4t5_date_pdd (data_date, source_base_name),
  KEY ix_cm_t4t5_date_origin (data_date, order_origin),
  KEY ix_cm_t4t5_seller (data_date, seller_id),
  KEY ix_cm_t4t5_resolution (publication_id, mapping_resolution),
  CONSTRAINT chk_cm_t4t5_source CHECK (source_id = 'collection_monitoring_t4_t5'),
  CONSTRAINT chk_cm_t4t5_mapping_resolution CHECK (
    (mapping_resolution = 'NAME_APPROVED' AND source_base_name IS NOT NULL
      AND CHAR_LENGTH(TRIM(source_base_name)) > 0 AND resolved_base_code IS NOT NULL)
    OR (mapping_resolution = 'MISSING_IDENTIFIER'
      AND (source_base_name IS NULL OR CHAR_LENGTH(TRIM(source_base_name)) = 0)
      AND resolved_base_code IS NULL)
    OR (mapping_resolution IN ('UNMAPPED', 'AMBIGUOUS') AND source_base_name IS NOT NULL
      AND CHAR_LENGTH(TRIM(source_base_name)) > 0 AND resolved_base_code IS NULL)
  ),
  CONSTRAINT fk_cm_t4t5_publication
    FOREIGN KEY (source_id, publication_id, map_version_id)
    REFERENCES redes_paineis_dados.source_publications(source_id, publication_id, map_version_id),
  CONSTRAINT fk_cm_t4t5_publication_date
    FOREIGN KEY (source_id, publication_id, data_date)
    REFERENCES redes_paineis_dados.source_publication_dates(source_id, publication_id, data_date),
  CONSTRAINT fk_cm_t4t5_mapping
    FOREIGN KEY (map_version_id, resolved_base_code)
    REFERENCES redes_paineis_dados.base_mapping_entries(map_version_id, base_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- BLOCO 3 — VERIFICAÇÃO SOMENTE LEITURA APÓS A CRIAÇÃO MANUAL DA TABELA.
SHOW CREATE TABLE redes_paineis_dados.fact_collection_monitoring_t4_t5;

SELECT table_name, index_name, non_unique, seq_in_index, column_name
FROM information_schema.statistics
WHERE table_schema = 'redes_paineis_dados'
  AND table_name = 'fact_collection_monitoring_t4_t5'
ORDER BY index_name, seq_in_index;

SELECT constraint_name, column_name, referenced_table_schema,
       referenced_table_name, referenced_column_name, position_in_unique_constraint
FROM information_schema.key_column_usage
WHERE table_schema = 'redes_paineis_dados'
  AND table_name = 'fact_collection_monitoring_t4_t5'
  AND referenced_table_name IS NOT NULL
ORDER BY constraint_name, ordinal_position;

-- BLOCO 4 — REGISTRO TRANSACIONAL MANUAL DO SOURCE PENDING E CONTRATO DISCOVERED.
-- Executar apenas após aprovar o DDL e conferir os resultados dos blocos 1–3.
-- Verifique os SELECTs antes de COMMIT; use ROLLBACK se algo divergir.
START TRANSACTION;

INSERT INTO redes_paineis_dados.data_source_registry
  (source_id, display_name, description, source_state, history_policy)
VALUES
  ('collection_monitoring_t4_t5', 'Monitoramento de Coleta T4 e T5',
   'Exportação oficial JMS diária; PDD associado somente pelo DoomsDay publicado. Regional Origem não é fallback organizacional.',
   'PENDING', 'DAILY_REPLACE_DATES');

INSERT INTO redes_paineis_dados.source_contract_versions
  (source_id, contract_version, contract_state, expected_sheet, header_row,
   expected_extension, grain_description, history_policy, contract_sha256)
VALUES
  ('collection_monitoring_t4_t5', 1, 'DISCOVERED', 'Dados', 1, 'xlsx',
   'Uma linha por linha física da aba Dados. Cada data importada substitui somente sua partição. PDD é associado por correspondência única do nome de saída com o DoomsDay vigente; Regional Origem não concede classificação.',
   'DAILY_REPLACE_DATES',
   UNHEX('3d6f804ccad783b2d4cc33870a26f9d11f891430ff30505861251fd17d1d4a62'));

INSERT INTO redes_paineis_dados.source_contract_columns
  (source_id, contract_version, column_key, ordinal_position, source_header,
   semantic_role, data_type, is_required, is_nullable, validation_rules)
VALUES
  ('collection_monitoring_t4_t5', 1, 'data_date', 1, 'Data', 'data_date', 'DATE', 1, 0,
   JSON_OBJECT('sourceField', 'inputTime', 'partitionDate', TRUE, 'excelSerialRequired', TRUE, 'dateNumberFormatRequired', TRUE)),
  ('collection_monitoring_t4_t5', 1, 'reported_origin_region', 2, 'Regional Origem', 'reported_region', 'TEXT', 1, 1,
   JSON_OBJECT('sourceField', 'proxyAreaName', 'maxLength', 64, 'blankAllowed', TRUE, 'preserveOriginal', TRUE, 'organizationalFallback', FALSE)),
  ('collection_monitoring_t4_t5', 1, 'source_base_name', 3, 'PDD de saida', 'source_base_name', 'TEXT', 1, 1,
   JSON_OBJECT('sourceField', 'pickNetworkName', 'maxLength', 191, 'blankAllowed', TRUE, 'preserveOriginal', TRUE, 'matchPublishedDoomsDayOnly', TRUE, 'exactOrConservativeNormalizedName', TRUE, 'uniqueCandidateRequired', TRUE, 'fuzzyMatch', FALSE)),
  ('collection_monitoring_t4_t5', 1, 'customer_name', 4, 'Cliente', 'customer_name', 'TEXT', 1, 0,
   JSON_OBJECT('sourceField', 'customerName', 'maxLength', 191, 'numericCellsAllowed', FALSE)),
  ('collection_monitoring_t4_t5', 1, 'store_name', 5, 'Loja', 'store_name', 'TEXT', 1, 0,
   JSON_OBJECT('sourceField', 'shopName', 'maxLength', 191, 'numericCellsAllowedAsText', TRUE, 'maximumNumericPrecisionDigits', 15)),
  ('collection_monitoring_t4_t5', 1, 'seller_id', 6, 'Id Seller/remetente', 'seller_id', 'TEXT', 1, 0,
   JSON_OBJECT('sourceField', 'shopId', 'maxLength', 64, 'preserveAsText', TRUE, 'numericCellsAllowedAsText', TRUE, 'maximumNumericPrecisionDigits', 15, 'fillLeadingZeros', FALSE)),
  ('collection_monitoring_t4_t5', 1, 'assigned_driver', 7, 'Motorista Designado', 'assigned_driver', 'TEXT', 1, 0,
   JSON_OBJECT('sourceField', 'pickStaffName', 'maxLength', 191, 'numericCellsAllowed', FALSE)),
  ('collection_monitoring_t4_t5', 1, 'order_origin', 8, 'Origem do Pedido', 'order_origin', 'TEXT', 1, 0,
   JSON_OBJECT('sourceField', 'orderSourceName', 'maxLength', 96, 'numericCellsAllowed', FALSE)),
  ('collection_monitoring_t4_t5', 1, 'awaiting_collection', 9, 'Status atual – Aguardando coleta', 'awaiting_collection', 'INTEGER', 1, 0,
   JSON_OBJECT('sourceField', 'noTakingCount', 'minimum', 0, 'maximum', '18446744073709551615')),
  ('collection_monitoring_t4_t5', 1, 'received_at_dropoff', 10, 'Status atual – Recebido no Drop-off', 'received_at_dropoff', 'INTEGER', 1, 0,
   JSON_OBJECT('sourceField', 'dropoffCollectionCount', 'minimum', 0, 'maximum', '18446744073709551615')),
  ('collection_monitoring_t4_t5', 1, 'collected', 11, 'Status atual – Coletado', 'collected', 'INTEGER', 1, 0,
   JSON_OBJECT('sourceField', 'custShopTakingCount', 'minimum', 0, 'maximum', '18446744073709551615')),
  ('collection_monitoring_t4_t5', 1, 'received', 12, 'Status atual – Recebido', 'received', 'INTEGER', 1, 0,
   JSON_OBJECT('sourceField', 'pickupReceiveCount', 'minimum', 0, 'maximum', '18446744073709551615')),
  ('collection_monitoring_t4_t5', 1, 'received_at_base', 13, 'Status atual – Recebido na base', 'received_at_base', 'INTEGER', 1, 0,
   JSON_OBJECT('sourceField', 'custShopNetworkWarehouseCount', 'minimum', 0, 'maximum', '18446744073709551615')),
  ('collection_monitoring_t4_t5', 1, 'in_base_dispatch_flow', 14, '当前状态-网点发件流程中', 'in_base_dispatch_flow', 'INTEGER', 1, 0,
   JSON_OBJECT('sourceField', 'networkSendProgressCount', 'minimum', 0, 'maximum', '18446744073709551615')),
  ('collection_monitoring_t4_t5', 1, 'arrived_at_sc', 15, 'Status atual – Chegou ao SC', 'arrived_at_sc', 'INTEGER', 1, 0,
   JSON_OBJECT('sourceField', 'custShopCenterArrivalCount', 'minimum', 0, 'maximum', '18446744073709551615'));

SELECT ROW_COUNT() AS contract_column_rows;
-- Esperado: 15.

SELECT source_id, source_state, history_policy
FROM redes_paineis_dados.data_source_registry
WHERE source_id = 'collection_monitoring_t4_t5';

SELECT source_id, contract_version, contract_state, expected_sheet, header_row,
       expected_extension, history_policy, HEX(contract_sha256) AS contract_sha256
FROM redes_paineis_dados.source_contract_versions
WHERE source_id = 'collection_monitoring_t4_t5' AND contract_version = 1;

SELECT ordinal_position, column_key, source_header, semantic_role, data_type,
       is_required, is_nullable, validation_rules
FROM redes_paineis_dados.source_contract_columns
WHERE source_id = 'collection_monitoring_t4_t5' AND contract_version = 1
ORDER BY ordinal_position;

-- Revise os resultados. Execute COMMIT somente após conferência manual; caso
-- contrário, execute ROLLBACK. Não há INSERT de publicações ou fatos neste bloco.
-- COMMIT;
-- ROLLBACK;
