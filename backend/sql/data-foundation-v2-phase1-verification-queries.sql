-- RASCUNHO HISTÓRICO SUPERSEDIDO — NÃO USAR COMO VERIFICAÇÃO ATUAL.
-- Consultas atuais dos cinco dashboards estão em
-- backend/sql/data-foundation-v2-verification-queries.sql.
-- CONSULTAS READ-ONLY PARA REVISÃO EM AMBIENTE LOCAL/TESTE, APÓS APROVAÇÃO.
-- NÃO EXECUTAR EM PRODUÇÃO. Este arquivo contém apenas SELECTs.
-- Requer MySQL/TXSQL 8.0.30 para as consultas de CHECK_CONSTRAINTS e IS_VISIBLE.
-- Nenhuma consulta substitui revisão de DDL, aplicação, grants ou transações.

-- Versão, engine default, charset, collation e modo SQL do servidor de teste.
SELECT VERSION() AS mysql_version,
       @@version_comment AS distribution,
       @@default_storage_engine AS default_engine,
       @@character_set_server AS server_charset,
       @@collation_server AS server_collation,
       @@sql_mode AS sql_mode;

-- Deve haver exatamente 13 tabelas base da Fase 1.
SELECT COUNT(*) AS actual_base_table_count,
       13 AS expected_base_table_count,
       COUNT(*) = 13 AS expected_count_matches
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'redes_paineis_dados'
  AND TABLE_TYPE = 'BASE TABLE';

-- Engine e collation das 13 tabelas. TABLE_ROWS é estimativa do InnoDB.
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION, TABLE_ROWS
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'redes_paineis_dados'
  AND TABLE_TYPE = 'BASE TABLE'
ORDER BY TABLE_NAME;

-- Tipos físicos, sinal, charset/collation e nulidade de todas as colunas.
SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE,
       IS_NULLABLE, CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_KEY,
       EXTRA, GENERATION_EXPRESSION
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'redes_paineis_dados'
ORDER BY TABLE_NAME, ORDINAL_POSITION;

-- O código da base deve usar collation case-sensitive NO PAD nos dois lados do
-- de-para, para comparação exata também quando houver espaço final.
SELECT c.TABLE_NAME, c.COLUMN_NAME, c.COLLATION_NAME,
       co.PAD_ATTRIBUTE
FROM INFORMATION_SCHEMA.COLUMNS AS c
LEFT JOIN INFORMATION_SCHEMA.COLLATIONS AS co
  ON co.COLLATION_NAME = c.COLLATION_NAME
WHERE c.TABLE_SCHEMA = 'redes_paineis_dados'
  AND ((c.TABLE_NAME = 'base_mapping_entries' AND c.COLUMN_NAME = 'base_code')
       OR (c.TABLE_NAME = 'fact_movement_snapshot' AND c.COLUMN_NAME = 'base_code'))
ORDER BY c.TABLE_NAME;

-- Índices, ordem completa, prefixos e visibilidade.
SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
       SUB_PART, INDEX_TYPE, IS_VISIBLE
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = 'redes_paineis_dados'
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- Cada coluna de FK deve ter a mesma definição física da coluna referenciada.
-- same_type_charset_collation deve ser 1 em todas as linhas.
SELECT fk.TABLE_NAME, fk.CONSTRAINT_NAME, fk.ORDINAL_POSITION,
       fk.COLUMN_NAME, child.COLUMN_TYPE AS child_column_type,
       fk.REFERENCED_TABLE_SCHEMA, fk.REFERENCED_TABLE_NAME,
       fk.REFERENCED_COLUMN_NAME, parent.COLUMN_TYPE AS parent_column_type,
       child.CHARACTER_SET_NAME AS child_charset,
       parent.CHARACTER_SET_NAME AS parent_charset,
       child.COLLATION_NAME AS child_collation,
       parent.COLLATION_NAME AS parent_collation,
       (child.COLUMN_TYPE = parent.COLUMN_TYPE
        AND child.CHARACTER_SET_NAME <=> parent.CHARACTER_SET_NAME
        AND child.COLLATION_NAME <=> parent.COLLATION_NAME)
         AS same_type_charset_collation
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS fk
JOIN INFORMATION_SCHEMA.COLUMNS AS child
  ON child.TABLE_SCHEMA = fk.TABLE_SCHEMA
 AND child.TABLE_NAME = fk.TABLE_NAME
 AND child.COLUMN_NAME = fk.COLUMN_NAME
JOIN INFORMATION_SCHEMA.COLUMNS AS parent
  ON parent.TABLE_SCHEMA = fk.REFERENCED_TABLE_SCHEMA
 AND parent.TABLE_NAME = fk.REFERENCED_TABLE_NAME
 AND parent.COLUMN_NAME = fk.REFERENCED_COLUMN_NAME
