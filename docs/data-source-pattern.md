# Padrão de fontes de dados dos dashboards

Este padrão concentra validação de arquivo, chamadas HTTP, estados do modal, prévia, importação e remoção. Cada painel mantém seu contrato, parser/normalizador e transformação para o formato consumido por seus componentes atuais.

## Catálogo atual

IDs de fonte são estáveis e independentes das rotas/nome visual dos painéis:

| ID | Painel | Estado da fonte |
| --- | --- | --- |
| `monitoring` | Monitoramento de coletas | Adaptador configurado |
| `taxa` | Taxa de coleta | Adaptador configurado |
| `epop` | Cobertura EPOP | Pendente de configuração |
| `movement` | Sem movimentação | Pendente de configuração |
| `sellerPerformance` | Monitoramento de sellers prioritários J&T | Pendente de configuração |
| `bipagem` | Falha na coleta PDD | Pendente de configuração |
| `damage` | Extravio | Pendente de configuração |

O catálogo do frontend está em `src/lib/data-sources/catalog.ts`; os adaptadores disponíveis à API local estão registrados em `backend/app/services/data_sources.py`. Painéis pendentes exibem esse estado e não aceitam planilhas sem contrato.

## Fluxo

1. O painel abre o componente compartilhado `src/features/data-sources/data-source-dialog.tsx` com seu ID e configuração.
2. `src/lib/data-sources/api.ts` valida tipo/tamanho comuns e chama `/api/data-sources/{dashboard_id}/{preview|import}`.
3. O adaptador do painel faz validação de colunas e escopo da sessão; a prévia indica colunas requeridas, opcionais e não reconhecidas.
4. Após confirmação, a API substitui a fonte apenas para a combinação painel + sessão e grava os originais/datasets versionados em `DATA_DIRECTORY`. O backend restaura o ponteiro ativo após reinício; previews pendentes continuam temporários.
5. O handler existente do painel transforma o `ParsedWorkbook` no modelo já usado por filtros, KPIs, tabelas e gráficos. Fórmulas e componentes visuais permanecem no painel.

Os endpoints também incluem `GET /api/data-sources/{dashboard_id}` e `DELETE /api/data-sources/{dashboard_id}`. Exigem a sessão local já existente. IDs desconhecidos retornam `404`; IDs conhecidos sem adaptador retornam `409`.

## Contratos que já existem

- **Monitoramento**: data reconhecida, base e pelo menos uma coluna numérica de status são requeridas; regional, origem e status categórico são opcionais. O parser reutiliza `compactMonitoringWorkbook`.
- **Taxa de coleta**: usa os 22 cabeçalhos JMS declarados em `TAXA_REQUIRED_FIELDS`; normaliza a data para ISO. O arquivo deve incluir regional e base porque a API mantém o filtro de escopo da sessão.

Os adaptadores aplicam sanitização de nome, extensão/MIME aceitos, limite de 20 MB, isolamento por sessão e preservação da fonte ativa até a confirmação bem-sucedida da nova prévia/importação. Arquivos são interpretados como dados; macros não são executadas.

## Adicionar uma fonte para um novo painel

1. Escolha um ID estável que não dependa do título traduzido e registre o painel em `DashboardSourceId`, `DASHBOARD_SOURCE_IDS` e `DASHBOARD_DATA_SOURCES`.
2. Defina formatos, colunas obrigatórias e opcionais usando uma planilha de referência aprovada. Sem contrato conhecido, mantenha `configured: false`.
3. Implemente leitura e normalização sem efeitos externos. Exemplo sem dados reais:

   ```ts
   export async function parseExample(file: File): Promise<ParsedWorkbook> {
     validateWorkbookFile(file);
     return parseWorkbook(await file.arrayBuffer());
   }

   export function normalizeExample(parsed: ParsedWorkbook): ParsedWorkbook {
     return { ...parsed, rows: parsed.rows };
   }
   ```

4. Registre no catálogo visual do frontend o parser, normalizador, preview/import/remove e a descrição do contrato.
5. Registre um adaptador com validação de contrato em `backend/app/services/data_sources.py`. A API genérica resolve o ID pelo catálogo; não crie rotas específicas por painel.
6. Ligue o `ManualDataSource` ao normalizador/modelo já consumido pelo painel. Não misture fonte carregada com fixtures.
7. Adicione testes do contrato, prévia, importação/substituição, remoção, erro sem substituição, sessão e isolamento entre dashboards.

## Fonte manual e futura fonte automática

O fluxo implementado é manual (`MANUAL_UPLOAD` na resposta atual). Os tipos visuais admitem uma origem automática para preparar a extensão futura, mas não existe agendamento nem coleta automática neste estágio. Nenhuma fonte usa banco de dados; não são criadas tabelas nem executado SQL.
