# Mapa de prontidão para produção

Este documento descreve o estado após o corte estrutural local. Não foi feito deploy, não foi acessado banco e nenhuma migration foi executada.

## Caminho ativo

| Área | Implementação atual | Estado/limite |
| --- | --- | --- |
| Frontend `/` | TanStack Start + Vite + Nitro/Node | Build server-side gera `.output/server/index.mjs`; navegação dos dashboards ainda usa o estado React da home. |
| `GET /api/health` | FastAPI | Não consulta banco. |
| /api/auth/* | FastAPI + MySQL DB_* | OAuth Feishu v2, state de uso único, tenant/domínio corporativos autorizados e cookie HttpOnly; novos usuários são USER sem escopo até atribuição administrativa. Usuários e permissões são lidos no schema de autenticação; perfil Feishu organizacional fica em platform_user_feishu_profiles. Sessão/state em memória. |
| /api/v2/* | FastAPI + MySQL DATA_DB_* | Consultas, contratos e publicações da Data Foundation no schema separado redes_paineis_dados; as flags controlam importação e consulta. |
| `/api/workbook` | FastAPI | Processamento do Excel permanece no frontend; JSON e Excel original são versionados em disco local. Escopo é aplicado antes de devolver dados. |
| `/api/data-sources/*` | FastAPI | Preview/import/remove no backend local e armazenamento em `DATA_DIRECTORY`. |
| `/api/upload-auth` | FastAPI | Chamado pelo upload clássico no frontend para validar as credenciais server-side antes de gravar via `/api/workbook`; mantido nesta versão. |
| Produção | Nginx → Node (`/`) e FastAPI (`/api/`) | Apenas configuração-exemplo; domínio, TLS, portas, persistência e hardening não foram aprovados nem instalados. |

## Pendências de produção

1. Aprovar domínio HTTPS e callback Feishu de produção; cadastrar o callback no aplicativo.
2. Definir store compartilhada e durável para OAuth state e sessões revogáveis; hoje ambas ficam em memória e reinício encerra sessões.
3. Escolher e provisionar um `DATA_DIRECTORY` absoluto fora do checkout, com permissões, backup e retenção. A configuração de produção recusa inicialização sem essa pasta explícita; workbooks/fontes sobrevivem ao restart da API enquanto o diretório persistente for mantido.
4. Validar, sem acessar produção nesta auditoria, os destinos e privilégios dos dois bancos: DB_* para autenticação e DATA_DB_* para V2. Os schemas e tabelas são provisionados manualmente; o aplicativo não cria nem migra tabelas. Confirmar que platform_user_feishu_profiles corresponde ao ORM antes do deploy.
5. Definir autenticação de upload compatível com operação e segurança corporativa; atualmente são credenciais de servidor separadas.
6. Revisar Nginx/systemd, limites de upload, proxy headers, TLS, CORS, logs, permissões de diretório, monitoramento e recuperação. FastAPI deve ficar em um worker nesta primeira versão.
7. Fazer verificação visual e funcional em navegador no ambiente alvo após o runtime local ser iniciado sem conflito de porta.
8. Separar gradualmente o componente atual de painéis, que ainda é extenso; não alterar cálculos/filtros durante essa decomposição.

## Sessões em memória e operação temporária

O backend mantém em memória, por processo, sessões e tentativas OAuth. Os tokens de sessão e valores state são indexados por HMAC, o state é comparado ao cookie do navegador, consumido uma única vez e expira; sessões expiram pelo TTL e o logout revoga a entrada local. Reinício invalida todas as sessões e tentativas pendentes.

Um único worker/processo pode ser usado temporariamente em desenvolvimento e homologação controlada. Em produção isso implica novo login após cada reinício, indisponibilidade de sessão durante reinícios e risco de falha OAuth quando requisições do mesmo fluxo forem atendidas por processos diferentes. Não escalar horizontalmente nem executar múltiplos workers com o armazenamento atual.

Antes de produção, aprovar um armazenamento compartilhado e durável. A proposta é persistir somente hashes HMAC de tokens e states, associar sessão a usuário e horários de emissão/expiração/revogação, consumir state atomicamente uma única vez e invalidar sessão no logout, expiração ou bloqueio do usuário. Pode ser uma tabela transacional no MySQL de autenticação, após revisão e provisionamento manual do schema, ou um serviço Redis já aprovado com TTL e revogação; esta auditoria não cria tabela nem instala infraestrutura. Manter cookie HttpOnly/Secure em HTTPS, SameSite=Lax, state aleatório e vinculado ao cookie, expiração curta do state e verificação do usuário/permissões no backend em cada requisição.

## Regras de segurança preservadas

- Segredos Feishu ficam somente no ambiente do backend.
- O frontend usa sessão de cookie; não recebe App Secret nem tokens Feishu.
- Allowlist, domínio corporativo e escopo regional/base continuam controlados no backend.
- Controle de usuários, grupos Feishu simulados e chat não concedem permissões nem enviam dados.
- D1/R2/Worker não fazem parte do caminho ativo da nova arquitetura. Não foram acessados ou migrados.

## Revisão de autorização administrativa — outubro de 2026

As permissões são recarregadas de `platform_users` e das atribuições vigentes em
cada requisição autenticada. Informações de papel/regional enviadas pelo navegador
ou mantidas em uma sessão antiga não concedem acesso. ADMIN matriz requer papel
ADMIN e escopo efetivo `matrix`; o perfil organizacional Feishu nunca concede matriz.

Administração de usuários é nacional apenas para ADMIN matriz. Autoalterações de
papel, atribuições ou status são recusadas inclusive para matriz. Um segundo ADMIN
matriz deve realizar mudanças nesse usuário; o bootstrap inicial continua manual.
As alterações permitidas e suas diferenças são persistidas em `user_access_audit`
na mesma transação das atribuições, com bloqueio das linhas administrativas.

`REGIONAL_USER_ADMINISTRATION_ENABLED` é uma opção nova, desativada por padrão.
Sem habilitação explícita, ADMIN regional não acessa o catálogo administrativo de
usuários. Quando habilitada, a delegação permite somente alterar o status de USER
com escopo regional integralmente contido nas regiões autorizadas do administrador.
O catálogo, a paginação, o catálogo regional e o histórico também são restringidos.
Não permite alterar ADMIN, usuários matriz, bases sem regional comprovada, usuários
sem regional, papéis ou atribuições regionais. O catálogo delegado calcula o escopo
efetivo antes de paginar; avaliar o custo dessa opção com um catálogo grande.

Publicação/importação, previews e decisões de mapeamento globais exigem ADMIN
matriz, incluindo os caminhos legados de workbook e fontes compartilhadas. A leitura
operacional continua independente do papel administrativo e limitada no backend.
Os fluxos V2 já mantêm a rastreabilidade dos jobs/publicações e de seu responsável;
alterações de acesso usam a auditoria transacional de usuários.
Os caminhos legados de publicação/remoção registram ator, ação e fonte nos logs;
retenção e acesso restrito a esses logs precisam ser confirmados na homologação.

As tabelas exigidas são `user_region_access`, `user_access_audit` e
`platform_user_feishu_profiles`, além de `platform_users` e `regions`. Conferir
manualmente `backend/sql/user-access-security-verification-review.sql`. O arquivo
`user-access-security-missing-tables-review.sql` é uma proposta separada para
tabelas comprovadamente ausentes. Nenhum desses arquivos roda na aplicação.
Não é necessário modificar schema para as novas regras se as tabelas já existem.

Com sessões/state em memória, a configuração temporária é exatamente **um processo
FastAPI, um worker e uma única instância**, sem reload nem processos sobrepostos
durante atualização. Exemplo conceitual: `uvicorn app.main:app --workers 1` com os
demais argumentos locais previamente aprovados. Reinício perde sessões e tentativas
OAuth em curso e exige novo login. Afinidade de carga não resolve compartilhamento
nem revogação entre instâncias. Não houve mudança de systemd, Nginx ou infraestrutura.

O cache de dashboards fica na memória do frontend, separado por identidade e escopo,
fonte, contrato e período, com manifesto de publicação e mapa. Logout e mudança de
identidade/escopo limpam cache e estados carregados. A identidade é revalidada pelo
frontend a cada 60 segundos e ao recuperar foco; o backend aplica uma revogação já
na próxima requisição, mesmo com o cookie antigo. Dados já entregues ao navegador
não podem ser apagados remotamente antes dessa revalidação. O cache não sobrevive
a refresh, fechamento de aba ou nova sessão e não é um mecanismo de autorização.

Evolução proposta separadamente: cache no backend após autorização, com chave por
usuário ou impressão do escopo efetivo, contrato, publicação diária vigente, versão
do mapa, período e filtros. Revalidar o usuário antes de devolver qualquer resultado,
invalidar em publicação e mudança de acesso e limitar TTL/tamanho. Não persistir
dados operacionais em localStorage nem usar cache público compartilhado. Um store
compartilhado para sessões/state precisaria de hashes de tokens, expiração, revogação
e consumo atômico de state. Redis ou tabelas MySQL exigem aprovação própria; esta
correção não instala infraestrutura nem implementa esse cache futuro.

## Operação local

Consulte o README para instalar e iniciar os dois processos. `ops/nginx/redes-paineis.conf.example` e `ops/systemd/` são modelos, não configuração pronta para copiar ao servidor sem preencher e revisar `DOMINIO_PRODUCAO`, `FRONTEND_PORT`, `BACKEND_PORT`, caminhos, permissões e ambiente. A sessão Feishu permanece em memória; restart da API exige nova autenticação. Os dados do Excel têm persistência independente em `DATA_DIRECTORY`.
