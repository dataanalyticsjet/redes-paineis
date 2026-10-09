# Data Foundation V2 — arquitetura para cinco dashboards

**Estado:** proposta para revisão e autorização. Esta documentação e o DDL são apenas artefatos de projeto. Nenhum banco foi acessado, nenhum SQL foi executado e nenhuma tabela, migration, dashboard ou arquivo Excel foi alterado.

**Branch:** `codex/data-foundation-v2`  
**Auditoria:** cinco workbooks oficiais fornecidos em `.../RedesPaineis-DataFoundationV2-Review-2026-10-09/planilhas/`, lidos em modo somente leitura. Os Excels originais ficam fora do Git.

Esta versão substitui o inventário anterior que se baseava em contratos inferidos do código. O DDL completo está em [data-foundation-v2-proposal.sql](../../backend/sql/data-foundation-v2-proposal.sql); consultas `SELECT` de verificação estão em [data-foundation-v2-verification-queries.sql](../../backend/sql/data-foundation-v2-verification-queries.sql). Os rascunhos da Fase 1 são históricos e não descrevem mais o contrato completo.

## 1. Método, limites e observações gerais

Foram lidos os nomes de abas, células, cabeçalhos, formatos de célula, valores preenchidos, fórmulas e linhas completas. Cada arquivo tem uma linha de cabeçalho, nenhuma linha vazia no corpo e nenhuma célula com fórmula. Datas estão gravadas como números Excel com formato de data; quantidades e taxas são números; nomes, regionais e o ID de seller em J&T são textos. Os códigos de base em Sem Movimentação e Falha na Coleta PDD estão armazenados como números no Excel e devem virar strings sem preenchimento automático de zeros.

“Obrigatório” abaixo significa obrigatório no cabeçalho e, quando indicado `NOT NULL`, obrigatório na linha conforme a amostra auditada. Campos em que foi observada alguma célula vazia permitem `NULL`. Para campos sem vazios, `NOT NULL` é a regra de importação proposta a partir dos cinco arquivos; o dono do dado ainda precisa aprová-la para futuras remessas. Não há validação de fórmula ou relação entre métricas inferida dos nomes.

Os intervalos de data abaixo descrevem somente o conteúdo destes arquivos. Para quatro fontes, a presença de várias datas comprova um extrato com registros por data; não comprova que cada arquivo futuro conterá todas as datas ou que a exportação é completa. Sem Movimentação não informa uma data de snapshot; o horário da última operação é um dado do negócio, não um marcador de publicação.

## 2. Inventário dos arquivos e contratos

| Fonte / ID técnico | Arquivo oficial lido | Aba; cabeçalho | Linhas de dados | Datas de negócio observadas | Leitura de histórico |
|---|---|---:|---:|---|---|
| Monitoramento de Coleta — `collection_monitoring` | `揽收监控Resumo17474620261006101134.xlsx - Monitoramento de Coleta .xlsx` | `sheet0`; linha 1 | 3.877 | `Data`: 2026-10-01 a 2026-10-06, 6 datas | Extrato com vários dias; política proposta: substituir integralmente apenas as datas presentes. |
| Taxa de Coleta — `collection_rate` | `Taxa de coleta no prazo(Taxa de coleta oportuna - resumo)17474620261006101324.xlsx - Taxa de Coleta .xlsx` | `sheet0`; linha 1 | 3.269 | `Horário de término do prazo de coleta`: 2026-10-01 a 2026-10-05, 5 datas | Extrato com vários dias; política proposta: substituir integralmente apenas as datas presentes. |
| Monitoramento J&T — `jt_monitoring` | `揽收监控Resumo17474620261006101208.xlsx - Monitoramento J&T .xlsx` | `sheet1`; linha 1 | 159.666 | `Data`: 2026-10-03 a 2026-10-06, 4 datas | Extrato com vários dias; política proposta: substituir integralmente apenas as datas presentes. |
| Sem Movimentação — `no_movement` | `Monitoramento de movimentação em tempo real (novo)(Resumo)17474620261006102038.xlsx - Sem Movimentação.xlsx` | `sheet0`; linha 1 | 151 | Sem coluna de data de snapshot | Snapshot integral candidato; confirmar cobertura antes de ativar. Uma linha por código de base nesta amostra. |
| Falha na Coleta PDD — `pdd_collection_failure` | `网点派件漏扫率报表(汇总)17474620261006101412.xlsx - Falha na coleta PDD.xlsx` | `sheet0`; linha 1 | 1.617 | `Data considerada`: somente 2026-10-05 | Extrato por data; política proposta: substituir integralmente a data presente. |

### 2.1 Monitoramento de Coleta (`collection_monitoring`)

