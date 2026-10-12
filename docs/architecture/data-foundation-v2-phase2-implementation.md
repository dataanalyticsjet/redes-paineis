# Data Foundation V2 — implementação da Fase 2

**Estado:** implementação preparada para revisão; importação e consultas V2 permanecem desativadas. Nenhuma conexão com `redes_paineis_dados` foi aberta e nenhum SQL foi executado.

## O que entrou

- Configuração isolada `DATA_DB_*`; o código não reaproveita `DB_*`, que continuam no banco de usuários/autenticação `redes_paineis`.
- Cinco contratos operacionais versão 1, com aba, ordem e cabeçalhos conferidos contra os arquivos oficiais. Para `De_para DoomsDay.xlsx`, o operador confirmou que a cópia corresponde à versão vigente publicada: aba `Ativas`, 1.628 bases e nenhum código duplicado. No banco novo, a fonte/contrato ainda aguardam a aprovação controlada (`PENDING/DISCOVERED`).
- Parser `.xlsx` server-side com a biblioteca padrão: verifica ZIP/XML, aba, cabeçalho exato, fórmulas, datas Excel, números, taxas decimais, nulos, códigos, linhas vazias e duplicatas. Os códigos numéricos viram texto sem preencher zeros. Nomes são comparados por igualdade exata; correspondências candidatas são contadas, mas não aprovadas automaticamente.
- Prévia com linhas válidas/inválidas, duplicatas, partições por data, resolução de mapeamento, erros sanitizados e SHA-256. O parser trabalha em fluxo de linhas e preserva duplicatas da origem.
- Publicação transacional em fatos específicos, com publicação imutável e troca de `source_daily_head` ou `source_snapshot_head` na mesma transação. Reenvio idêntico reaproveita a publicação por fonte, contrato, mapa e hash.
- Migração inicial do de-para: a prévia aceita somente o arquivo com SHA-256 auditado `6d07265a…b1dbba`, 1.628 linhas válidas e códigos únicos; antes de publicar, a aplicação revalida o arquivo e conta as 1.628 linhas gravadas. Versão 1, entradas, job publicado, ponteiro vigente e auditoria são gravados na mesma transação. Retry com o mesmo job/chave retorna a versão existente; falha no meio faz rollback. Uma versão ou ponteiro preexistente bloqueia a migração. O mapa legado não é modificado.
- Consultas paginadas, contagens por data, filtros por período/base/regional e CSV usam a regional da versão corrente do de-para e a mesma condição de escopo. Linhas sem resolução aprovada não são liberadas. `ADMIN` conserva o escopo organizacional que já possui; escopo nacional requer `organizational_scope=matrix` explicitamente.
- As duas flags novas começam `false`; nenhuma rota V2 abre o banco de dados enquanto a função correspondente estiver desativada. O FastAPI não cria tabelas nem executa migrations.

## Contratos e histórico

| Fonte | Aba | Política implementada |
|---|---|---|
| `collection_monitoring` | `sheet0` | Substitui integralmente somente as datas presentes no arquivo. |
| `collection_rate` | `sheet0` | Substitui cada data derivada de `deadline_at`; preserva datas ausentes. |
| `jt_monitoring` | `sheet1` | Substitui somente as datas presentes e preserva linhas repetidas. |
| `no_movement` | `sheet0` | Troca o snapshot integral; não infere data de corte de `last_operation_at`. |
| `pdd_collection_failure` | `sheet0` | Substitui somente as datas presentes. |

Os registros iniciais estão em [phase2-contract-registry-v1.json](../../backend/data-foundation/phase2-contract-registry-v1.json). O SQL de carga manual correspondente está em [data-foundation-v2-phase2-contract-seed.sql](../../backend/sql/data-foundation-v2-phase2-contract-seed.sql); conforme confirmação do operador, o seed dos 6 registros de fonte, 6 contratos e 95 colunas foi executado e confirmado. Não o execute novamente. O contrato DoomsDay permanece `DISCOVERED` e a fonte aguarda ativação.

O plano do mapa está em [legacy-base-mapping-migration-v1.json](../../backend/data-foundation/legacy-base-mapping-migration-v1.json). O SHA-256 local corresponde ao fingerprint revisado e o operador confirmou a equivalência com a versão vigente na plataforma. Nenhuma linha de nome é ligada automaticamente. Nomes exatamente iguais ao `base_name` aparecem como candidatos na prévia, mas continuam fora das consultas regionais, contagens e exportações até uma decisão humana aprovada em `base_mapping_name_decisions`.

A aprovação e ativação controladas do contrato existente estão descritas em [data-foundation-v2-initial-mapping-approval.sql](../../backend/sql/data-foundation-v2-initial-mapping-approval.sql). Esse roteiro altera apenas estados/metadados nas tabelas existentes, mantém `history_policy=PENDING` para impedir publicação genérica e não cria nem modifica tabelas. Execute manualmente, somente após revisar os resultados e receber autorização.

## Rotas preparadas

