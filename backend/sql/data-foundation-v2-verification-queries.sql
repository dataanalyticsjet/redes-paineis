-- CONSULTAS SOMENTE LEITURA — PROPOSTA PARA REVISÃO.
-- Não executar nesta etapa. Consultas de cobertura global são restritas a
-- operadores autorizados; nunca expor seus resultados por API sem escopo.
-- Selecionar o schema redes_paineis_dados em uma sessão read-only antes de usar.

-- 1. Fontes e contratos: verificar estado, aba, política e cabeçalhos aprovados.
SELECT
  r.source_id,
  r.display_name,
  r.source_state,
  r.history_policy AS registry_history_policy,
  c.contract_version,
  c.contract_state,
  c.expected_sheet,
  c.header_row,
  c.history_policy AS contract_history_policy,
  cc.ordinal_position,
  cc.source_header,
  cc.column_key,
  cc.data_type,
  cc.is_required,
  cc.is_nullable
FROM data_source_registry AS r
LEFT JOIN source_contract_versions AS c
  ON c.source_id = r.source_id
LEFT JOIN source_contract_columns AS cc
  ON cc.source_id = c.source_id
 AND cc.contract_version = c.contract_version
ORDER BY r.source_id, c.contract_version DESC, cc.ordinal_position;

-- 2. Publicações e respectivos fingerprints; fingerprint não é conteúdo.
SELECT
  p.source_id,
  p.version_no,
  p.publication_id,
  p.publication_state,
  p.history_policy,
  p.contract_version,
  p.map_version_id,
  p.row_count,
  p.mapped_row_count,
  p.unmapped_row_count,
  p.missing_identifier_row_count,
  p.ambiguous_row_count,
  p.period_start,
  p.period_end,
  p.snapshot_as_of,
  p.created_at,
  p.published_at
FROM source_publications AS p
ORDER BY p.source_id, p.version_no DESC;

-- 3. Cabeças diárias vigentes e contagem registrada por data.
SELECT
  h.source_id,
  h.data_date,
  h.publication_id,
  p.version_no,
  p.publication_state,
  d.row_count AS published_date_row_count,
  h.changed_at
FROM source_daily_head AS h
JOIN source_publication_dates AS d
  ON d.source_id = h.source_id
 AND d.publication_id = h.publication_id
 AND d.data_date = h.data_date
JOIN source_publications AS p
  ON p.source_id = h.source_id
 AND p.publication_id = h.publication_id
ORDER BY h.source_id, h.data_date;

-- 4. Conferir linha a linha as contagens vigentes das quatro fontes diárias.
-- Resultado esperado: nenhuma linha se row_count estiver reconciliado.
WITH active_daily_rows AS (
  SELECT f.source_id, f.publication_id, f.data_date, f.source_row_no
  FROM fact_collection_monitoring AS f
  JOIN source_daily_head AS h
    ON h.source_id = f.source_id
   AND h.publication_id = f.publication_id
   AND h.data_date = f.data_date
  UNION ALL
  SELECT f.source_id, f.publication_id, f.data_date, f.source_row_no
  FROM fact_collection_rate AS f
  JOIN source_daily_head AS h
    ON h.source_id = f.source_id
   AND h.publication_id = f.publication_id
   AND h.data_date = f.data_date
  UNION ALL
  SELECT f.source_id, f.publication_id, f.data_date, f.source_row_no
  FROM fact_jt_monitoring AS f
  JOIN source_daily_head AS h
    ON h.source_id = f.source_id
   AND h.publication_id = f.publication_id
   AND h.data_date = f.data_date
  UNION ALL
  SELECT f.source_id, f.publication_id, f.data_date, f.source_row_no
  FROM fact_pdd_collection_failure AS f
  JOIN source_daily_head AS h
    ON h.source_id = f.source_id
   AND h.publication_id = f.publication_id
   AND h.data_date = f.data_date
)
SELECT
  h.source_id,
  h.data_date,
  h.publication_id,
  d.row_count AS expected_rows,
  COUNT(a.source_row_no) AS actual_rows