Granularidade observada: uma linha por `Data` + `PDD de saida`; essa combinação foi única nas 3.877 linhas. Não é aprovada como chave de negócio. A amostra contém 6 valores de data e não tem linhas completas duplicadas. `Regional Origem` e `PDD de saida` têm 6 vazios cada; as duas taxas têm, respectivamente, 1.459 e 1.176 vazios. As 17 colunas de quantidade não têm vazios.

| Cabeçalho oficial exato | Coluna técnica | Tipo proposto | Obrigatório / NULL observado |
|---|---|---|---|
| `Data` | `data_date` | `DATE` | Obrigatório; não nulo |
| `Regional Origem` | `reported_region` | `VARCHAR(64)` | Cabeçalho obrigatório; `NULL` permitido (6) |
| `PDD de saida` | `source_base_name` | `VARCHAR(191)` | Cabeçalho obrigatório; `NULL` permitido (6) |
| `Taxa de coleta do vendedor` | `seller_collection_rate` | `DECIMAL(38,24)` | `NULL` permitido (1.459) |
| `Taxa de Visita de Coleta` | `collection_visit_rate` | `DECIMAL(38,24)` | `NULL` permitido (1.176) |
| `Coleta Prevista Drop-off` | `expected_dropoff_collection` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Coleta Prevista Pick-up` | `expected_pickup_collection` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Aguardando Coleta Drop-off` | `awaiting_collection_dropoff` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Aguardando Coleta Pick-up` | `awaiting_collection_pickup` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Status atual – Coletado` | `collected_current` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Status atual – Recebido na base` | `received_at_base_current` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Expedida pela Base` | `dispatched_by_base` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Status atual – Em trânsito a partir da base` | `in_transit_from_base` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `网点发件在途(中心)` | `branch_outbound_transit_center` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `网点发件在途(集散)` | `branch_outbound_transit_sorting` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Chegada ao Centro de Triagem` | `arrived_at_sorting_center` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Expedido pelo Centro de Triagem` | `dispatched_by_sorting_center` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `集散发件在途` | `sorting_outbound_transit` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Status atual – Chegou ao SC` | `arrived_at_sc` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Pacote Criado pela Base` | `package_created_by_base` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `已处理问题件` | `processed_problem_items` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `未处理问题件` | `unprocessed_problem_items` | `BIGINT UNSIGNED` | Obrigatório; não nulo |

### 2.2 Taxa de Coleta (`collection_rate`)

Granularidade observada: `Horário de término do prazo de coleta` + `Nome da regional` + `Nome da base de coleta` + `Origem do Pedido` + `Tipo de produto` foi única nas 3.269 linhas. Não é aprovada como chave de negócio. Existem 5 datas. As colunas de regional e base têm 10 vazios cada; `Prazo médio demorado para coleta(h)` tem 22. As outras células do corpo estão preenchidas. O campo de prazo está formatado como data Excel e só tem valores de data, sem fração de hora, nesta amostra; o SQL mantém `DATETIME(6)` para não truncar uma eventual hora em nova remessa e deriva a data para histórico.

| Cabeçalho oficial exato | Coluna técnica | Tipo proposto | Obrigatório / NULL observado |
|---|---|---|---|
| `Horário de término do prazo de coleta` | `deadline_at` | `DATETIME(6)`; `data_date` gerada | Obrigatório; não nulo |
| `Nome da regional` | `reported_region` | `VARCHAR(64)` | Cabeçalho obrigatório; `NULL` permitido (10) |
| `Nome da base de coleta` | `source_base_name` | `VARCHAR(191)` | Cabeçalho obrigatório; `NULL` permitido (10) |
| `Origem do Pedido` | `order_origin` | `VARCHAR(96)` | Obrigatório; não nulo |
| `Tipo de produto` | `product_type` | `VARCHAR(64)` | Obrigatório; não nulo |
| `Quantidade de pedidos` | `order_quantity` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Qtd a coletar` | `quantity_to_collect` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Qtd cancelada` | `cancelled_quantity` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Taxa de coleta` | `collection_rate` | `DECIMAL(38,24)` | Obrigatório; não nulo |
| `揽收量` | `collected_quantity` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `未揽收量` | `not_collected_quantity` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Qtd não coletada no prazo` | `not_collected_on_time_quantity` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Qtd coletada no prazo` | `collected_on_time_quantity` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Taxa de coleta no prazo` | `collection_on_time_rate` | `DECIMAL(38,24)` | Obrigatório; não nulo |
| `Pedidos coletados + Tentativas de coleta` | `collected_plus_attempts_quantity` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Taxa de coleta com tentativas de coleta` | `collection_rate_with_attempts` | `DECIMAL(38,24)` | Obrigatório; não nulo |
| `Prazo médio demorado para coleta(h)` | `average_collection_delay_hours` | `DECIMAL(38,24)` | Obrigatório; `NULL` permitido (22) |
| `已做问题件的量` | `processed_problem_items` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `未做问题件的量` | `unprocessed_problem_items` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Taxa de coleta do vendedor` | `seller_collection_rate` | `DECIMAL(38,24)` | Obrigatório; não nulo |
| `应上门商家量` | `expected_merchant_visits` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `未上门商家量` | `merchants_not_visited` | `BIGINT UNSIGNED` | Obrigatório; não nulo |

### 2.3 Monitoramento J&T (`jt_monitoring`)

Granularidade observada: registros por data e seller/loja/base, mas não há chave natural aprovada. Há 159.666 linhas em 4 datas, 65 vazios em `Regional Origem` e `PDD de saida`, e nenhum vazio nas demais colunas. Foram encontrados 4 pares de linhas idênticas em todas as colunas (linhas Excel 7.380/9.146, 16.228/84.442, 78.427/114.411 e 83.961/120.678). Outras dimensões de seller também se repetem. As linhas repetidas serão preservadas; a regra para removê-las depende de decisão do dono do dado. Os valores `TOTAL CHIC`, `Totalsafra` e `Total Eletronic` estão na coluna `Loja` e não são evidência de linhas de totalização.

| Cabeçalho oficial exato | Coluna técnica | Tipo proposto | Obrigatório / NULL observado |
|---|---|---|---|
| `Data` | `data_date` | `DATE` | Obrigatório; não nulo |
| `Regional Origem` | `reported_region` | `VARCHAR(64)` | Cabeçalho obrigatório; `NULL` permitido (65) |
| `PDD de saida` | `source_base_name` | `VARCHAR(191)` | Cabeçalho obrigatório; `NULL` permitido (65) |
| `Cliente` | `customer_name` | `VARCHAR(191)` | Obrigatório; não nulo |
| `Loja` | `store_name` | `VARCHAR(191)` | Obrigatório; não nulo |
| `Id Seller/remetente` | `seller_id` | `VARCHAR(64)` | Obrigatório; não nulo; preservar como texto |
| `Motorista Designado` | `assigned_driver` | `VARCHAR(191)` | Obrigatório; não nulo |
| `Origem do Pedido` | `order_origin` | `VARCHAR(96)` | Obrigatório; não nulo |
| `Status atual – Aguardando coleta` | `awaiting_collection` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Status atual – Recebido no Drop-off` | `received_at_dropoff` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Status atual – Coletado` | `collected` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Status atual – Recebido` | `received` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Status atual – Recebido na base` | `received_at_base` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `当前状态-网点发件流程中` | `in_base_dispatch_flow` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Status atual – Chegou ao SC` | `arrived_at_sc` | `BIGINT UNSIGNED` | Obrigatório; não nulo |