WHERE fk.TABLE_SCHEMA = 'redes_paineis_dados'
  AND fk.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY fk.TABLE_NAME, fk.CONSTRAINT_NAME, fk.ORDINAL_POSITION;

-- Índices candidatos no lado filho. Para cada FK composta, deve existir um
-- mesmo INDEX_NAME cobrindo todas as posições ordinais desde a primeira coluna.
SELECT fk.TABLE_NAME, fk.CONSTRAINT_NAME, fk.ORDINAL_POSITION,
       fk.COLUMN_NAME AS fk_column, idx.INDEX_NAME AS candidate_child_index,
       idx.NON_UNIQUE, idx.SEQ_IN_INDEX, idx.COLUMN_NAME AS indexed_column,
       idx.SUB_PART
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS fk
LEFT JOIN INFORMATION_SCHEMA.STATISTICS AS idx
  ON idx.TABLE_SCHEMA = fk.TABLE_SCHEMA
 AND idx.TABLE_NAME = fk.TABLE_NAME
 AND idx.SEQ_IN_INDEX = fk.ORDINAL_POSITION
 AND idx.COLUMN_NAME = fk.COLUMN_NAME
 AND idx.SUB_PART IS NULL
WHERE fk.TABLE_SCHEMA = 'redes_paineis_dados'
  AND fk.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY fk.TABLE_NAME, fk.CONSTRAINT_NAME, fk.ORDINAL_POSITION,
         idx.INDEX_NAME;

-- Índices candidatos no lado pai. Para cada FK, o conjunto referenciado deve
-- estar coberto na mesma ordem por uma chave UNIQUE completa (NON_UNIQUE = 0).
SELECT fk.TABLE_NAME, fk.CONSTRAINT_NAME, fk.ORDINAL_POSITION,
       fk.REFERENCED_TABLE_NAME, fk.REFERENCED_COLUMN_NAME,
       idx.INDEX_NAME AS candidate_parent_index, idx.NON_UNIQUE,
       idx.SEQ_IN_INDEX, idx.COLUMN_NAME AS indexed_column, idx.SUB_PART
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS fk
LEFT JOIN INFORMATION_SCHEMA.STATISTICS AS idx
  ON idx.TABLE_SCHEMA = fk.REFERENCED_TABLE_SCHEMA
 AND idx.TABLE_NAME = fk.REFERENCED_TABLE_NAME
 AND idx.SEQ_IN_INDEX = fk.ORDINAL_POSITION
 AND idx.COLUMN_NAME = fk.REFERENCED_COLUMN_NAME
 AND idx.SUB_PART IS NULL
WHERE fk.TABLE_SCHEMA = 'redes_paineis_dados'
  AND fk.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY fk.TABLE_NAME, fk.CONSTRAINT_NAME, fk.ORDINAL_POSITION,
         idx.INDEX_NAME;

-- Ações declaradas para cada FK. Revisar especialmente cascatas; só a FK de
-- erros de job deve usar ON DELETE CASCADE neste desenho.
SELECT rc.CONSTRAINT_NAME, rc.TABLE_NAME, rc.REFERENCED_TABLE_NAME,
       rc.MATCH_OPTION, rc.UPDATE_RULE, rc.DELETE_RULE
FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS rc
WHERE rc.CONSTRAINT_SCHEMA = 'redes_paineis_dados'
ORDER BY rc.TABLE_NAME, rc.CONSTRAINT_NAME;

-- O CHECK que limita o fato à fonte movement deve estar instalado.
SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE,
       cc.CHECK_CLAUSE
FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS tc
LEFT JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS AS cc
  ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
 AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
WHERE tc.CONSTRAINT_SCHEMA = 'redes_paineis_dados'
  AND tc.CONSTRAINT_TYPE = 'CHECK'
ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME;

-- Campos do inventário disponível do de-para. RGM não aparece no inventário
-- documentado e, portanto, não deve surgir como coluna sem nova evidência oficial.
SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE,
       CHARACTER_SET_NAME, COLLATION_NAME, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'redes_paineis_dados'
  AND TABLE_NAME = 'base_mapping_entries'
ORDER BY ORDINAL_POSITION;

-- Deve existir no máximo uma linha no ponteiro corrente do de-para.
SELECT COUNT(*) AS official_mapping_pointer_count
FROM redes_paineis_dados.base_mapping_current;

-- Ponteiro oficial deve apontar para uma versão publicada; esperado: zero linhas.
SELECT c.current_key, c.map_version_id, v.version_no,
       v.version_state, v.published_at