FROM source_daily_head AS h
JOIN source_publication_dates AS d
  ON d.source_id = h.source_id
 AND d.publication_id = h.publication_id
 AND d.data_date = h.data_date
LEFT JOIN active_daily_rows AS a
  ON a.source_id = h.source_id
 AND a.publication_id = h.publication_id
 AND a.data_date = h.data_date
GROUP BY h.source_id, h.data_date, h.publication_id, d.row_count
HAVING expected_rows <> actual_rows
ORDER BY h.source_id, h.data_date;

-- 5. Conferir o snapshot ativo de Sem Movimentação e a versão apontada.
SELECT
  h.source_id,
  h.publication_id,
  p.version_no,
  p.publication_state,
  p.row_count AS expected_rows,
  COUNT(f.source_row_no) AS actual_rows,
  p.published_at,
  h.changed_at
FROM source_snapshot_head AS h
JOIN source_publications AS p
  ON p.source_id = h.source_id
 AND p.publication_id = h.publication_id
LEFT JOIN fact_no_movement_snapshot AS f
  ON f.source_id = h.source_id
 AND f.publication_id = h.publication_id
WHERE h.source_id = 'no_movement'
GROUP BY h.source_id, h.publication_id, p.version_no, p.publication_state,
         p.row_count, p.published_at, h.changed_at;

-- 6. Cobertura de resolução nos conjuntos vigentes. Resultado global: restringir.
WITH active_resolution AS (
  SELECT f.source_id, f.mapping_resolution
  FROM fact_collection_monitoring AS f
  JOIN source_daily_head AS h
    ON h.source_id = f.source_id AND h.publication_id = f.publication_id
   AND h.data_date = f.data_date
  UNION ALL
  SELECT f.source_id, f.mapping_resolution
  FROM fact_collection_rate AS f
  JOIN source_daily_head AS h
    ON h.source_id = f.source_id AND h.publication_id = f.publication_id
   AND h.data_date = f.data_date
  UNION ALL
  SELECT f.source_id, f.mapping_resolution
  FROM fact_jt_monitoring AS f
  JOIN source_daily_head AS h
    ON h.source_id = f.source_id AND h.publication_id = f.publication_id
   AND h.data_date = f.data_date
  UNION ALL
  SELECT f.source_id, f.mapping_resolution
  FROM fact_no_movement_snapshot AS f
  JOIN source_snapshot_head AS h
    ON h.source_id = f.source_id AND h.publication_id = f.publication_id
  UNION ALL
  SELECT f.source_id, f.mapping_resolution
  FROM fact_pdd_collection_failure AS f
  JOIN source_daily_head AS h
    ON h.source_id = f.source_id AND h.publication_id = f.publication_id
   AND h.data_date = f.data_date
)
SELECT source_id, mapping_resolution, COUNT(*) AS row_count
FROM active_resolution
GROUP BY source_id, mapping_resolution
ORDER BY source_id, mapping_resolution;

-- 7. Nomes sem decisão na versão oficial corrente; uso restrito ao responsável
-- pelo de-para. Não usar resultado para inferir associações automaticamente.
SELECT
  n.source_id,
  n.resolution_state,
  COUNT(*) AS distinct_source_names
FROM base_mapping_name_decisions AS n
JOIN base_mapping_current AS c
  ON c.current_key = 'OFFICIAL'
 AND c.map_version_id = n.map_version_id
WHERE n.resolution_state <> 'LINKED'
GROUP BY n.source_id, n.resolution_state
ORDER BY n.source_id, n.resolution_state;

