# Auditoria da arquitetura anterior

## Resultado da migração local

O runtime ativo é React + TypeScript + TanStack Start + Vite + Nitro/Node no frontend e FastAPI como único backend HTTP. O Vite encaminha `/api/*` ao FastAPI durante o desenvolvimento. Workbooks e fontes persistem em arquivos no `DATA_DIRECTORY`; não há acesso a D1 ou R2. Nenhum banco, SQL ou migration foi executado nesta etapa.

Os arquivos-fonte rastreados da arquitetura anterior estão excluídos da árvore de trabalho e aparecem como remoções pendentes no Git. `src/` e `backend/` não importam esses arquivos. As pastas locais `app/`, `worker/`, `db/`, `drizzle/`, `build/`, `.openai/` e `examples/` ainda são exibidas pelo Windows como reparse points, mas `Get-Item` não informa `LinkType` nem `Target`. Elas não foram percorridas recursivamente, alteradas nem removidas. Git identifica somente os arquivos-fonte listados como removidos; caches ignorados `.next/`, `.vinext/`, `.wrangler/` e `dist/` também foram deixados intactos.

| Caminho legado | Função anterior | Importado pelo runtime atual | Estado no Git / ação local |
| --- | --- | --- | --- |
| `app/` e `app/api/` | UI antiga e rotas de backend no framework anterior | Não | Fontes versionadas removidas da árvore de trabalho; reparse points locais preservados |
| `worker/` | Worker Cloudflare | Não | `worker/index.ts` removido da árvore de trabalho; pasta reparse preservada |
| `db/` | Schema e helpers D1/Drizzle antigos | Não | Fontes versionadas removidas; pasta reparse preservada; nenhum SQL executado |
| `drizzle/`, `drizzle.config.ts` | Schema e migrations Drizzle | Não | Arquivos removidos da árvore de trabalho; nenhum migration executado |
| `build/sites-vite-plugin.ts` | Integração de build antiga | Não | Arquivo removido da árvore de trabalho |
| `examples/d1/` | Exemplo de API/schema D1 | Não | Fontes removidas da árvore de trabalho |
| `.openai/hosting.json` | Configuração de hosting antiga | Não | Arquivo removido da árvore de trabalho; pasta reparse preservada |
| `next.config.ts`, `next-env.d.ts` | Configuração Next.js antiga | Não | Arquivos removidos da árvore de trabalho |
| `.next/`, `.vinext/`, `.wrangler/`, `dist/` | Artefatos/cache local | Não | Ignorados pelo Git e deixados intactos |
| `vite.config.ts` | Configuração do runtime atual | Sim | Mantida; TanStack Start, Nitro e proxy de desenvolvimento para FastAPI |

## Backend e endpoints atuais

- FastAPI em `backend/app/main.py` inclui `/api/health`, `/api/auth/*`, `/api/data-sources/*` e `/api/workbook`.
- O login Feishu e a sessão própria permanecem no FastAPI. O frontend consome a sessão e faz logout pela rota atual de autenticação.
- `/api/upload-auth` continua como proteção server-side do upload e é usada pelo frontend; não é uma autenticação paralela.
- `/api/view-auth` e `/api/logout` do Worker antigo foram removidas junto com suas rotas legadas.
- O endpoint de workbook valida sessão, escopo e credenciais locais de upload conforme o fluxo atual.

## Dependências antigas e atuais

Não há dependência de runtime para Cloudflare Worker, D1, R2, Drizzle ou Vinext em `package.json`, `pnpm-lock.yaml`, `src/`, `backend/` ou `vite.config.ts`. A busca ativa nesses caminhos não encontrou referências a esses nomes.

`@vitejs/plugin-rsc` e `react-server-dom-webpack` permanecem como dependências opcionais do ecossistema TanStack Start/React Server Components e não são componentes Cloudflare/Vinext. A configuração atual não adiciona um plugin RSC; o build Node atual passa. Mantê-las evita forçar alteração de peer integration do TanStack durante esta limpeza.

## Observações operacionais

- Sessões Feishu e estados OAuth permanecem em memória do FastAPI; reiniciar o processo encerra sessões. Um armazenamento compartilhado e revogável continua sendo requisito para produção.
- O servidor Node do Nitro não implementa APIs de negócio. Em produção, Nginx deve encaminhar `/api/` ao FastAPI e o restante ao Node.
- Não houve commit, push ou deploy. As remoções estão pendentes na árvore de trabalho para revisão.