### 2.4 Sem Movimentação (`no_movement`)

Granularidade observada: uma linha por `Código da unidade responsável`; os 151 códigos são distintos e não há linhas completas repetidas. Não há data de snapshot no workbook. `Horário da última operação` vai de 2026-07-14 a 2026-10-05 e tem 151 valores distintos; não deve ser usado como data de snapshot. Todas as células observadas estão preenchidas.

| Cabeçalho oficial exato | Coluna técnica | Tipo proposto | Obrigatório / NULL observado |
|---|---|---|---|
| `Regional responsável` | `reported_region` | `VARCHAR(64)` | Obrigatório; não nulo |
| `Código da unidade responsável` | `source_base_code` | `VARCHAR(64)` | Obrigatório; não nulo; código textual no banco |
| `Nome da unidade responsável` | `source_base_name` | `VARCHAR(191)` | Obrigatório; não nulo |
| `Total de pedidos sem movimentação` | `stopped_orders` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Qtd pedidos em trânsito` | `orders_in_transit` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Sem mov. há mais de 1 dia` | `stopped_over_1_day` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Sem mov. há mais de 2 dias` | `stopped_over_2_days` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Sem mov. há mais de 3 dias` | `stopped_over_3_days` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Sem mov. há mais de 4 dias` | `stopped_over_4_days` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Sem mov. há mais de 5 dias` | `stopped_over_5_days` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Sem mov. há mais de 6 dias` | `stopped_over_6_days` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Sem mov. há mais de 7 dias` | `stopped_over_7_days` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Sem mov. há mais de 10 dias` | `stopped_over_10_days` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Sem mov. há mais de 14 dias` | `stopped_over_14_days` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Sem mov. há mais de 30 dias` | `stopped_over_30_days` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Horário da última operação` | `last_operation_at` | `DATETIME(6)` | Obrigatório; não nulo |
| `Taxa de sem mov 14+dias` | `stopped_14_plus_days_rate` | `DECIMAL(38,24)` | Obrigatório; não nulo |
| `Taxa de sem mov 30+dias` | `stopped_30_plus_days_rate` | `DECIMAL(38,24)` | Obrigatório; não nulo |

### 2.5 Falha na Coleta PDD (`pdd_collection_failure`)