-- 8. Localizar fatos resolvidos para códigos ausentes do mapa corrente.
-- Esses registros devem ficar invisíveis a escopos regional/base até reconciliação.
WITH resolved_current_facts AS (
  SELECT f.source_id, f.publication_id, f.source_row_no, f.resolved_base_code
  FROM fact_collection_monitoring AS f
  JOIN source_daily_head AS h
    ON h.source_id = f.source_id AND h.publication_id = f.publication_id
   AND h.data_date = f.data_date
  WHERE f.resolved_base_code IS NOT NULL
  UNION ALL
  SELECT f.source_id, f.publication_id, f.source_row_no, f.resolved_base_code
  FROM fact_collection_rate AS f
  JOIN source_daily_head AS h
    ON h.source_id = f.source_id AND h.publication_id = f.publication_id
   AND h.data_date = f.data_date
  WHERE f.resolved_base_code IS NOT NULL
  UNION ALL
  SELECT f.source_id, f.publication_id, f.source_row_no, f.resolved_base_code
  FROM fact_jt_monitoring AS f
  JOIN source_daily_head AS h
    ON h.source_id = f.source_id AND h.publication_id = f.publication_id
   AND h.data_date = f.data_date
  WHERE f.resolved_base_code IS NOT NULL
  UNION ALL
  SELECT f.source_id, f.publication_id, f.source_row_no, f.resolved_base_code
  FROM fact_no_movement_snapshot AS f
  JOIN source_snapshot_head AS h
    ON h.source_id = f.source_id AND h.publication_id = f.publication_id
  WHERE f.resolved_base_code IS NOT NULL
  UNION ALL
  SELECT f.source_id, f.publication_id, f.source_row_no, f.resolved_base_code
  FROM fact_pdd_collection_failure AS f
  JOIN source_daily_head AS h
    ON h.source_id = f.source_id AND h.publication_id = f.publication_id
   AND h.data_date = f.data_date
  WHERE f.resolved_base_code IS NOT NULL
)
SELECT f.source_id, COUNT(*) AS rows_without_current_mapping
FROM resolved_current_facts AS f
JOIN base_mapping_current AS c ON c.current_key = 'OFFICIAL'
LEFT JOIN base_mapping_entries AS m
  ON m.map_version_id = c.map_version_id
 AND m.base_code = f.resolved_base_code
WHERE m.base_code IS NULL
GROUP BY f.source_id
ORDER BY f.source_id;

-- 9. Exemplo de padrão de consulta de linhas. A API deve obter a lista de
-- regiões autorizadas de redes_paineis e vinculá-la por parâmetros individuais.
-- Primeiro limita a publicação vigente e a regional corrente; depois filtra,
-- pagina e agrega. Nunca usar reported_region para acesso.
SELECT
  f.data_date,
  f.resolved_base_code,
  m.regional_name,
  f.expected_pickup_collection,
  f.collected_current,
  f.source_row_no
FROM fact_collection_monitoring AS f
JOIN source_daily_head AS h
  ON h.source_id = f.source_id
 AND h.publication_id = f.publication_id
 AND h.data_date = f.data_date
JOIN base_mapping_current AS c
  ON c.current_key = 'OFFICIAL'
JOIN base_mapping_entries AS m
  ON m.map_version_id = c.map_version_id
 AND m.base_code = f.resolved_base_code
WHERE f.data_date >= :date_from
  AND f.data_date <= :date_to
  AND m.regional_name IN (:authorized_region_parameters)
ORDER BY f.data_date, f.resolved_base_code, f.source_row_no
LIMIT :page_size;

-- 10. Exemplo de filtro para o snapshot vigente. Os parâmetros de escopo vêm
-- da identidade autorizada; a regional reportada no Excel não participa.
SELECT
  f.resolved_base_code,
  m.regional_name,
  f.stopped_orders,
  f.orders_in_transit,
  f.stopped_14_plus_days_rate,
  f.source_row_no
FROM fact_no_movement_snapshot AS f
JOIN source_snapshot_head AS h
  ON h.source_id = f.source_id
 AND h.publication_id = f.publication_id
