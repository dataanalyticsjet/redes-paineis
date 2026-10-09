# Data Foundation V2 — implementação da Fase 2

**Estado:** implementação preparada para revisão; importação e consultas V2 permanecem desativadas. Nenhuma conexão com `redes_paineis_dados` foi aberta e nenhum SQL foi executado.

## O que entrou

- Configuração isolada `DATA_DB_*`; o código não reaproveita `DB_*`, que continuam no banco de usuários/autenticação `redes_paineis`.
- Cinco contratos operacionais versão 1, com aba, ordem e cabeçalhos conferidos contra os arquivos oficiais. O contrato de `De_para DoomsDay.xlsx` também foi conferido: aba `Ativas`, sete cabeçalhos oficiais, 1.628 linhas válidas e códigos únicos. Fonte e contrato continuam `PENDING/DISCOVERED`; ainda falta confirmar que a cópia é exatamente a versão vigente publicada na plataforma.
- Parser `.xlsx` server-side com a biblioteca padrão: verifica ZIP/XML, aba, cabeçalho exato, fórmulas, datas Excel, números, taxas decimais, nulos, códigos, linhas vazias e duplicatas. Os códigos numéricos viram texto sem preencher zeros. Nomes são comparados por igualdade exata; correspondências candidatas são contadas, mas não aprovadas automaticamente.
- Prévia com linhas válidas/inválidas, duplicatas, partições por data, resolução de mapeamento, erros sanitizados e SHA-256. O parser trabalha em fluxo de linhas e preserva duplicatas da origem.
- Publicação transacional em fatos específicos, com publicação imutável e troca de `source_daily_head` ou `source_snapshot_head` na mesma transação. Reenvio idêntico reaproveita a publicação por fonte, contrato, mapa e hash.
- Migração inicial do de-para bloqueada até revisão: a prévia aceita somente o arquivo com SHA-256 auditado `6d07265a…b1dbba`, 1.628 linhas válidas e códigos únicos; a publicação cria a versão 1 imutável e falha se já existir versão/ponteiro no banco novo. Não modifica o mapa legado.
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

Os registros iniciais estão em [phase2-contract-registry-v1.json](/tmp/redes-paineis-data-foundation-v2/backend/data-foundation/phase2-contract-registry-v1.json). O SQL de carga manual correspondente está em [data-foundation-v2-phase2-contract-seed.sql](/tmp/redes-paineis-data-foundation-v2/backend/sql/data-foundation-v2-phase2-contract-seed.sql); ele contém apenas `INSERT` de catálogo/contrato, começa em `PENDING/DISCOVERED`, não aprova aliases e **não foi executado**.

O plano do mapa está em [legacy-base-mapping-migration-v1.json](/tmp/redes-paineis-data-foundation-v2/backend/data-foundation/legacy-base-mapping-migration-v1.json). O arquivo foi analisado localmente e seu fingerprint foi registrado; o operador ainda deve confirmar que ele é a cópia da versão vigente na plataforma. Nenhuma linha de nome é ligada automaticamente. Nomes exatamente iguais ao `base_name` aparecem como candidatos na prévia, mas continuam fora das consultas regionais, contagens e exportações até uma decisão humana aprovada em `base_mapping_name_decisions`.

## Rotas preparadas

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

As rotas de importação exigem sessão autenticada, papel `ADMIN`, origem do frontend configurada e chave de idempotência para publicação. O papel `ADMIN` só habilita a capacidade de escrita; ele não altera o escopo das consultas.

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

`compileall` concluiu sem erros. As dependências do `backend/requirements.txt` foram instaladas somente em `/tmp/redes-paineis-data-foundation-v2-venv`. Os testes focados de contrato, mapping, escopo e configuração passaram. A suíte completa está em execução para a revisão atual.

## Procedimento manual futuro

1. Conferir o schema já criado com as consultas existentes de verificação e comparar os `SHOW CREATE TABLE` com o DDL de referência. Esta revisão estática encontrou 20 tabelas e 37 FKs no arquivo local, mas o schema vivo não foi consultado.
2. Confirmar que `De_para DoomsDay.xlsx` (SHA-256 registrado) é exatamente a versão do de-para publicada na plataforma. A auditoria local já confirmou aba/cabeçalhos, 1.628 linhas e códigos únicos. Preservar o arquivo original e não modificar a cópia publicada na plataforma.
3. Revisar os contratos e a nulabilidade frente às decisões pendentes da documentação. Um responsável aplica manualmente o seed, mantendo fontes `PENDING` e contratos `DISCOVERED`; depois aprova e ativa somente o que foi revisado.
4. Configurar, no ambiente server-side, `DATA_DB_HOST`, `DATA_DB_PORT`, `DATA_DB_NAME=redes_paineis_dados`, `DATA_DB_USER` e `DATA_DB_PASSWORD` com uma identidade Tencent dedicada. Manter `DB_*` apontando para o banco de autenticação. O usuário da aplicação não precisa de `CREATE`, `ALTER` ou `DROP`; deve ter `SELECT` para as consultas, `INSERT` nas tabelas operacionais e de controle, `UPDATE` somente em `import_jobs`, `source_publications`, `source_daily_head`, `source_snapshot_head` e `base_mapping_versions`, e `DELETE` somente em `import_job_errors` para revalidação. Não conceder `UPDATE/DELETE` nos fatos nem `UPDATE/DELETE` nas entradas imutáveis do de-para. A aplicação não altera o catálogo/contratos; o seed e as aprovações ficam com operador separado.
5. Configurar `DATA_IMPORT_STAGING_DIRECTORY` para diretório privado fora do checkout, em volume protegido e com retenção/backup aprovados. O backend aplica permissões `0700` no diretório e `0600` nos arquivos; COS/KMS não foi integrado nesta fase.
6. Com revisão e autorização separadas, habilitar primeiro `DATA_IMPORT_ENABLED=true`, pré-visualizar a cópia do mapa e publicar sua versão 1. Revisar as decisões exatas de nomes antes de habilitar cargas operacionais.
7. Testar as cinco prévias e as consultas por USER de base, USER regional, ADMIN regional e matrix explicitamente autorizado em ambiente candidato. Confirmar contagens, datas, duplicatas, exportações e que não mapeados ficam invisíveis.
8. Habilitar `DATA_QUERIES_ENABLED=true` somente depois dessa revisão. Os dashboards existentes não foram ligados às rotas V2 e não foram modificados.

## Pendências e limites

- A cópia DoomsDay passou a validação estrutural, mas ainda falta confirmar sua equivalência com a versão atualmente publicada na plataforma. A carga inicial continua sem execução.
- Não há tela administrativa para essas decisões; os dois endpoints de revisão estão preparados. Uma ligação exige igualdade exata com `base_name`, alvo único e justificativa; decisões já gravadas não são sobrescritas. Nomes sem candidato e nomes ambíguos continuam sem liberação regional.
- Permanecem decisões de negócio documentadas: confirmar completude diária dos quatro arquivos, cobertura do snapshot Sem Movimentação e tratamento futuro das quatro duplicatas de J&T. A implementação preserva todas elas.
- O armazenamento de staging local privado é uma base técnica; criptografia/retention e integração com COS/KMS precisam de decisão operacional antes de ativar importação em servidor.
- A análise do schema usa o DDL de referência local e não substitui a conferência do schema vivo. Nenhuma incompatibilidade conhecida exigiu alterar tabela; nenhuma das 20 tabelas foi tocada.
- Os dashboards legados, o servidor, o Excel oficial e a outra worktree não foram alterados. Não houve commit, push, deploy nem execução de DML/DDL.