Granularidade observada: `Data considerada` + `Código da base`; as 1.617 combinações são únicas e não há linhas completas repetidas. O arquivo contém uma única data, 2026-10-05. Todas as células estão preenchidas. `Código da Regional` é mantido como código reportado pela fonte, mas não é código da base e não concede escopo.

| Cabeçalho oficial exato | Coluna técnica | Tipo proposto | Obrigatório / NULL observado |
|---|---|---|---|
| `Data considerada` | `data_date` | `DATE` | Obrigatório; não nulo |
| `Código da base` | `source_base_code` | `VARCHAR(64)` | Obrigatório; não nulo; código textual no banco |
| `Nome da base` | `source_base_name` | `VARCHAR(191)` | Obrigatório; não nulo |
| `Código da Regional` | `source_region_code` | `VARCHAR(64)` | Obrigatório; não nulo; não usar para autorização |
| `Nome da regional` | `reported_region` | `VARCHAR(64)` | Obrigatório; não nulo; não usar para autorização |
| `Qtd pedidos a bipar` | `orders_to_scan` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Qtd pedidos não bipados no recebimento` | `orders_unscanned_at_receipt` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Taxa de pedidos não bipados no recebimento` | `rate_unscanned_at_receipt` | `DECIMAL(38,24)` | Obrigatório; não nulo |
| `Qtd de pedidos não bipados na saída para entrega` | `orders_unscanned_for_delivery` | `BIGINT UNSIGNED` | Obrigatório; não nulo |
| `Taxa de pedidos não bipados na saída para entrega` | `rate_unscanned_for_delivery` | `DECIMAL(38,24)` | Obrigatório; não nulo |
| `Taxa geral de falta de bipagem` | `overall_unscanned_rate` | `DECIMAL(38,24)` | Obrigatório; não nulo |

Os códigos encontrados nos Excels variam de 5 a 6 dígitos em Falha na Coleta PDD. Não padronizar para 6 dígitos nem converter para inteiro no banco. `seller_id` é texto compartilhado no arquivo J&T e deve permanecer texto.

## 3. Modelo relacional proposto

O DDL mantém exatamente 20 tabelas em um banco operacional separado, `redes_paineis_dados`, no mesmo TXSQL somente se grants, capacidade e isolamento forem aprovados. A correção desta revisão não altera a contagem. Identidade, sessão e escopo do usuário continuam no serviço atual; não há FK cruzada para `redes_paineis`. O backend ganha credencial de mínimo privilégio e configuração própria. As tabelas de fatos são específicas por dashboard — não há fato genérico JSON.

| Tabela | PK | FKs e função |
|---|---|---|
| `data_source_registry` | `source_id` | Catálogo dos cinco dashboards e da fonte do de-para oficial. |
| `source_contract_versions` | `(source_id, contract_version)` | Fonte; versão imutável da aba, cabeçalho, granularidade e política. |
| `source_contract_columns` | `(source_id, contract_version, column_key)` | Contrato; cabeçalho oficial exato, coluna técnica, tipo, ordem, obrigatoriedade e nulidade. |
| `source_contract_aliases` | `(source_id, contract_version, normalized_alias)` | Só aliases explicitamente aprovados; não escolhe coluna por aproximação. |
| `import_jobs` | `job_id` | Fonte/contrato e, para dashboards, versão do de-para usada na validação; hash, chave privada do arquivo, ator e contagens. |
| `import_job_errors` | `error_id` | Job; código sanitizado por linha/coluna sem guardar valor operacional desnecessário. |
| `base_mapping_versions` | `map_version_id` | Job do de-para, versão imutável, hash, autor e publicação. |
| `base_mapping_entries` | `(map_version_id, base_code)` | Versão do mapa; código único por versão e campos oficiais disponíveis. |
| `base_mapping_name_decisions` | `(map_version_id, source_id, source_base_name)` | Versão do mapa; decisão manual exata para fontes sem código e FK para o código oficial quando aprovada. |
| `base_mapping_current` | `current_key='OFFICIAL'` | Único ponteiro para a versão oficial corrente. |
| `source_publications` | `publication_id` | Job, contrato, versão do mapa, fingerprint do arquivo, versão publicada e contagens. |
| `source_publication_dates` | `(source_id, publication_id, data_date)` | Datas e contagens entregues por publicação diária. |
| `source_daily_head` | `(source_id, data_date)` | Publicação vigente de cada data. |
| `source_snapshot_head` | `source_id` | Publicação vigente de `no_movement`. |
| `fact_collection_monitoring` | `(publication_id, source_row_no)` | 22 colunas oficiais de Monitoramento de Coleta e rastreabilidade/mapeamento. |
| `fact_collection_rate` | `(publication_id, source_row_no)` | 22 colunas oficiais de Taxa de Coleta e rastreabilidade/mapeamento. |
| `fact_jt_monitoring` | `(publication_id, source_row_no)` | 15 colunas oficiais de Monitoramento J&T e rastreabilidade/mapeamento. |
| `fact_no_movement_snapshot` | `(publication_id, source_row_no)` | 18 colunas oficiais do snapshot Sem Movimentação. |
| `fact_pdd_collection_failure` | `(publication_id, source_row_no)` | 11 colunas oficiais de Falha na Coleta PDD. |
| `data_audit_events` | `audit_id` | Ações de importação, publicação, troca de ponteiro, reversão e mudança de mapa. |

