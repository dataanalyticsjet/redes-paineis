-- REVISÃO MANUAL — permitir publicação diária da fonte T4/T5.
-- Este arquivo é somente uma proposta. Não foi executado.
-- O ALTER é DDL e provoca commit implícito; conferir os pré-requisitos e a definição real antes de executar manualmente.

USE redes_paineis_dados;

-- PRÉ-CHECAGENS SOMENTE LEITURA. Pare se o schema, constraint ou lista atual divergir.
SELECT DATABASE() AS selected_schema;

SHOW CREATE TABLE redes_paineis_dados.source_daily_head;

SELECT tc.constraint_name, cc.check_clause
FROM information_schema.table_constraints AS tc
JOIN information_schema.check_constraints AS cc
  ON cc.constraint_schema = tc.constraint_schema
 AND cc.constraint_name = tc.constraint_name
WHERE tc.constraint_schema = 'redes_paineis_dados'
  AND tc.table_name = 'source_daily_head'
  AND tc.constraint_type = 'CHECK'
  AND tc.constraint_name = 'chk_daily_head_source';

-- Execute o bloco abaixo somente depois de conferir que a constraint atual é
-- exatamente a esperada: collection_monitoring, collection_rate, jt_monitoring,
-- pdd_collection_failure. Se houver outras fontes, preserve-as na substituição.
-- MySQL/TXSQL 8.0.30 aceita DROP CHECK e a adição da nova definição no mesmo ALTER.
ALTER TABLE redes_paineis_dados.source_daily_head
  DROP CHECK chk_daily_head_source,
  ADD CONSTRAINT chk_daily_head_source CHECK (
    source_id IN (
      'collection_monitoring',
      'collection_rate',
      'jt_monitoring',
      'pdd_collection_failure',
      'collection_monitoring_t4_t5'
    )
  );

-- PÓS-CHECAGENS SOMENTE LEITURA. Confirme todas as fontes e a FK antes de seguir.
SHOW CREATE TABLE redes_paineis_dados.source_daily_head;

SELECT source_id, COUNT(*) AS date_heads
FROM redes_paineis_dados.source_daily_head
GROUP BY source_id
ORDER BY source_id;

SELECT constraint_name, column_name, referenced_table_name, referenced_column_name
FROM information_schema.key_column_usage
WHERE table_schema = 'redes_paineis_dados'
  AND table_name = 'source_daily_head'
  AND referenced_table_name IS NOT NULL
ORDER BY constraint_name, ordinal_position;