FROM redes_paineis_dados.base_mapping_current AS c
LEFT JOIN redes_paineis_dados.base_mapping_versions AS v
  ON v.map_version_id = c.map_version_id
WHERE v.map_version_id IS NULL
   OR v.version_state <> 'PUBLISHED'
   OR v.published_at IS NULL;

-- Versão do de-para precisa usar job e contrato da fonte oficial;
-- esperado: zero linhas.
SELECT m.map_version_id, m.version_no, m.source_id,
       j.source_id AS job_source_id,
       m.contract_version, j.contract_version AS job_contract_version
FROM redes_paineis_dados.base_mapping_versions AS m
LEFT JOIN redes_paineis_dados.import_jobs AS j
  ON j.source_id = m.source_id
 AND j.job_id = m.source_job_id
 AND j.contract_version = m.contract_version
WHERE j.job_id IS NULL
   OR m.source_id <> 'base_mapping_official'
   OR CHAR_LENGTH(m.source_id) <> 21;

-- Jobs devem fixar apenas mapas que já estejam publicados; esperado: zero linhas.
SELECT j.job_id, j.source_id, j.validation_map_version_id,
       m.version_state, m.published_at
FROM redes_paineis_dados.import_jobs AS j
LEFT JOIN redes_paineis_dados.base_mapping_versions AS m
  ON m.map_version_id = j.validation_map_version_id
WHERE j.validation_map_version_id IS NOT NULL
  AND (m.map_version_id IS NULL
       OR m.version_state <> 'PUBLISHED'
       OR m.published_at IS NULL);

-- Auditoria das publicações, jobs, contratos e versões de mapa.
SELECT p.publication_id, p.source_id, p.version_no, p.publication_state,
       p.job_id, p.contract_version, p.map_version_id,
       j.source_id AS job_source_id,
       j.contract_version AS job_contract_version,
       j.validation_map_version_id,
       m.version_state AS map_version_state,
       m.version_no AS mapping_version_no
FROM redes_paineis_dados.source_publications AS p
LEFT JOIN redes_paineis_dados.import_jobs AS j
  ON j.source_id = p.source_id AND j.job_id = p.job_id
LEFT JOIN redes_paineis_dados.base_mapping_versions AS m
  ON m.map_version_id = p.map_version_id
ORDER BY p.source_id, p.version_no;

-- Publicação deve usar o mapa fixado no job e mapa publicado; esperado: zero linhas.
SELECT p.publication_id, p.publication_state,
       p.map_version_id AS publication_map_version_id,
       j.validation_map_version_id AS job_map_version_id,
       m.version_state AS map_version_state
FROM redes_paineis_dados.source_publications AS p
LEFT JOIN redes_paineis_dados.import_jobs AS j
  ON j.source_id = p.source_id AND j.job_id = p.job_id
LEFT JOIN redes_paineis_dados.base_mapping_versions AS m
  ON m.map_version_id = p.map_version_id
WHERE j.job_id IS NULL
   OR j.validation_map_version_id IS NULL
   OR p.map_version_id <> j.validation_map_version_id
   OR m.version_state <> 'PUBLISHED'
   OR m.published_at IS NULL;

-- Snapshot head deve apontar para publicação da mesma fonte, publicada e datada;
-- esperado: zero linhas.
SELECT h.source_id, h.publication_id,
       p.source_id AS publication_source_id,
       p.publication_state, p.published_at
FROM redes_paineis_dados.source_snapshot_head AS h
LEFT JOIN redes_paineis_dados.source_publications AS p
  ON p.source_id = h.source_id AND p.publication_id = h.publication_id
WHERE p.publication_id IS NULL
   OR p.publication_state <> 'PUBLISHED'
   OR p.published_at IS NULL;

-- Fatos só podem usar a fonte movement e o mapa fixado na publicação;
-- esperado: zero linhas. As mesmas condições também são protegidas por CHECK/FKs.
SELECT f.source_row_no, f.source_id, f.publication_id,
       p.source_id AS publication_source_id,
       f.map_version_id AS fact_map_version_id,
       p.map_version_id AS publication_map_version_id
FROM redes_paineis_dados.fact_movement_snapshot AS f
LEFT JOIN redes_paineis_dados.source_publications AS p
  ON p.source_id = f.source_id AND p.publication_id = f.publication_id
WHERE f.source_id <> 'movement'
   OR CHAR_LENGTH(f.source_id) <> 8
   OR p.publication_id IS NULL
   OR f.map_version_id <> p.map_version_id;