Todas as fatos retêm `publication_id`, `source_row_no`, `map_version_id`, `resolved_base_code` anulável e estado de resolução. O número de linha é a linha física no Excel (incluindo cabeçalho); é a chave técnica que preserva inclusive duplicatas da fonte. O `source_base_code`, `source_base_name`, `reported_region` e `source_region_code` permanecem também nos fatos quando existem no Excel. O valor reportado nunca substitui a resolução oficial.

Contagens entram como `BIGINT UNSIGNED`, pois todas as colunas nomeadas como quantidade são numéricas e inteiras nas cinco amostras. Taxas e horas médias usam `DECIMAL(38,24)` para guardar sem arredondamento os valores decimais gravados nos Excels, incluindo frações de ponto flutuante serializadas. Não há `CHECK` de fórmula, intervalo de taxa ou igualdade entre totais. A amostra contém taxas no intervalo 0–1, mas isso não basta para impor escala ou fórmula a futuras cargas.

Os índices cobrem os caminhos de leitura e, explicitamente, o prefixo ordenado de cada FK filha. As consultas reais e `EXPLAIN` devem ser revisados em TXSQL descartável antes de migrar volume de produção.

### Auditoria estática das FKs

A revisão do DDL cobriu todas as FKs. IDs `source_id` usam `VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin` nos dois lados; versões de contrato usam `SMALLINT UNSIGNED`; contadores/linhas usam `BIGINT UNSIGNED`; IDs de publicação/mapa/job usam `BINARY(16)`; datas usam `DATE`. Os códigos de base relacionados usam `VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin` em entradas do mapa, decisões, fatos e dados de origem que contêm código. Nas três fontes sem código (`collection_monitoring`, `collection_rate`, `jt_monitoring`), `source_base_name` agora também declara explicitamente `utf8mb4_0900_bin`, igual à chave de decisão por nome.

As relações auditadas são: fonte→contrato/job/publicação/decisão; contrato→colunas→aliases; job→erros, versão de mapa, publicação reutilizada e mapa validado; versão de mapa→entradas/decisões/ponteiro corrente; publicação→contrato/job/mapa; datas da publicação→head diário e fatos diários; publicação→head de snapshot e fatos; fatos→código oficial e, nas três fontes sem código, decisão exata de nome. Fatos diários agora têm FK composta `(source_id, publication_id, data_date)` para `source_publication_dates`, incluindo a data armazenada gerada de Taxa de Coleta. Isso impede fatos em datas que não pertençam à publicação.

Foram declarados índices filhos com colunas na mesma ordem das FKs; a criação não depende de índices implícitos automáticos. Isso inclui `(source_id, reused_publication_id)` em jobs; `(source_id, source_job_id, contract_version)` em versões do mapa; `(source_id, job_id, contract_version, map_version_id)` e `map_version_id` em publicações; `(source_id, publication_id)` no head de snapshot; e, nas fatos, as combinações de publicação/data, publicação/mapa, mapa/código e mapa/fonte/nome/código aplicáveis. As chaves referenciadas são PKs ou UNIQUEs declaradas no DDL. O arquivo de verificação ganhou consulta de `information_schema` para comparar tipo completo/sinal, comprimento, charset, collation, prefixo BTREE filho e índice único pai na ordem da FK.

O DDL não usa `ON DELETE CASCADE`; a ação padrão InnoDB é `NO ACTION` (equivalente a `RESTRICT`). Assim, cabeças novas não apagam publicações/fatos anteriores. A imutabilidade de registros publicados ainda depende de grants que neguem `UPDATE`/`DELETE` e do protocolo transacional do importador. Os ponteiros também não conseguem, só por FK, exigir estado `PUBLISHED`; as novas consultas de verificação identificam head/publicação/mapa com estado ou política incompatíveis. A compatibilidade da FK sobre `data_date` armazenada gerada e a collation `utf8mb4_0900_bin` precisa ser confirmada no kernel Tencent exato antes da aprovação.

## 4. De-para compartilhado e segurança

O contrato do de-para declarado anteriormente no projeto contém `Regional`, `UF`, `Região RM`, `Responsável Rm`, `Código da base`, `Nome da base` e `Descrição`, na aba `Ativas`. O Excel do de-para não está entre os cinco arquivos desta auditoria e precisa de uma auditoria própria antes de publicar seu contrato. O DDL só modela esses campos conhecidos; não inventa RGM, status, vigência ou outro código.