JOIN base_mapping_current AS c
  ON c.current_key = 'OFFICIAL'
JOIN base_mapping_entries AS m
  ON m.map_version_id = c.map_version_id
 AND m.base_code = f.resolved_base_code
WHERE m.regional_name IN (:authorized_region_parameters)
ORDER BY f.resolved_base_code, f.source_row_no
LIMIT :page_size;

-- 11. Auditoria estrutural das FKs no schema criado. Esperado: igualdade de
-- tipo/tamanho/sinal/charset/collation/precisão, índice filho BTREE completo
-- na ordem da FK e índice único referenciado na ordem da chave pai.
-- Executar apenas após aprovação e criação manual do schema; esta revisão não
-- executou a consulta nem conectou ao banco.
WITH fk_columns AS (
  SELECT
    k.CONSTRAINT_SCHEMA,
    k.TABLE_NAME,
    k.CONSTRAINT_NAME,
    k.COLUMN_NAME,
    k.ORDINAL_POSITION,
    k.REFERENCED_TABLE_NAME,
    k.REFERENCED_COLUMN_NAME,
    COUNT(*) OVER (
      PARTITION BY k.CONSTRAINT_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME
    ) AS fk_column_count
  FROM information_schema.KEY_COLUMN_USAGE AS k
  WHERE k.CONSTRAINT_SCHEMA = DATABASE()
    AND k.REFERENCED_TABLE_NAME IS NOT NULL
),
fk_type_audit AS (
  SELECT
    f.CONSTRAINT_SCHEMA,
    f.TABLE_NAME,
    f.CONSTRAINT_NAME,
    f.COLUMN_NAME,
    f.ORDINAL_POSITION,
    f.REFERENCED_TABLE_NAME,
    f.REFERENCED_COLUMN_NAME,
    f.fk_column_count,
    child.COLUMN_TYPE AS child_column_type,
    parent.COLUMN_TYPE AS parent_column_type,
    child.CHARACTER_MAXIMUM_LENGTH AS child_char_length,
    parent.CHARACTER_MAXIMUM_LENGTH AS parent_char_length,
    child.CHARACTER_OCTET_LENGTH AS child_octet_length,
    parent.CHARACTER_OCTET_LENGTH AS parent_octet_length,
    child.IS_NULLABLE AS child_nullable,
    parent.IS_NULLABLE AS parent_nullable,
    child.CHARACTER_SET_NAME AS child_charset,
    parent.CHARACTER_SET_NAME AS parent_charset,
    child.COLLATION_NAME AS child_collation,
    parent.COLLATION_NAME AS parent_collation,
    child.DATETIME_PRECISION AS child_datetime_precision,
    parent.DATETIME_PRECISION AS parent_datetime_precision,
    (child.COLUMN_TYPE <=> parent.COLUMN_TYPE
      AND child.CHARACTER_MAXIMUM_LENGTH <=> parent.CHARACTER_MAXIMUM_LENGTH
      AND child.CHARACTER_OCTET_LENGTH <=> parent.CHARACTER_OCTET_LENGTH
      AND child.CHARACTER_SET_NAME <=> parent.CHARACTER_SET_NAME
      AND child.COLLATION_NAME <=> parent.COLLATION_NAME
      AND child.NUMERIC_PRECISION <=> parent.NUMERIC_PRECISION
      AND child.NUMERIC_SCALE <=> parent.NUMERIC_SCALE
      AND child.DATETIME_PRECISION <=> parent.DATETIME_PRECISION) AS types_match
  FROM fk_columns AS f
  JOIN information_schema.COLUMNS AS child
    ON child.TABLE_SCHEMA = f.CONSTRAINT_SCHEMA
   AND child.TABLE_NAME = f.TABLE_NAME
   AND child.COLUMN_NAME = f.COLUMN_NAME
  JOIN information_schema.COLUMNS AS parent
    ON parent.TABLE_SCHEMA = f.CONSTRAINT_SCHEMA
   AND parent.TABLE_NAME = f.REFERENCED_TABLE_NAME
   AND parent.COLUMN_NAME = f.REFERENCED_COLUMN_NAME
),
matching_child_indexes AS (
  SELECT
    f.CONSTRAINT_SCHEMA,
    f.TABLE_NAME,
    f.CONSTRAINT_NAME,
    s.INDEX_NAME,
    MAX(f.fk_column_count) AS fk_column_count,
    COUNT(DISTINCT f.ORDINAL_POSITION) AS matched_fk_columns
  FROM fk_columns AS f
  JOIN information_schema.STATISTICS AS s
    ON s.TABLE_SCHEMA = f.CONSTRAINT_SCHEMA
   AND s.TABLE_NAME = f.TABLE_NAME
   AND s.SEQ_IN_INDEX = f.ORDINAL_POSITION
   AND s.COLUMN_NAME = f.COLUMN_NAME
   AND s.SUB_PART IS NULL
   AND s.INDEX_TYPE = 'BTREE'
  GROUP BY f.CONSTRAINT_SCHEMA, f.TABLE_NAME, f.CONSTRAINT_NAME, s.INDEX_NAME
  HAVING COUNT(DISTINCT f.ORDINAL_POSITION) = MAX(f.fk_column_count)
),
matching_parent_indexes AS (
  SELECT
    f.CONSTRAINT_SCHEMA,
    f.TABLE_NAME,
    f.CONSTRAINT_NAME,
    s.INDEX_NAME,
    MAX(f.fk_column_count) AS fk_column_count,
    COUNT(DISTINCT f.ORDINAL_POSITION) AS matched_fk_columns
  FROM fk_columns AS f
  JOIN information_schema.STATISTICS AS s
    ON s.TABLE_SCHEMA = f.CONSTRAINT_SCHEMA
   AND s.TABLE_NAME = f.REFERENCED_TABLE_NAME
   AND s.SEQ_IN_INDEX = f.ORDINAL_POSITION
   AND s.COLUMN_NAME = f.REFERENCED_COLUMN_NAME
   AND s.SUB_PART IS NULL
   AND s.INDEX_TYPE = 'BTREE'
   AND s.NON_UNIQUE = 0
  GROUP BY f.CONSTRAINT_SCHEMA, f.TABLE_NAME, f.CONSTRAINT_NAME, s.INDEX_NAME
  HAVING COUNT(DISTINCT f.ORDINAL_POSITION) = MAX(f.fk_column_count)
),
child_index_summary AS (
  SELECT
    CONSTRAINT_SCHEMA,
    TABLE_NAME,
    CONSTRAINT_NAME,
    COUNT(*) AS supporting_index_count,
    GROUP_CONCAT(INDEX_NAME ORDER BY INDEX_NAME SEPARATOR ', ') AS supporting_indexes
  FROM matching_child_indexes
  GROUP BY CONSTRAINT_SCHEMA, TABLE_NAME, CONSTRAINT_NAME
),
parent_index_summary AS (
  SELECT
    CONSTRAINT_SCHEMA,
    TABLE_NAME,
    CONSTRAINT_NAME,
    COUNT(*) AS referenced_unique_index_count,
    GROUP_CONCAT(INDEX_NAME ORDER BY INDEX_NAME SEPARATOR ', ') AS referenced_unique_indexes
  FROM matching_parent_indexes
  GROUP BY CONSTRAINT_SCHEMA, TABLE_NAME, CONSTRAINT_NAME
)
SELECT
  a.TABLE_NAME,
  a.CONSTRAINT_NAME,
  a.ORDINAL_POSITION,
  a.COLUMN_NAME AS child_column,
  a.child_column_type,
  a.child_char_length,
  a.child_octet_length,
  a.child_nullable,
  a.child_charset,
  a.child_collation,
  a.REFERENCED_TABLE_NAME AS parent_table,
  a.REFERENCED_COLUMN_NAME AS parent_column,
  a.parent_column_type,
  a.parent_char_length,
  a.parent_octet_length,
  a.parent_nullable,
  a.parent_charset,
  a.parent_collation,
  IF(a.types_match, 'OK', 'MISMATCH') AS type_status,
  COALESCE(i.supporting_index_count, 0) AS supporting_index_count,
  i.supporting_indexes,
  COALESCE(r.referenced_unique_index_count, 0) AS referenced_unique_index_count,
  r.referenced_unique_indexes
