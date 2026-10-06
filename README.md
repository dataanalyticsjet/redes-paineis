# Redes Painéis

Central interna para consultar indicadores operacionais da J&T Express. Esta etapa migra o runtime para React, TypeScript, TanStack Start, Vite e Nitro/Node, com FastAPI como único backend HTTP da aplicação. Os sete painéis, seus dados, fórmulas e estilos são preservados.

O histórico veio de [`apvalan-maker/dashboard-jt-t4t5-coletas`](https://github.com/apvalan-maker/dashboard-jt-t4t5-coletas) e foi mantido no Git. O repositório oficial é [`dataanalyticsjet/redes-paineis`](https://github.com/dataanalyticsjet/redes-paineis).

## Stack

- Frontend: React 19, TypeScript, TanStack Start/Router, Vite e Nitro com preset `node-server`.
- Backend: FastAPI, Pydantic Settings, SQLAlchemy e PyMySQL preparados para uso futuro.
- Planilhas: `xlsx` e `xlsx-js-style`; o browser mantém os parsers e cálculos atuais e envia o resultado ao FastAPI.
- Sessão: OAuth Feishu no FastAPI, sessão própria em cookie HttpOnly e allowlist local.
- Gerenciador JavaScript: pnpm. Backend Python: ambiente virtual e `requirements.txt`.

O backend não abre conexão SQL no startup e não cria tabelas. A persistência atual de workbooks/fontes é local em `DATA_DIRECTORY`; não usa D1/R2. A sessão Feishu e os estados OAuth são mantidos em memória do processo e precisam de armazenamento compartilhado antes de produção.

Os arquivos-fonte rastreados do runtime antigo (`app/`, `worker/`, `db/`, `drizzle/`, `build/` e exemplos D1) estão removidos da árvore de trabalho e aparecem como exclusões pendentes no Git. Os diretórios locais correspondentes ainda aparecem como reparse points do Windows, sem destino informado pelo sistema; foram deixados intactos e não serão percorridos nem removidos recursivamente. Eles não são usados pelo build novo. Nenhuma conexão ou gravação em Cloudflare foi feita.

## Estrutura

```text
src/
  routes/                  # rotas TanStack Start
  components/              # componentes compartilhados
  features/                # auth, home, dashboards, fontes e usuários
  lib/                     # parsers, fórmulas, escopos e cliente de dados
  styles/                  # CSS global existente
public/                    # logo, ícones e imagens
backend/
  app/api/                 # health, auth, fontes e workbooks
  app/core/                # configurações Pydantic
  app/db/                  # engine/session SQLAlchemy futuro, sem conexão automática
  app/services/            # OAuth Feishu e persistência local de arquivos
  tests/                   # testes FastAPI
  sql/                     # reservado; nenhuma migration foi executada
ops/nginx/                 # exemplo de proxy same-origin
ops/systemd/               # exemplos de serviços Node e FastAPI
docs/                      # inventário e documentação operacional
tests/                     # fórmulas, parsers, catálogo e SSR
```

O TanStack tem hoje a rota `/`. Home, seleção de painéis e controle visual continuam na navegação React existente para preservar o comportamento; rotas profundas por dashboard e administração ainda não foram divididas. O componente principal dos painéis permanece grande, então a decomposição visual e de negócio deve ser feita em etapas menores.

## Requisitos

- Node.js `>=22.13.0`.
- pnpm `11.16.0`.
- Python 3.12 recomendado para o backend.

## Configuração local

Copie os exemplos para arquivos locais ignorados pelo Git:

```powershell
Copy-Item .env.example .env.local
Copy-Item backend/.env.example backend/.env
```

Preencha `backend/.env` localmente. Nunca coloque App Secret, senha, token ou credenciais em frontend, logs, README ou Git. `.env`, `.dev.vars` e `backend/.env` são ignorados.

### Frontend (`.env.local`)

| Variável | Uso |
| --- | --- |
| `FRONTEND_PORT` | Porta do Vite; padrão local `3001`. |
| `FASTAPI_DEV_TARGET` | Destino do proxy local; padrão `http://127.0.0.1:8001`. |
| `NITRO_PRESET` | Preset do servidor de produção; `node-server`. |
| `VITE_DASHBOARD_DEMO_MODE` | `true` usa fixtures locais e bloqueia o caminho de upload; padrão `false`. |

### FastAPI (`backend/.env`)

| Variáveis | Uso |
| --- | --- |
| `APP_ENV` | `development` habilita CORS apenas para `FRONTEND_BASE_URL`. |
| `FRONTEND_BASE_URL` | Origem local, por padrão `http://localhost:3001`. |
| `DATA_DIRECTORY` | Pasta persistente de workbooks/fontes. Em produção é obrigatória, absoluta e fora do checkout; localmente mantém o fallback do sistema operacional. |
| `UPLOAD_USERNAME`, `UPLOAD_PASSWORD` | Credenciais server-side do fluxo clássico de upload. |
| `FEISHU_OAUTH_ENABLED` | Habilita o login Feishu. |
| `FEISHU_OAUTH_APP_ID`, `FEISHU_OAUTH_APP_SECRET` | Credenciais do aplicativo; exclusivamente no servidor. |
| `FEISHU_OAUTH_AUTHORIZE_URL`, `FEISHU_OAUTH_TOKEN_URL`, `FEISHU_OAUTH_USERINFO_URL` | Endpoints Feishu mantidos na configuração server-side; o fluxo atual usa token v2. |
| `FEISHU_OAUTH_REDIRECT_URI` | Callback cadastrado no Feishu. Local: `http://localhost:3001/api/auth/feishu/callback`. |
| `FEISHU_SESSION_SECRET` | Chave aleatória local da sessão, independente do App Secret. |
| `FEISHU_VIEWER_ACCOUNTS_JSON` | Allowlist explícita com e-mail, tenant e escopo autorizado. |
| `ALLOWED_CORPORATE_DOMAINS` | Domínios aceitos para identidade Feishu. |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Reservadas para uso futuro de MySQL; não são usadas nem conectadas nesta etapa. |

Os endpoints Feishu e a versão do fluxo estão centralizados nas configurações do backend. O login real exige credenciais válidas, callback cadastrado e conta correspondente à allowlist; sem isso, a aplicação mostra falha e não cria sessão. `FEISHU_OAUTH_REDIRECT_URI` de produção deve ser `https://DOMINIO_PRODUCAO/api/auth/feishu/callback` e precisa ser cadastrado manualmente no aplicativo Feishu.

## Executar localmente

Inicie o FastAPI em um terminal:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8001
```

Confirme o health check em `http://127.0.0.1:8001/api/health`.

Em outro terminal, na raiz do repositório:

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Abra `http://localhost:3001`. O Vite encaminha `/api/auth/*`, `/api/data-sources/*`, `/api/workbook`, `/api/upload-auth` e `/api/health` para o FastAPI local. Se a porta estiver ocupada, o servidor encerra com erro em vez de escolher outra porta silenciosamente; ajuste `FRONTEND_PORT` e o callback local em conjunto.

## Build, testes e lint

```bash
pnpm lint
pnpm test
pnpm build
```

`pnpm test` gera o build Nitro e executa os testes Node. Para o backend, a partir de `backend/`:

```powershell
.venv\Scripts\python.exe -m pytest tests
```

O build de produção gera `.output/server/index.mjs`; execute-o com `pnpm start` e configure `HOST`/`PORT` no processo. Para reproduzir o build de servidor: `NITRO_PRESET=node-server pnpm build`.

## Preparação Ubuntu (sem deploy)

Os modelos em `ops/systemd/` e `ops/nginx/redes-paineis.conf.example` não estão instalados nem habilitados. Antes de usá-los, escolher e validar no servidor `DOMINIO_PRODUCAO`, `FRONTEND_PORT` e `BACKEND_PORT`; os dois serviços escutam somente em `127.0.0.1`, enquanto o Nginx recebe HTTPS, encaminha `/` ao Nitro/Node e `/api/` ao FastAPI. Nenhuma porta interna deve ser aberta no firewall público. O arquivo Nginx é um template: substitua os três placeholders e valide a configuração antes de habilitá-la.

O `backend/.env.example` documenta as variáveis sem valores reais. O arquivo de ambiente usado pelo systemd deve ficar fora do Git, por exemplo `/etc/redes-paineis/backend.env`, com `APP_ENV=production`, `DATA_DIRECTORY` absoluto e externo ao checkout, `FRONTEND_BASE_URL=https://DOMINIO_PRODUCAO` e `FEISHU_OAUTH_REDIRECT_URI=https://DOMINIO_PRODUCAO/api/auth/feishu/callback`. Preencha App ID, App Secret, chave de sessão e allowlist localmente no servidor; nunca copie credenciais para o repositório.

O FastAPI falha na configuração se `DATA_DIRECTORY` não estiver definido, não for absoluto ou apontar para dentro do projeto em produção. Crie a pasta persistente com proprietário/permissões restritos ao usuário do serviço. O Nginx serve os arquivos públicos do frontend, não o diretório de dados. Workbooks/fontes permanecem no disco após reiniciar a API, desde que o mesmo `DATA_DIRECTORY` seja mantido. O serviço FastAPI está configurado com **um worker**: sessões Feishu e state OAuth são em memória; reiniciar a API encerra sessões e exige novo login. Persistência/compartilhamento de sessão continua pendência futura.

`/api/upload-auth` continua necessário no fluxo clássico: `src/features/dashboards/dashboard-app.tsx` o chama para validar credenciais server-side antes do upload autenticado em `/api/workbook`. As credenciais `UPLOAD_USERNAME` e `UPLOAD_PASSWORD` devem ser configuradas somente no ambiente do backend. A remoção dessa autenticação legada fica para uma etapa futura com teste do fluxo alternativo.

Para a primeira validação pós-instalação, rode `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm lint`, `node node_modules/typescript/bin/tsc --noEmit`, e em `backend/` `python -m pytest tests`. O teste de persistência `test_uploaded_xlsx_and_source_survive_preview_service_reset` cobre a recuperação do workbook salvo depois de limpar estado temporário do serviço.

## Dados e demonstração

Quando `VITE_DASHBOARD_DEMO_MODE=true`, os sete painéis reutilizam os fixtures e processadores atuais. A indicação de demonstração é visual. A importação normal lê arquivos no browser, mostra preview e envia dataset/arquivo ao FastAPI; arquivos e versões ficam em `DATA_DIRECTORY`. Remover a fonte troca o ponteiro ativo conforme o comportamento existente.

O chat ainda apresenta “Assistente em preparação”; não chama IA. Envio Feishu a grupos, Controle de usuários e grants administrativos são demonstrações frontend sem persistência no servidor. Consulte [`docs/status-funcionalidades.md`](docs/status-funcionalidades.md) para a classificação atual.

## Branches e alterações locais

- `main`: produção.
- `develop`: integração.
- `feat/feishu-fastapi`: branch atual desta linha de migração.

Não faça push ou deploy como parte da migração local. Revise o diff, os segredos locais, os testes e os requisitos de produção separadamente antes de publicar.