- `GET /api/v2/base-mapping/current` (versão vigente e contagem de bases visíveis no escopo do usuário)
- `POST /api/v2/imports/preview`
- `POST /api/v2/imports/{job_id}/validate`
- `POST /api/v2/imports/{job_id}/publish`
- `GET /api/v2/imports/{job_id}`
- `GET /api/v2/data-sources` e `GET /api/v2/data-sources/{source_id}/contract`
- `GET /api/v2/data-sources/{source_id}/dates`
- `GET /api/v2/data-sources/{source_id}/publications`
- `GET /api/v2/data-sources/{source_id}/records` (página, total e filtros)
- `GET /api/v2/data-sources/{source_id}/export.csv` (página de até 10.000 linhas)
- `POST /api/v2/base-mapping/initial-migration/preview`
- `POST /api/v2/base-mapping/initial-migration/{job_id}/publish`
- `GET /api/v2/base-mapping/name-candidates/{job_id}` (somente ADMIN; lista valores da carga e candidatos exatos sem aprová-los)
- `POST /api/v2/base-mapping/name-decisions` (somente ADMIN; registra uma decisão explícita, exata, imutável por versão e auditada)

As rotas de importação, prévia, revalidação, decisões de nomes e publicação exigem sessão autenticada, papel `ADMIN` e `organizational_scope=matrix` explícito. A prévia apresenta contagens nacionais do arquivo enviado; por isso, um ADMIN regional/base recebe `403 matrix_scope_required`. O papel `ADMIN` não altera o escopo das consultas. A migração inicial exige a chave `Idempotency-Key`; seu hash fica na auditoria, e um retry do mesmo job com a mesma chave retorna a versão já publicada sem mover o ponteiro novamente.

## Central administrativa local

A tela **Central de Dados** está integrada ao início do produto e aparece para ADMIN. Ela lista contratos, estados, histórico de publicações visível no escopo, última publicação e status/contagem do de-para vigente. Administradores sem autorização `matrix` podem consultar somente o histórico/contagem do próprio escopo e não recebem ações de importação. ADMIN com escopo `matrix` pode enviar a prévia dos cinco Excels ou do de-para, ver erros/contagens/cobertura, revisar cada associação exata e confirmar a publicação. Nomes ambíguos nunca recebem ligação; nomes sem correspondência podem ser rejeitados com justificativa.

O backend continua com `DATA_QUERIES_ENABLED=false` e `DATA_IMPORT_ENABLED=false` por padrão. A tela informa quando a V2 está desligada. A implementação da interface não ativou flags, não conectou o frontend legado às novas consultas e não alterou dashboards.

Metadados de catálogo e contrato ficam disponíveis quando uma das duas flags está habilitada; o histórico de publicações e as consultas de datas/registros/exportação continuam condicionados a `DATA_QUERIES_ENABLED`. Isso permite revisar a migração inicial com importação habilitada e consultas ainda desligadas.

## Verificação local

O parser foi executado diretamente contra os cinco arquivos oficiais, sem banco, e encontrou:

| Fonte | Linhas | Válidas | Inválidas | Duplicatas integrais | Datas |
|---|---:|---:|---:|---:|---:|
| Monitoramento de Coleta | 3.877 | 3.877 | 0 | 0 | 6 |
| Taxa de Coleta | 3.269 | 3.269 | 0 | 0 | 5 |
| Monitoramento J&T | 159.666 | 159.666 | 0 | 4 | 4 |
| Sem Movimentação | 151 | 151 | 0 | 0 | snapshot |
| Falha na Coleta PDD | 1.617 | 1.617 | 0 | 0 | 1 |

Sem mapa carregado, os cinco arquivos continuam bloqueados para publicação. Com os códigos do DoomsDay usados apenas como fixture local de teste, `no_movement` encontrou 141/151 códigos e `pdd_collection_failure` 1.598/1.617. Nos três arquivos baseados em nome, ainda não há decisões aprovadas: há nomes distintos candidatos por igualdade exata (925 em Monitoramento de Coleta, 554 em Taxa de Coleta e 558 em J&T), e nomes sem igualdade exata (155, 43 e 66, respectivamente). Nenhum candidato foi resolvido automaticamente. Quatro duplicatas integrais de J&T continuam preservadas.

No clone Windows, a suíte completa do backend passou: **108 testes**, usando SQLite/temporários isolados; `DATA_FOUNDATION_REVIEW_WORKBOOKS` apontou para a pasta local dos arquivos oficiais. Depois da separação entre metadados e consultas, os **7 testes focados de escopo** passaram novamente. Nenhum teste conectou ao MySQL Tencent. O frontend passou com **114 testes** e build de produção. O build emite o aviso de chunk maior que 500 kB já observado no projeto; o backend mostra um aviso de depreciação do `starlette.testclient`/`httpx`, sem falhas.