FROM fk_type_audit AS a
LEFT JOIN child_index_summary AS i
  ON i.CONSTRAINT_SCHEMA = a.CONSTRAINT_SCHEMA
 AND i.TABLE_NAME = a.TABLE_NAME
 AND i.CONSTRAINT_NAME = a.CONSTRAINT_NAME
LEFT JOIN parent_index_summary AS r
  ON r.CONSTRAINT_SCHEMA = a.CONSTRAINT_SCHEMA
 AND r.TABLE_NAME = a.TABLE_NAME
 AND r.CONSTRAINT_NAME = a.CONSTRAINT_NAME
ORDER BY a.TABLE_NAME, a.CONSTRAINT_NAME, a.ORDINAL_POSITION;

-- 12. Confirmar a contagem do DDL: devem existir exatamente 20 tabelas-base.
SELECT COUNT(*) AS data_foundation_v2_table_count
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_TYPE = 'BASE TABLE';

-- 13. Publicações apontadas precisam estar publicadas, usar a política
-- compatível com o tipo de head e fixar uma versão publicada do de-para.
-- Esperado: nenhuma linha.
SELECT
  'DAILY' AS pointer_kind,
  h.source_id,
  h.publication_id,
  p.publication_state,
  p.history_policy,
  m.version_state AS map_version_state,
  r.history_policy AS registry_history_policy,
  c.history_policy AS contract_history_policy
