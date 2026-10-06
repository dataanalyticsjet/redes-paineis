# Mapa de prontidão para produção

Este documento descreve o estado após o corte estrutural local. Não foi feito deploy, não foi acessado banco e nenhuma migration foi executada.

## Caminho ativo

| Área | Implementação atual | Estado/limite |
| --- | --- | --- |
| Frontend `/` | TanStack Start + Vite + Nitro/Node | Build server-side gera `.output/server/index.mjs`; navegação dos dashboards ainda usa o estado React da home. |
| `GET /api/health` | FastAPI | Não consulta banco. |
| `/api/auth/*` | FastAPI | OAuth Feishu v2, state de uso único, allowlist/domínio e cookie HttpOnly. Sessão/state em memória. Login foi validado localmente em execução anterior, não repetido neste corte. |
| `/api/workbook` | FastAPI | Processamento do Excel permanece no frontend; JSON e Excel original são versionados em disco local. Escopo é aplicado antes de devolver dados. |
| `/api/data-sources/*` | FastAPI | Preview/import/remove no backend local e armazenamento em `DATA_DIRECTORY`. |
| `/api/upload-auth` | FastAPI | Chamado pelo upload clássico no frontend para validar as credenciais server-side antes de gravar via `/api/workbook`; mantido nesta versão. |
| Produção | Nginx → Node (`/`) e FastAPI (`/api/`) | Apenas configuração-exemplo; domínio, TLS, portas, persistência e hardening não foram aprovados nem instalados. |

## Pendências de produção

1. Aprovar domínio HTTPS e callback Feishu de produção; cadastrar o callback no aplicativo.
2. Definir store compartilhada e durável para OAuth state e sessões revogáveis; hoje ambas ficam em memória e reinício encerra sessões.
3. Escolher e provisionar um `DATA_DIRECTORY` absoluto fora do checkout, com permissões, backup e retenção. A configuração de produção recusa inicialização sem essa pasta explícita; workbooks/fontes sobrevivem ao restart da API enquanto o diretório persistente for mantido.
4. Decidir se e quando usar MySQL. SQLAlchemy/PyMySQL estão preparados, mas o startup não conecta e nenhuma tabela/schema existe neste fluxo.
5. Definir autenticação de upload compatível com operação e segurança corporativa; atualmente são credenciais de servidor separadas.
6. Revisar Nginx/systemd, limites de upload, proxy headers, TLS, CORS, logs, permissões de diretório, monitoramento e recuperação. FastAPI deve ficar em um worker nesta primeira versão.
7. Fazer verificação visual e funcional em navegador no ambiente alvo após o runtime local ser iniciado sem conflito de porta.
8. Separar gradualmente o componente atual de painéis, que ainda é extenso; não alterar cálculos/filtros durante essa decomposição.

## Regras de segurança preservadas

- Segredos Feishu ficam somente no ambiente do backend.
- O frontend usa sessão de cookie; não recebe App Secret nem tokens Feishu.
- Allowlist, domínio corporativo e escopo regional/base continuam controlados no backend.
- Controle de usuários, grupos Feishu simulados e chat não concedem permissões nem enviam dados.
- D1/R2/Worker não fazem parte do caminho ativo da nova arquitetura. Não foram acessados ou migrados.

## Operação local

Consulte o README para instalar e iniciar os dois processos. `ops/nginx/redes-paineis.conf.example` e `ops/systemd/` são modelos, não configuração pronta para copiar ao servidor sem preencher e revisar `DOMINIO_PRODUCAO`, `FRONTEND_PORT`, `BACKEND_PORT`, caminhos, permissões e ambiente. A sessão Feishu permanece em memória; restart da API exige nova autenticação. Os dados do Excel têm persistência independente em `DATA_DIRECTORY`.