Na revisão do fluxo de migração inicial, passaram **3 testes** focados em aprovação pendente, retry/idempotência e rollback; o cenário integrado com o arquivo local passou com **1 teste** e confirmou uma única versão 1 com 1.628 entradas; os testes de contratos/escopo passaram com **23 testes**; e `corepack pnpm test` passou com **114 testes** e build. Todos os testes de migração usaram SQLite e staging temporário; o arquivo Excel foi lido sem alteração e o Tencent não foi acessado.

## Procedimento manual futuro

1. Conectar manualmente ao banco Tencent e conferir `SELECT DATABASE()` = `redes_paineis_dados`, 20 tabelas, 37 FKs, InnoDB nas tabelas usadas, 6 fontes/6 contratos/95 colunas e versão/entradas/ponteiro do mapa ainda vazios. Compare o `SHOW CREATE TABLE` com o DDL de referência; não execute DDL.
2. No Windows, confirmar o arquivo original sem alterá-lo: `Get-FileHash 'C:\Users\phelippe.cardoso\Downloads\De_para DoomsDay.xlsx' -Algorithm SHA256`. O hash deve corresponder ao fingerprint aceito pelo código (`6d07265a…b1dbba`). A equivalência com a versão publicada, aba `Ativas`, 1.628 bases e zero códigos duplicados foi confirmada pelo operador.
3. Revisar as sete linhas de `source_contract_columns` contra o contrato versionado e o resultado do preflight. No SQL de aprovação, informar o ID real do ADMIN matrix responsável; executar cada bloco na mesma conexão, conferir `ROW_COUNT()=1` para a aprovação e ativação, revisar a auditoria e o estado final, e somente então emitir `COMMIT` manual. Em divergência, `ROLLBACK` e parar. Não execute o seed outra vez. Mantenha `history_policy=PENDING`.
4. Para a carga, configurar a identidade Tencent dedicada em `DATA_DB_*` com acesso somente ao schema `redes_paineis_dados`; manter `DB_*` no banco de autenticação. A identidade da aplicação não precisa de `CREATE`, `ALTER` ou `DROP`, nem de `UPDATE/DELETE` nos fatos ou nas entradas imutáveis do mapa. A aprovação do catálogo/contrato é operação separada.
5. Configurar `DATA_IMPORT_STAGING_DIRECTORY` para diretório privado fora do checkout, com proteção/retention aprovadas. As flags permanecem desligadas até a janela autorizada; ao preparar a execução, habilitar `DATA_IMPORT_ENABLED=true` e deixar `DATA_QUERIES_ENABLED=false`.
6. Em uma versão aprovada da aplicação, um ADMIN matrix envia o arquivo na Central de Dados e confere prévia `1.628 válidas`, `0 inválidas`, `0 códigos duplicados` e hash esperado. Só após essa conferência confirma a migração inicial. A publicação via rota dedicada cria job, versão 1, entradas e ponteiro em uma transação; não faça `INSERT` manual nas tabelas do mapa.
7. Repetir a confirmação HTTP com o mesmo job e `Idempotency-Key` é seguro: retorna a mesma versão. A UI usa `base-mapping-initial:<jobId>` como chave estável. Falha durante a transação deve deixar job `VALIDATED`, nenhuma versão/entrada/ponteiro parcial e nenhuma auditoria de publicação; corrija o problema antes de nova tentativa.
8. Execute as verificações pós-carga do SQL de aprovação: versão 1 `PUBLISHED`, job `PUBLISHED`, 1.628 entradas e bases únicas, ponteiro `OFFICIAL` apontando para a versão publicada e uma auditoria `LEGACY_MAPPING_MIGRATED`. Confirme novamente que o arquivo legado e o banco de produção permanecem inalterados. Não habilite `DATA_QUERIES_ENABLED` nesta migração.

## Pendências e limites

- O operador confirmou que a cópia DoomsDay é a mesma versão publicada na plataforma. O seed/schema do banco novo foram confirmados pelo operador. A aprovação do contrato e a carga inicial ainda não foram executadas nesta etapa.
- A tela de administração e o fluxo manual de revisão foram concluídos. Uma ligação exige igualdade exata com `base_name`, alvo único e justificativa; decisões já gravadas não são sobrescritas. Nomes sem candidato e nomes ambíguos continuam sem liberação regional.
- Permanecem decisões de negócio documentadas: confirmar completude diária dos quatro arquivos, cobertura do snapshot Sem Movimentação e tratamento futuro das quatro duplicatas de J&T. A implementação preserva todas elas.
- O armazenamento de staging local privado é uma base técnica; criptografia/retention e integração com COS/KMS precisam de decisão operacional antes de ativar importação em servidor.
- A confirmação de 20 tabelas/37 FKs e do seed foi fornecida pelo operador; esta revisão local não conectou ao schema vivo. O SQL manual preparado não cria tabelas nem contém DDL.
- O mapa legado, o banco de produção, o servidor e o Excel oficial não foram alterados. Nesta etapa não houve conexão Tencent, execução de DML/DDL, carga, deploy, commit ou push.