FROM source_daily_head AS h
JOIN source_publications AS p
  ON p.source_id = h.source_id
 AND p.publication_id = h.publication_id
JOIN data_source_registry AS r
  ON r.source_id = p.source_id
JOIN source_contract_versions AS c
  ON c.source_id = p.source_id
 AND c.contract_version = p.contract_version
LEFT JOIN base_mapping_versions AS m
  ON m.map_version_id = p.map_version_id
WHERE p.publication_state <> 'PUBLISHED'
   OR p.history_policy <> 'DAILY_REPLACE_DATES'
   OR r.history_policy <> 'DAILY_REPLACE_DATES'
   OR c.history_policy <> 'DAILY_REPLACE_DATES'
   OR m.version_state IS NULL
   OR m.version_state <> 'PUBLISHED'
UNION ALL
SELECT
  'SNAPSHOT' AS pointer_kind,
  h.source_id,
  h.publication_id,
  p.publication_state,
  p.history_policy,
  m.version_state AS map_version_state,
  r.history_policy AS registry_history_policy,
  c.history_policy AS contract_history_policy
FROM source_snapshot_head AS h
JOIN source_publications AS p
  ON p.source_id = h.source_id
 AND p.publication_id = h.publication_id
JOIN data_source_registry AS r
  ON r.source_id = p.source_id
JOIN source_contract_versions AS c
  ON c.source_id = p.source_id
 AND c.contract_version = p.contract_version
LEFT JOIN base_mapping_versions AS m
  ON m.map_version_id = p.map_version_id
WHERE p.publication_state <> 'PUBLISHED'
   OR p.history_policy <> 'SNAPSHOT_REPLACE_ALL'
   OR r.history_policy <> 'SNAPSHOT_REPLACE_ALL'
   OR c.history_policy <> 'SNAPSHOT_REPLACE_ALL'
   OR m.version_state IS NULL
   OR m.version_state <> 'PUBLISHED';