Monitoramento de Coleta, Taxa de Coleta e J&T não têm código da base nos arquivos auditados. Para essas três fontes:

1. Manter o nome original sem normalização como identificador reportado.
2. Criar na versão oficial do de-para uma decisão por `(fonte, nome exato)`, revisada por uma pessoa autorizada: `LINKED`, `UNREVIEWED`, `AMBIGUOUS` ou `REJECTED`. Nome vazio ou só com espaços não pode ser uma decisão.
3. Só `LINKED` guarda o código-alvo oficial. Não fazer fuzzy matching, não remover acentos/espaços e não usar regional do Excel para autorizar.
4. Nome ausente ou só com espaços recebe `MISSING_IDENTIFIER`; nome ambíguo recebe `AMBIGUOUS`; nome ainda sem decisão ou rejeitado recebe `UNMAPPED`. Todos mantêm `resolved_base_code=NULL`, continuam preservados na publicação e não são visíveis para escopos regionais/base. Diagnóstico de mapeamento exige permissão própria auditada. Só `NAME_APPROVED` aceita nome não vazio e código resolvido, e a FK composta confirma a decisão `LINKED` e o código da mesma versão do mapa.

Sem Movimentação e Falha na Coleta PDD têm código da base na origem. Converter o código numérico integral do Excel para dígitos em texto, sem preenchimento de zeros; comparar exatamente com `base_code`. `Código da Regional` da Falha PDD e todos os nomes/regionais reportados são dados de origem, não autorização.

Cada publicação fixa `map_version_id`, preservando como ocorreu a resolução. Em consultas, a autorização regional/base usa o código resolvido e a regional da versão oficial corrente. Código que não existe mais no mapa corrente não é retornado sob escopo regional/base até ser reconciliado. Atualizar o mapa não reescreve os fatos antigos. Essa regra evita que um relatório histórico retenha uma atribuição regional obsoleta; precisa ser confirmada junto da política de remapeamento.

O FastAPI resolve o escopo antes de executar qualquer projeção de linhas. A mesma condição restringe registros, datas disponíveis, opções de filtro, totais, agregações, erros, preview, histórico e exportação. `platform_role=ADMIN` dá capacidade de escrita administrativa e não amplia o escopo de leitura. Escopo `matrix`/nacional vem de autorização organizacional independente; acesso a não mapeados requer permissão específica e auditada. Por padrão, ADMIN que não tenha escopo nacional continua vendo apenas o próprio escopo.

## 5. Histórico, correções e idempotência

| Fonte | Recepção e validação | Publicação vigente / correção |
|---|---|---|
| Monitoramento de Coleta | Arquivo completo, aba e 22 cabeçalhos exatos; datas válidas; métricas inteiras ou taxas decimais; mapa por decisão exata de nome. | Cada data contida troca sua partição lógica inteira em uma transação. Datas ausentes no upload ficam vigentes. |
| Taxa de Coleta | Aba e 22 cabeçalhos exatos; preserva prazo `DATETIME`; aceita nulos observados em regional/base/horas; mapeia nome exato. | Cada data derivada do prazo troca todas as linhas daquela data; datas ausentes ficam vigentes. |
| Monitoramento J&T | Aba `sheet1`, 15 cabeçalhos; valida até 159.666 linhas ou novo limite aprovado; preserva seller ID textual e todas as linhas, inclusive duplicatas. Mapeia nome exato. | Cada data troca todas as linhas daquela data. Não usa chave presumida para `UPSERT`/dedupe. |
| Sem Movimentação | Aba e 18 cabeçalhos; exige códigos únicos no arquivo conforme amostra, códigos não vazios e cobertura de snapshot aprovada; join exato de código. | A publicação nova substitui o snapshot inteiro via `source_snapshot_head`. A data/hora de publicação é técnica; `last_operation_at` não identifica o snapshot. |
| Falha na Coleta PDD | Aba e 11 cabeçalhos; data válida; códigos de base/regional como texto; métricas inteiras ou taxas decimais; join exato pelo código da base. | A data presente troca suas linhas integralmente; datas ausentes ficam vigentes. |

Todas as publicações e linhas anteriores permanecem imutáveis. A substituição altera somente os ponteiros (`source_daily_head` ou `source_snapshot_head`) dentro da mesma transação que ativa a publicação. Falha ou validação reprovada deixa os ponteiros anteriores. Reversão aponta para uma publicação anterior e registra auditoria; não apaga fatos. As FKs não têm cascata de exclusão; grants de produção devem impedir `UPDATE`/`DELETE` em publicação e fatos, inclusive por operador de ingestão.