-- Reconciliação das contagens gravadas com as linhas e o de-para exato por código.
-- Esperado: zero linhas, inclusive para publicação ainda não ativa.
SELECT p.publication_id, p.publication_state,
       p.row_count AS declared_rows, COALESCE(f.fact_rows, 0) AS actual_rows,
       p.mapped_row_count AS declared_mapped,
       COALESCE(f.mapped_rows, 0) AS actual_mapped,
       p.unmapped_row_count AS declared_unmapped,
       COALESCE(f.unmapped_rows, 0) AS actual_unmapped
FROM redes_paineis_dados.source_publications AS p
LEFT JOIN (
  SELECT f.publication_id, COUNT(*) AS fact_rows,
         SUM(m.base_code IS NOT NULL) AS mapped_rows,
         SUM(m.base_code IS NULL) AS unmapped_rows
  FROM redes_paineis_dados.fact_movement_snapshot AS f
  LEFT JOIN redes_paineis_dados.base_mapping_entries AS m
    ON m.map_version_id = f.map_version_id
   AND m.base_code = f.base_code
  GROUP BY f.publication_id
) AS f
  ON f.publication_id = p.publication_id
WHERE p.source_id = 'movement'
  AND (p.row_count <> COALESCE(f.fact_rows, 0)
       OR p.mapped_row_count <> COALESCE(f.mapped_rows, 0)
       OR p.unmapped_row_count <> COALESCE(f.unmapped_rows, 0)
       OR p.row_count <> p.mapped_row_count + p.unmapped_row_count);

-- Cobertura resumida do snapshot ativo. Códigos sem correspondência continuam
-- contados como não mapeados; não se infere Regional da coluna reportada.
SELECT f.publication_id, COUNT(*) AS fact_rows,
       SUM(m.base_code IS NOT NULL) AS mapped_rows,
       SUM(m.base_code IS NULL) AS unmapped_rows
FROM redes_paineis_dados.source_snapshot_head AS h
JOIN redes_paineis_dados.fact_movement_snapshot AS f
  ON f.source_id = h.source_id AND f.publication_id = h.publication_id
LEFT JOIN redes_paineis_dados.base_mapping_entries AS m
  ON m.map_version_id = f.map_version_id AND m.base_code = f.base_code
WHERE h.source_id = 'movement'
GROUP BY f.publication_id;

-- Código vazio deve ser rejeitado por CHECK e pelo validador; esperado: zero linhas.
SELECT publication_id, COUNT(*) AS blank_code_rows
FROM redes_paineis_dados.fact_movement_snapshot
WHERE CHAR_LENGTH(TRIM(base_code)) = 0
GROUP BY publication_id;

-- Versão oficial também não pode conter código vazio; esperado: zero linhas.
SELECT map_version_id, COUNT(*) AS blank_mapping_codes
FROM redes_paineis_dados.base_mapping_entries
WHERE CHAR_LENGTH(TRIM(base_code)) = 0
GROUP BY map_version_id;

-- Duplicidade por código no de-para é impedida pela PK (map_version_id, base_code).
-- Resultado esperado: zero linhas; consulta também documenta o invariante.
SELECT map_version_id, base_code, COUNT(*) AS duplicate_count
FROM redes_paineis_dados.base_mapping_entries
GROUP BY map_version_id, base_code
HAVING COUNT(*) > 1;

-- Diagnóstico de código repetido no fato. Não implica erro até confirmar a
-- granularidade no Excel operacional real.
SELECT f.publication_id, f.base_code, COUNT(*) AS rows_per_code
FROM redes_paineis_dados.fact_movement_snapshot AS f
GROUP BY f.publication_id, f.base_code
HAVING COUNT(*) > 1
ORDER BY rows_per_code DESC, f.base_code;

-- Histórico de snapshots preservados; apenas uma publicação por fonte deve ser
-- apontada pelo head. Publicações antigas seguem consultáveis sob autorização.
SELECT p.source_id, p.version_no, p.publication_id, p.publication_state,
       p.created_at, p.published_at, p.snapshot_as_of, p.row_count,
       p.mapped_row_count, p.unmapped_row_count,
       (h.publication_id = p.publication_id) AS is_current
FROM redes_paineis_dados.source_publications AS p
LEFT JOIN redes_paineis_dados.source_snapshot_head AS h
  ON h.source_id = p.source_id
WHERE p.source_id = 'movement'
ORDER BY p.version_no DESC;

-- O banco não guarda grants de leitura por usuário nesta Fase 1. Confirme no
-- serviço: ADMIN não implica escopo nacional; capability nacional é explícita,
-- auditada e necessária inclusive para metadados/contagens de linhas não mapeadas.