-- 13b. Verificar também publicações históricas publicadas: política coerente
-- com fonte/contrato e versão do mapa já publicada. Esperado: nenhuma linha.
SELECT
  p.source_id,
  p.publication_id,
  p.publication_state,
  p.history_policy AS publication_history_policy,
  r.history_policy AS registry_history_policy,
  c.history_policy AS contract_history_policy,
  m.version_state AS map_version_state
FROM source_publications AS p
JOIN data_source_registry AS r
  ON r.source_id = p.source_id
JOIN source_contract_versions AS c
  ON c.source_id = p.source_id
 AND c.contract_version = p.contract_version
LEFT JOIN base_mapping_versions AS m
  ON m.map_version_id = p.map_version_id
WHERE p.publication_state = 'PUBLISHED'
  AND (p.history_policy <> r.history_policy
    OR p.history_policy <> c.history_policy
    OR m.version_state IS NULL
    OR m.version_state <> 'PUBLISHED');

-- 14. Reconciliar a contagem integral de cada publicação com os fatos; comparar
-- cada partição diária com source_publication_dates e checar política temporal.
-- Esperado: nenhuma linha.
WITH publication_fact_rows AS (
  SELECT source_id, publication_id, data_date, source_row_no
  FROM fact_collection_monitoring
  UNION ALL
  SELECT source_id, publication_id, data_date, source_row_no
  FROM fact_collection_rate
  UNION ALL
  SELECT source_id, publication_id, data_date, source_row_no
  FROM fact_jt_monitoring
  UNION ALL
  SELECT source_id, publication_id, NULL AS data_date, source_row_no
  FROM fact_no_movement_snapshot
  UNION ALL
  SELECT source_id, publication_id, data_date, source_row_no
  FROM fact_pdd_collection_failure
),
fact_totals AS (
  SELECT source_id, publication_id, COUNT(*) AS actual_row_count
  FROM publication_fact_rows
  GROUP BY source_id, publication_id
),
fact_dates AS (
  SELECT source_id, publication_id, data_date, COUNT(*) AS actual_row_count
  FROM publication_fact_rows
  WHERE data_date IS NOT NULL
  GROUP BY source_id, publication_id, data_date
),
publication_date_totals AS (
  SELECT source_id, publication_id, SUM(row_count) AS date_row_count
  FROM source_publication_dates
  GROUP BY source_id, publication_id
)
SELECT
  p.source_id,
  p.publication_id,
  p.history_policy,
  p.row_count AS publication_row_count,
  COALESCE(ft.actual_row_count, 0) AS fact_row_count,
  COALESCE(dt.date_row_count, 0) AS date_row_count
FROM source_publications AS p
LEFT JOIN fact_totals AS ft
  ON ft.source_id = p.source_id AND ft.publication_id = p.publication_id
LEFT JOIN publication_date_totals AS dt
  ON dt.source_id = p.source_id AND dt.publication_id = p.publication_id
WHERE p.publication_state = 'PUBLISHED'
  AND (p.row_count <> COALESCE(ft.actual_row_count, 0)
    OR (p.history_policy = 'DAILY_REPLACE_DATES'
      AND p.row_count <> COALESCE(dt.date_row_count, 0))
    OR (p.history_policy = 'SNAPSHOT_REPLACE_ALL'
      AND COALESCE(dt.date_row_count, 0) <> 0))
UNION ALL
SELECT
  d.source_id,
  d.publication_id,
  'DAILY_DATE_COUNT_MISMATCH' AS history_policy,
  d.row_count AS publication_row_count,
  COALESCE(f.actual_row_count, 0) AS fact_row_count,
  d.row_count AS date_row_count
FROM source_publication_dates AS d
LEFT JOIN fact_dates AS f
  ON f.source_id = d.source_id
 AND f.publication_id = d.publication_id
 AND f.data_date = d.data_date
JOIN source_publications AS p
  ON p.source_id = d.source_id AND p.publication_id = d.publication_id