Chave primária `(publication_id, source_row_no)` impede repetir uma linha dentro da mesma publicação, sem remover duplicatas que já existam no arquivo. `SHA-256 + source_id + contract_version + map_version_id` identifica conteúdo idêntico. Reimport idêntico deve reutilizar a publicação existente ou reativar seus ponteiros e registrar o novo job como reuso; não cria um segundo conjunto de fatos ativo. Se mudar o contrato ou mapa, o fingerprint muda e gera nova publicação auditável.

## 6. Armazenamento e fluxo Excel → FastAPI → MySQL

1. O browser envia o arquivo `.xlsx` original em multipart. JSON de linhas enviado pelo browser não é entrada confiável.
2. FastAPI autentica e verifica capacidade de importar, tamanho e estrutura ZIP do arquivo, calcula SHA-256 e guarda o original em bucket COS privado (ou armazenamento privado equivalente) fora do checkout/Git. O banco guarda chave opaca, nome, tamanho e hash, não o binário.
3. O job fixa contrato e versão corrente do de-para. Parser server-side valida aba, cabeçalhos originais e ordem, ausência de fórmulas, tipos, nulidade, códigos, datas, duplicatas observadas, granularidade e modo diário/snapshot. Códigos numéricos integrais são convertidos a dígitos textuais sem arredondar ou completar zeros.
4. A prévia informa contagens por data, erros estruturais/campo, linhas sem base mapeada, duplicidades exatas e efeito de substituição. Não retorna linhas, filtros ou totais fora do escopo do solicitante; erros guardam contexto sanitizado.
5. ADMIN publica o job validado. A carga bloqueia a fonte/cabeças necessárias, grava publicação e fatos imutáveis, confere contagens e troca todos os ponteiros afetados atomicamente; a auditoria entra na mesma transação.
6. API de consulta lê somente cabeças vigentes por padrão. Consultas históricas exigem versão explícita e continuam submetidas ao escopo atual do usuário.
7. Dashboards migram um por vez por feature flag; durante comparação paralela, a leitura antiga continua disponível. Este trabalho não altera dashboards.

Retenção do bucket, criptografia em repouso, chave de KMS, região COS, limites de upload e prazos para jobs inválidos ainda precisam de decisão. O arquivo J&T tem 15,2 MB e 159.666 linhas na amostra; o parser e os limites devem ser dimensionados com esse volume e margem de crescimento.

## 7. APIs de consulta e administração propostas

Todas as rotas de leitura usam a sessão existente e o mesmo `DataScopeResolver`; IDs de fonte são allowlisted, filtros validados por contrato, cursores opacos e limite máximo por página. Não há SQL livre no request.

- `GET /api/v2/data-sources` — fontes disponíveis e estado da versão publicada.
- `GET /api/v2/data-sources/{source_id}/contract` — cabeçalhos oficiais e tipos visíveis.
- `GET /api/v2/data-sources/{source_id}/dates` — datas e contagens após escopo.
- `GET /api/v2/data-sources/{source_id}/records` — filtro por período, código-base autorizado e dimensões daquela fonte; paginação estável.
- `GET /api/v2/data-sources/{source_id}/publications` — versões e períodos visíveis conforme autorização.
- `POST /api/v2/imports` (multipart) — cria job e faz preview do arquivo original; capability administrativa de ingestão.
- `GET /api/v2/imports/{job_id}` e `GET /api/v2/imports/{job_id}/errors` — status/erros sanitizados e escopados.
- `POST /api/v2/imports/{job_id}/publish` — publica job validado com idempotency key, CSRF e auditoria.
- `POST /api/v2/imports/{job_id}/rollback` — reativa publicação anterior após revisão e auditoria.
- `POST /api/v2/base-mapping/imports` / `POST /api/v2/base-mapping/{version_id}/publish` — fluxo do mapa global, incluindo revisão explícita das correspondências por nome.
- `POST /api/v2/data-sources/{source_id}/exports` — export em stream/job; reaplica os mesmos filtros e escopo antes de linhas, total ou metadados.

Facetas (regional, base, origem, produto, cliente, loja e seller) só podem ser calculadas depois do escopo. A API não devolve o dataset integral para o browser. Consultas J&T tratam cliente/loja/seller como campos de linha protegidos pelo escopo, inclusive em exportação.

## 8. SQL de verificação somente leitura

As consultas em [data-foundation-v2-verification-queries.sql](../../backend/sql/data-foundation-v2-verification-queries.sql) são `SELECT` para revisão técnica: registry/contratos, todas as FKs/índices via `information_schema`, quantidade de tabelas, heads e estados de publicação, reconciliação entre publicações/datas/fatos, consistência de resolução por nome, mapa corrente, histórico retido e contagem J&T sem deduplicação. Consultas globais de diagnóstico podem revelar volumes entre regiões; devem ficar restritas ao operador autorizado e não podem alimentar uma API sem `DataScopeResolver`. Nenhuma consulta foi executada nesta revisão.

## 9. Implantação manual e reversível

