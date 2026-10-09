# Central de Dados V2 — Fase 1: Sem Movimentação

> **Histórico supersedido.** A auditoria dos cinco Excels oficiais e a arquitetura completa estão em [data-foundation-v2.md](data-foundation-v2.md), com DDL em `backend/sql/data-foundation-v2-proposal.sql`. Este rascunho anterior cobre somente um piloto Sem Movimentação e não deve ser usado como contrato atual.

**Status:** material de aprovação; ainda não é implementação. Nenhum SQL foi executado, nenhuma conexão foi feita e os dashboards existentes permanecem fora do escopo.

Esta proposta reduz o DDL geral de 20 tabelas para 13 tabelas: 12 de controle e uma tabela de fatos para o piloto `movement`. O desenho preserva o fluxo legado em filesystem enquanto a Central de Dados é validada em paralelo.

## 1. Escopo e tabelas

| Tabela | Finalidade na Fase 1 |
|---|---|
| `data_source_registry` | IDs estáveis, estado, política de histórico e contador de versão serializado por fonte. Registrar `movement` e `base_mapping_official`. |
| `source_contract_versions` | Contratos imutáveis por fonte, aba e linha do cabeçalho aprovadas, versão e estado de aprovação. |
| `source_contract_columns` | Colunas canônicas, tipos, ordem, obrigatoriedade, nulidade e código de validação. |
| `source_contract_aliases` | Só aliases revisados; a Fase 1 começa sem aliases aprovados. |
| `import_jobs` | Upload, hash, arquivo em staging, autor, estado e contagens de validação. |
| `import_job_errors` | Erros consultáveis por job, linha e coluna; sem guardar valores sensíveis da linha inteira. |
| `base_mapping_versions` | Cada publicação imutável do `De_para DoomsDay.xlsx`, com versão, arquivo/hash, autor e data. |
| `base_mapping_entries` | Linhas do de-para de uma versão; código oficial único dentro dessa versão. |
| `base_mapping_current` | Um único ponteiro para a versão oficial vigente, protegido por uma chave de domínio único. |
| `source_publications` | Uma versão publicada por job, fonte e contrato; fixa a versão do mapa e registra contagens. |
| `source_snapshot_head` | Uma publicação vigente por fonte de snapshot. Versões antigas continuam preservadas. |
| `data_audit_events` | Auditoria de publicação de dados e mapa, alterações de ponteiros, ator e request ID. |
| `fact_movement_snapshot` | Registros tipados do snapshot Sem Movimentação, vinculados à publicação e à versão do de-para. |

Não entram nesta etapa tabelas diárias nem fatos de Monitoramento, Taxa, J&T, PDD, EPOP ou Extravio. `source_publication_dates` também fica fora: o piloto é snapshot integral, sem datas de negócio fornecidas pelo arquivo.

## 2. Chaves, integridade, índices e histórico