WHERE p.publication_state = 'PUBLISHED'
  AND (p.history_policy <> 'DAILY_REPLACE_DATES'
    OR d.row_count <> COALESCE(f.actual_row_count, 0));

-- 15. Nome sem código: conferir que estado e resolução do fato refletem a
-- decisão exata, quando houver. Não usar aproximação nem regional reportada.
-- Esperado: nenhuma linha.
WITH named_facts AS (
  SELECT source_id, publication_id, map_version_id, source_row_no,
         source_base_name, resolved_base_code, mapping_resolution
  FROM fact_collection_monitoring
  UNION ALL
  SELECT source_id, publication_id, map_version_id, source_row_no,
         source_base_name, resolved_base_code, mapping_resolution
  FROM fact_collection_rate
  UNION ALL
  SELECT source_id, publication_id, map_version_id, source_row_no,
         source_base_name, resolved_base_code, mapping_resolution
  FROM fact_jt_monitoring
)
SELECT
  f.source_id,
  f.publication_id,
  f.source_row_no,
  f.source_base_name,
  f.mapping_resolution,
  d.resolution_state AS decision_state,
  f.resolved_base_code,
  d.target_base_code
FROM named_facts AS f
LEFT JOIN base_mapping_name_decisions AS d
  ON d.map_version_id = f.map_version_id
 AND d.source_id = f.source_id
 AND d.source_base_name = f.source_base_name
WHERE (f.mapping_resolution = 'NAME_APPROVED'
       AND (d.resolution_state IS NULL
         OR d.resolution_state <> 'LINKED'
         OR NOT (d.target_base_code <=> f.resolved_base_code)))
   OR (f.mapping_resolution = 'AMBIGUOUS'
       AND (d.resolution_state IS NULL OR d.resolution_state <> 'AMBIGUOUS'))
   OR (f.mapping_resolution = 'UNMAPPED'
       AND d.resolution_state IN ('LINKED', 'AMBIGUOUS'));

-- 16. O mapa oficial corrente também precisa apontar para versão publicada.
-- Esperado: nenhuma linha.
SELECT c.current_key, c.map_version_id, v.version_state, v.published_at
FROM base_mapping_current AS c
LEFT JOIN base_mapping_versions AS v
  ON v.map_version_id = c.map_version_id
WHERE v.map_version_id IS NULL OR v.version_state <> 'PUBLISHED';

-- 17. Histórico: listar versões/publicações retidas e suas contagens. A troca
-- de heads deve acrescentar/apontar versões; não apagar publicações ou fatos.
-- As FKs deste DDL usam a regra padrão RESTRICT/NO ACTION (sem cascata de delete).
SELECT
  p.source_id,
  COUNT(*) AS retained_publications,
  COUNT(DISTINCT p.job_id) AS retained_jobs,
  MIN(p.version_no) AS first_version_no,
  MAX(p.version_no) AS latest_version_no,
  SUM(p.row_count) AS historical_declared_rows
FROM source_publications AS p
GROUP BY p.source_id
ORDER BY p.source_id;

-- 18. J&T: a PK técnica preserva cada linha física, inclusive duplicatas de
-- conteúdo. Confirmar contagem da publicação sem deduplicação natural.
-- Esperado: nenhuma linha. Não agrupar por dimensões de negócio.
SELECT
  p.publication_id,
  p.row_count AS expected_rows,
  COUNT(f.source_row_no) AS actual_rows,
  COUNT(DISTINCT f.source_row_no) AS distinct_physical_rows
FROM source_publications AS p
LEFT JOIN fact_jt_monitoring AS f
  ON f.source_id = p.source_id
 AND f.publication_id = p.publication_id
WHERE p.source_id = 'jt_monitoring'
  AND p.publication_state = 'PUBLISHED'
GROUP BY p.publication_id, p.row_count
HAVING expected_rows <> actual_rows
    OR actual_rows <> distinct_physical_rows;