1. **Aprovação:** fechar as decisões da seção 10, conferir o Excel do de-para, aprovar nulabilidade, duplicatas J&T e política de snapshot.
2. **Pré-requisitos sem produção:** confirmar kernel TXSQL exato, recursos, grants, TLS, backup/restauração, charset/collation, tamanho máximo de linha e suporte efetivo a FKs/CHECK. Fazer revisão estática do DDL e criar estrutura apenas em instância descartável separada.
3. **Cópia e legado:** inventariar e copiar para backup privado todo `DATA_DIRECTORY`, originais e ponteiros atuais; calcular hashes. Não apagar nem mover diretórios usados pelo app.
4. **Schema candidato:** DBA cria manualmente `redes_paineis_dados` e tabelas do DDL aprovado; conferir `SHOW CREATE TABLE`, constraints e índices. Seeds de fonte/contrato/mapa são revisados e aplicados manualmente, ainda sem redirecionar tráfego.
5. **Importador shadow:** implementar parser server-side e processar cópias dos cinco arquivos em staging. Comparar cabeçalhos, número de linhas, valores/nulos, datas, hash e contagens por data contra este inventário. Sem publicar no legado.
6. **Mapa e autorização:** carregar uma versão do de-para revisada; verificar códigos duplicados, decisões exatas de nome e cobertura. Exercitar USER de base, USER regional, ADMIN regional, escopo matrix autorizado e não mapeados em todas as saídas: linhas, facetas, totais e export.
7. **Comparação e piloto:** importar/publicar em banco candidato; comparar consultas com dashboards atuais, testar reenvio/correção por data, snapshot, arquivo idêntico, falha antes do commit e rollback de ponteiro. Nenhum resultado divergente fica sem explicação.
8. **Canário reversível:** depois de autorização separada para implementação, habilitar uma fonte por feature flag, monitorar volume/latência e manter leitura de filesystem em fallback. Expandir fonte a fonte.
9. **Rollback:** desligar feature flag e voltar ao leitor antigo; se necessário, reativar o `publication_id` anterior em transação auditada. Preservar arquivos e versões. Não executar limpeza/desativação do legado até decisão futura.

Sem criação automática de tabelas na inicialização do FastAPI e sem migrations automáticas. A etapa presente não executou nenhuma destas ações.

## 10. Pendências para decisão antes da implementação

1. Aprovar nomes exatos/ordem dos cinco cabeçalhos como contratos rígidos e nulabilidade `NOT NULL` proposta para campos sem vazios nas amostras.
2. Confirmar se cada upload de Monitoramento, Taxa, J&T e Falha PDD contém uma partição diária completa; a política proposta substitui integralmente toda data presente e preserva datas ausentes.
3. Confirmar que Sem Movimentação representa snapshot integral; a planilha não fornece data de geração nem marcador de completude. Definir controle de cobertura/contagem antes de publicar.
4. Decidir se os quatro pares exatos de J&T são registros válidos repetidos ou erros da origem. Até lá, preservar todos.
5. Auditar o arquivo e o contrato vigentes do de-para oficial: aba/cabeçalhos efetivos, formato dos códigos, dono de publicação, revisão de decisões por nome, dados de RM/UF e processo para nome ambíguo. Não assumir RGM, status ou vigência.
6. Confirmar equivalência dos códigos numéricos no Excel com `Código da base` do mapa; valores de Falha PDD incluem 5 e 6 dígitos. Não completar zeros automaticamente.
7. Aprovar política de escopo para `matrix`/nacional e capability para revisar linhas não mapeadas. `ADMIN` por si só não concede nenhum dos dois.
8. Aprovar que a regional atual do de-para seja usada para autorizar consultas históricas por código, mesmo quando a publicação original usou outra versão do mapa.
9. Definir bucket privado/região, criptografia, retenção de originais, jobs rejeitados, erros e auditoria; definir tamanho máximo para 159.666+ linhas.
10. Confirmar versão e recursos exatos do Tencent TXSQL, collation binária sem espaços finais, FK sobre coluna gerada armazenada e sintaxe/semântica de CHECK/FK antes de qualquer DDL em ambiente real. A referência do MySQL 8.0 documenta `utf8mb4_0900_bin` como `NO PAD` e as restrições de FKs para colunas geradas; confirmar que o kernel TXSQL mantém esse comportamento ([MySQL: collations](https://dev.mysql.com/doc/refman/8.0/en/charset-mysql.html), [MySQL: foreign keys](https://dev.mysql.com/doc/refman/8.0/en/create-table-foreign-keys.html), [Tencent TXSQL: versões do kernel](https://cloud.tencent.com/document/product/236/42539)).

**Parada desta etapa:** documentação, SQL proposto e consultas somente leitura foram preparados para revisão. A próxima etapa exige autorização explícita; nada foi executado em banco ou produção.