- `source_publications` tem chaves únicas para `(source_id, publication_id)`, `(source_id, version_no)`, `(source_id, job_id)` e `(publication_id, map_version_id)`. A FK composta `(source_id, job_id, contract_version, map_version_id)` confirma que a publicação usa o mesmo job, fonte, contrato e versão do mapa validada na prévia.
- `fact_movement_snapshot` contém `source_id`, `publication_id` e `map_version_id`. `source_id` tem o mesmo `VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin` da publicação; um `CHECK` limita seu valor a `movement`, e FKs compostas impedem associar o fato a publicação de outra fonte ou a mapa diferente daquele fixado na publicação.
- O fato guarda o código textual original. A resolução é um `LEFT JOIN` exato por `(map_version_id, base_code)`. Isso conserva linhas sem correspondência e não inventa um `map_entry_id` ou regional para elas.
- `base_mapping_entries` tem PK `(map_version_id, base_code)`: códigos duplicados no mesmo snapshot oficial não podem ser publicados. `utf8mb4_0900_bin` preserva caixa e considera espaços finais na comparação; códigos em branco são rejeitados. A versão permanece imutável.
- `base_mapping_current.current_key` só aceita o valor `OFFICIAL` (`ENUM` de um valor) e é PK. Assim, há no máximo um ponteiro oficial vigente sem depender de `CHECK`.
- `source_snapshot_head.source_id` é PK, portanto uma fonte tem no máximo um snapshot ativo. A FK impede apontar para publicação de outra fonte; o estado `PUBLISHED` é validado pelo protocolo transacional e pelas consultas de verificação, não pela FK isolada.
- A PK do fato é `(publication_id, source_row_no)`. O código da base **não** é declarado chave natural nesta etapa: o Excel real não foi encontrado e a unicidade por base ainda não está comprovada. Não deduplicar linhas presumindo essa regra.
- Jobs de Sem Movimentação gravam `validation_map_version_id` no momento da prévia. A publicação usa esse mesmo valor por FK composta. Se o mapa vigente mudar antes da confirmação, o job é revalidado em vez de publicar silenciosamente com um mapa diferente. `last_version_no` em `data_source_registry` é incrementado sob lock da linha de fonte dentro da transação de publicação.
- Os índices incluem suporte explícito a todas as FKs, além de consultas pelo snapshot vigente e base: publicação/fonte/código no fato; versão/regional/código no de-para; fonte/contrato e mapa fixado nos jobs; job/linha nos erros. Não criar índice para cada filtro sem medir `EXPLAIN` em MySQL de teste.
- Publicações e versões oficiais não são apagadas ao substituir o ponteiro. Arquivos publicados devem ser retidos junto à política de auditoria aprovada. Retenção proposta para revisão: fatos/publicações/mapas publicados enquanto houver necessidade operacional; arquivos de jobs inválidos por 30 dias; erros detalhados por 180 dias. Os prazos não estão aprovados.

O SQL usa InnoDB, `utf8mb4`, IDs estáveis ASCII, códigos de base como `VARCHAR` binário (preserva zeros, caixa e espaços finais), `BIGINT UNSIGNED` para contagens inteiras e `DECIMAL` para taxas. O alvo desta proposta é Tencent TXSQL compatível com MySQL 8.0.30; os `CHECK`s restringem a fonte do fato, a fonte do mapa oficial e códigos vazios. Foram evitados JSON, índices funcionais e `UUID_TO_BIN`. As colunas das FKs foram alinhadas em tipo, tamanho, sinal, charset e collation; os índices filhos necessários estão declarados explicitamente. A compatibilidade final ainda requer conferência no kernel exato e em banco descartável de teste. ([manual de FKs do MySQL 8.0](https://dev.mysql.com/doc/refman/8.0/en/create-table-foreign-keys.html), [manual de CHECK do MySQL 8.0](https://dev.mysql.com/doc/refman/8.0/en/create-table-check-constraints.html), [collations binárias `PAD SPACE` e `NO PAD`](https://dev.mysql.com/doc/refman/8.0/en/charset-binary-collations.html))

## 3. Contrato do Excel Sem Movimentação

O contrato abaixo é a proposta mais estrita que o código e os testes locais sustentam. **Não é possível declarar aba e granularidade de negócio definitivas sem o Excel operacional real.** A busca local não encontrou esse arquivo; os `.xlsx` encontrados são fixtures geradas por testes, não substitutos para validação real.

| Campo canônico exato | Tipo proposto | Obrigatório / nulidade | Observações |
|---|---|---|---|
| `Regional responsável` | texto | coluna obrigatória; valor pode ser vazio | Guardado só para auditoria. Nunca autoriza acesso. |
| `Código da unidade responsável` | código textual, até 64 caracteres | obrigatório e não nulo | Chave oficial para o de-para, comparada com collation binária. Não converter célula numérica para código; zero à esquerda já perdido não pode ser reconstruído. |
| `Nome da unidade responsável` | texto, até 191 caracteres | obrigatório e não nulo | Nome informado no arquivo; não resolve nem desempata mapeamento. |
| `Total de pedidos sem movimentação` | inteiro não negativo | obrigatório e não nulo | Armazenar como `BIGINT UNSIGNED`; célula vazia ou fracionária é erro, não zero implícito. |
| `Qtd pedidos em trânsito` | inteiro não negativo | obrigatório e não nulo | Idem. |
| `Sem mov. há mais de 1 dia` | inteiro não negativo | obrigatório e não nulo | Idem. |
| `Sem mov. há mais de 2 dias` | inteiro não negativo | obrigatório e não nulo | Idem. |
| `Sem mov. há mais de 3 dias` | inteiro não negativo | obrigatório e não nulo | Idem. |
| `Sem mov. há mais de 4 dias` | inteiro não negativo | obrigatório e não nulo | Idem. |
| `Sem mov. há mais de 5 dias` | inteiro não negativo | obrigatório e não nulo | Idem. |
| `Sem mov. há mais de 6 dias` | inteiro não negativo | obrigatório e não nulo | Idem. |
| `Sem mov. há mais de 7 dias` | inteiro não negativo | obrigatório e não nulo | Idem. |
| `Sem mov. há mais de 10 dias` | inteiro não negativo | obrigatório e não nulo | Idem. |
| `Sem mov. há mais de 14 dias` | inteiro não negativo | obrigatório e não nulo | Idem. |
| `Sem mov. há mais de 30 dias` | inteiro não negativo | obrigatório e não nulo | Idem. |
| `Horário da última operação` | data/hora Excel ou texto em formato aprovado | coluna obrigatória; valor pode ser nulo | Evento da última operação, não é data do snapshot. Preservar como horário local informado, sem conversão de fuso presumida. |
| `Taxa de sem mov 14+dias` | decimal normalizado para proporção | coluna obrigatória; valor pode ser nulo | Proposta `DECIMAL(12,8)` e faixa `[0,1]`; formato e nulidade precisam ser confirmados no arquivo real. |
| `Taxa de sem mov 30+dias` | decimal normalizado para proporção | coluna obrigatória; valor pode ser nulo | Mesma regra da taxa de 14 dias. |

**Aba:** pendente. O adapter atual não fixa aba; `sheet0` dos testes e `Dados` de fixtures são nomes sintéticos, não evidência do arquivo real. O backend deve deixar `expected_sheet` pendente e bloquear publicação até registrar a aba observada e aprovada.

**Cabeçalho:** linha 1 é a hipótese inicial pelo parser/testes locais; confirmar com arquivo real. Inicialmente aceitar somente as 18 colunas canônicas acima, com comparação de cabeçalho normalizada para caixa, acentos e espaços. Não aplicar aliases implícitos. Colunas extras ou cabeçalhos que colidam após normalização bloqueiam publicação até revisão e nova versão do contrato.

**Formato:** propor `.xlsx` no primeiro piloto. `.xls` só será habilitado após selecionar e testar parser no backend. Datas Excel devem respeitar o sistema 1900/1904 registrado no workbook; datas impossíveis e formatos ambíguos geram erro, sem fallback silencioso.

**Granularidade e chave:** um registro da planilha por linha fonte; unicidade técnica `(publication_id, source_row_no)`. Ainda não afirmar “uma linha por base” nem impor `UNIQUE(publication_id, base_code)`. O arquivo real precisa confirmar se há várias linhas legítimas por código.

**Snapshot:** cada upload válido é uma fotografia integral e substitui o snapshot ativo. O arquivo não possui coluna confirmada de data do snapshot. `Horário da última operação` não preenche essa lacuna; a versão será identificada por `version_no` e `published_at`. `snapshot_as_of` fica nulo até existir uma data de corte explicitamente confirmada pelo operador ou contrato.

### Contrato do de-para

O inventário documentado do cadastro oficial aponta a aba `Ativas` e os campos `Regional`, `UF`, `Região RM`, `Responsável Rm`, `Código da base`, `Nome da base`, `Descrição`. A worktree não contém o `.xlsx` oficial, portanto essa lista não foi conferida diretamente nesta revisão. O inventário disponível não registra `RGM`; o SQL não cria essa coluna nem a infere. Também não adicionar vigência ou status histórico sem evidência no arquivo oficial. Bloquear publicação se um código obrigatório estiver vazio ou se houver código repetido na mesma versão. Nomes duplicados não desempatarão códigos.

Cada upload oficial cria uma versão imutável. Publicar uma nova versão troca `base_mapping_current` numa transação; fatos antigos continuam associados à versão que usaram. Publicar o mapa exige ADMIN com permissão específica de gestão de mapeamento. Isso não concede leitura nacional dos dados do dashboard.

## 4. Segurança e escopo

- USER e ADMIN continuam consultando somente o escopo concedido em `redes_paineis`; o perfil ADMIN não significa escopo nacional.
- Para regional/base, o backend filtra usando a entrada exata de `base_mapping_entries` da versão fixada à publicação. A regional reportada no Excel é apenas auditoria.
- Código sem correspondência fica visível apenas a uma sessão com capability nacional explícita e auditada. A mesma regra vale para contagens, metadados, filtros, prévias, erros e exportação.
- Preview de upload não pode devolver linhas ou contagens de regionais fora do escopo do ADMIN que o solicitou. Publicar é uma permissão de escrita; não aumenta o escopo de leitura.
- Registros do de-para não aparecem no explorer operacional como forma de conceder acesso. O Query Service combina identidade e grants da base `redes_paineis` com o snapshot imutável no banco de dados.

## 5. Fluxo técnico e endpoints

Manter as rotas atuais em paralelo e criar uma API da Central de Dados versionada sob `/api/data-platform`, sem redirecionar o dashboard nesta etapa.

| Operação | Endpoint proposto | Acesso |
|---|---|---|
| Listar fontes e estado | `GET /api/data-platform/sources` | Sessão; apenas metadados permitidos. |
| Detalhe, contrato e cobertura | `GET /api/data-platform/sources/{source_id}` e `/schema` | Sessão; aplicar escopo às contagens/cobertura. |
| Receber e validar Excel | `POST /api/data-platform/sources/{source_id}/imports` multipart | ADMIN; parser do backend, tamanho/formato limitado. |
| Status e prévia paginada | `GET /api/data-platform/imports/{job_id}` e `/preview?limit=&cursor=` | ADMIN; conteúdo da prévia ainda respeita row scope. |
| Erros paginados | `GET /api/data-platform/imports/{job_id}/errors?limit=&cursor=` | ADMIN/autor conforme política; sem dados fora do escopo. |
| Confirmar publicação | `POST /api/data-platform/imports/{job_id}/publish` | ADMIN; idempotency key; validação final e troca atômica do snapshot. |
| Consultar histórico | `GET /api/data-platform/sources/{source_id}/versions` | Sessão; limitar metadados ao escopo. |
| Consultar snapshot atual ou versão | `GET /api/data-platform/sources/{source_id}/records?version=&base_code=&region=&limit=&cursor=` | Sessão; paginação no servidor; escopo antes de filtros/agregações. |
| Upload e publicação do mapa | `POST /api/data-platform/mappings/base-official/imports` e `POST /api/data-platform/mappings/base-official/imports/{job_id}/publish` | ADMIN com capability de gestão do mapa. |
| Ver versão vigente/cobertura do mapa | `GET /api/data-platform/mappings/base-official` | Sessão autorizada; sem expor linhas/contagens nacionais a regional. |

No servidor: autenticar Feishu; validar sessão, CSRF/origem e papel/capability; criar job; guardar Excel original em staging privado fora do checkout; validar hash/tamanho/zip; parsear a aba aprovada; validar contrato, códigos e números; resolver cobertura pelo código contra o mapa vigente e fixar essa versão no job; devolver prévia/erros paginados; carregar fatos da publicação `PREPARED`; numa transação única, bloquear a linha da fonte e os ponteiros, alocar a próxima versão, marcar a publicação `PUBLISHED`, trocar `source_snapshot_head` e gravar auditoria. O mapa oficial segue o mesmo padrão: nova versão imutável preparada e troca transacional de `base_mapping_current`. Se o mapa vigente mudar entre preview e publicação, exigir nova validação. Falha ou timeout antes do commit deixa os ponteiros anteriores intactos. O DDL não implementa esse serviço nem restringe mudanças de estado por si só; aplicação e grants devem impedir edição/remoção de versões publicadas. Uma rotina de retenção pode limpar jobs inválidos e staging expirado após o prazo aprovado.

Todos os endpoints de consulta usam cursor estável e limite máximo no servidor. O navegador nunca recebe o dataset completo. Exportação futura deve reutilizar a mesma query paginada e autorização.

## 6. Compatibilidade com o sistema atual

1. Não alterar adapters, rotas, persistência local nem dashboard Sem Movimentação durante a construção da Central.
2. A leitura legada continua apontando para a versão de filesystem atual. O novo upload/publicação escreve somente em `redes_paineis_dados` e é consumido pelo Data Explorer da Central.
3. Validar com arquivos locais em ambiente de desenvolvimento/teste MySQL; comparar cabeçalhos, códigos, quantidades, mapeamento e amostras com o fluxo legado.
4. Manter feature flag de leitura do dashboard desligada. Ativação futura por fonte é uma etapa distinta, após aprovação e comparação paralela.
5. Rollback do piloto: desligar a feature flag; se a nova leitura tiver sido habilitada posteriormente, voltar à leitura local. Para corrigir publicação, apontar `source_snapshot_head` a uma publicação anterior em transação auditada; nunca apagar fatos/versões para fazer rollback.

## 7. Plano de implementação e aprovação

1. Obter o Excel real local do Sem Movimentação e do `De_para DoomsDay.xlsx`; aprovar aba, header row, formatos, nulidade de taxas, códigos como texto e granularidade.
2. Confirmar versão MySQL Tencent, grants isolados para `redes_paineis_dados`, TLS, charset, limites, backup e espaço. Nada disso será consultado em produção nesta etapa.
3. Aprovar o DDL e política de retenção; testar instalação e integridade somente em MySQL local/teste com cópia descartável.
4. Implementar registry/contratos, upload binário server-side, job/preflight, erros e preview paginados.
5. Implementar import versionado do de-para e row-scope central por código; testar nacional não mapeado e escopo regional/base.
6. Implementar publicação snapshot/fato/ponteiro atômica e auditável, ainda sem alteração do dashboard legado.
7. Implementar Data Explorer administrativo e consultas paginadas; comparar resultado com o fluxo legado usando o mesmo arquivo local.
8. Só após aprovação específica, propor feature flag e eventual leitura do painel pelo novo Query Service.

### Regressões antes de ativação

- Workbook: aba/cabeçalho, aliases aprovados, coluna extra, duplicidade de cabeçalho, datas 1900/1904, códigos alfanuméricos/zeros à esquerda, números negativos/fracionários, célula vazia e taxas em fração/percentual.
- Importação: permissões ADMIN/USER, upload truncado, hash, erros paginados, idempotência, arquivos grandes e limpeza de staging.
- De-para: código exato, código duplicado bloqueado, nome divergente sem desempate, código sem correspondência sem regional, atualização de mapa não reclassifica versão antiga.
- Integridade: publicação não combina fonte/contrato/job errados; fato combina fonte/publicação e mapa da publicação; uma só versão oficial vigente; um snapshot ativo por fonte.
- Atomicidade/histórico: publicação válida substitui foto inteira; erro/falha antes do commit preserva head anterior; versões anteriores consultáveis; rollback de head auditado.
- Segurança/API: USER não publica; ADMIN não vira nacional; row scope aplicado também em metadados, filtros, preview, erros e export; paginação estável não vaza totais.
- Desempenho: import e consulta com fixture grande em MySQL de teste; medir `EXPLAIN`, memória do parser e tempo de publicação.

## 8. Decisões ainda necessárias

- Disponibilizar planilhas reais em diretório local de revisão. Sem elas, aba, header row, formato das taxas e chave de negócio não podem ser fechados.
- Confirmar se cabeçalhos extras devem ser rejeitados (recomendação: sim até aprovação de contrato novo).
- Aprovar parser backend e se `.xls` ficará fora do primeiro piloto.
- Confirmar se taxas armazenadas no Excel são fração, percentual ou têm nulos válidos.
- Confirmar capability para gestão do de-para e para leitura nacional de códigos sem correspondência.
- Aprovar retenção de arquivos/erros/auditoria e fluxo de backup/restore.
- Confirmar versão Tencent e grants antes de fechar compatibilidade do DDL.

## Artefatos

- DDL manual da Fase 1: `backend/sql/data-foundation-v2-phase1-proposal.sql`.
- Consultas SQL de verificação apenas para revisão: `backend/sql/data-foundation-v2-phase1-verification-queries.sql`.
- DDL amplo anterior, com 20 tabelas, permanece preservado como referência; não foi substituído.
