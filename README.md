# Redes Painéis

Central interna para consultar painéis operacionais da J&T Express. A aplicação reúne indicadores existentes, filtros por período e escopo, processamento de planilhas e autenticação local/Feishu. A demonstração local pode preencher os painéis com fixtures fictícias sem consultar ou gravar dados em `/api/workbook`, D1 ou R2.

O histórico Git foi preservado. O código veio originalmente de [`apvalan-maker/dashboard-jt-t4t5-coletas`](https://github.com/apvalan-maker/dashboard-jt-t4t5-coletas); esse repositório é mantido como referência histórica no remote `upstream`. O projeto oficial atual é [`dataanalyticsjet/redes-paineis`](https://github.com/dataanalyticsjet/redes-paineis).

## Stack

- React 19 e TypeScript.
- vinext com roteamento no modelo Next.js App Router.
- Vite para desenvolvimento e build.
- Cloudflare Workers, com D1 (SQLite) e R2 para armazenamento de planilhas.
- Drizzle ORM / Drizzle Kit para esquema e migrations.
- pnpm para dependências, scripts, testes e build.
- Recharts para os gráficos dos painéis e `xlsx` para processamento de planilhas.

## Requisitos

- Node.js `>=22.13.0`.
- pnpm `11.16.0` (via Corepack).

## Instalação e execução local

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

O servidor local usa `http://localhost:3000` e não escolhe outra porta se ela estiver ocupada. O Vite configura emuladores locais para D1 e R2; não configure bindings remotos para executar a aplicação. Os arquivos `.env*` e `.dev.vars*` são locais e ignorados pelo Git.

Para configurar variáveis de ambiente, copie `.env.example` para `.env.local` ou use `.dev.vars` quando a variável precisar ser carregada pelo runtime Cloudflare local. Preencha os valores apenas na sua máquina. Não cole App Secret, senhas ou tokens no chat, README, código ou Git.

## Variáveis de ambiente

| Variável | Finalidade |
| --- | --- |
| `UPLOAD_USERNAME` / `UPLOAD_PASSWORD` | Credenciais separadas para autorizar upload de planilhas. |
| `VIEWER_ACCOUNTS_JSON` | Contas locais de desenvolvimento; objetos usam `username`, `password`, `role` e, conforme o escopo, `region` ou `base`. |
| `BASE_VIEWER_USERNAME` / `BASE_VIEWER_PASSWORD` / `BASE_VIEWER_BASE` | Conta local opcional limitada a uma base. |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | Credenciais do aplicativo Feishu, somente no backend. |
| `FEISHU_REDIRECT_URI` | Callback OAuth; localmente `http://localhost:3000/api/auth/feishu/callback`. Cadastre a mesma URL no aplicativo Feishu. |
| `FEISHU_SESSION_SECRET` | Segredo local do servidor, aleatório, com pelo menos 32 caracteres. Não reutilize o App Secret. |
| `FEISHU_VIEWER_ACCOUNTS_JSON` | Lista explícita de identidades Feishu autorizadas por e-mail e `tenant_key`; `role` aceita `regional` ou `matrix`. Acesso `regional` requer `region` e/ou `base`. |
| `VITE_DASHBOARD_DEMO_MODE` | `true` habilita fixtures e a área de usuários mockados apenas em desenvolvimento local. Padrão `false`; build de produção desativa o modo. |

`.env.example` contém somente nomes e valores vazios/seguros para referência. Não compartilhe arquivos reais de ambiente. O `.gitignore` exclui `.env*`, `.dev.vars*`, arquivos PEM e saídas locais do Wrangler.

### Feishu

O fluxo local implementa autorização, `state`, PKCE S256, troca de código OAuth v3, consulta de perfil e sessão HttpOnly no backend. O acesso depende de credenciais válidas no Feishu, callback cadastrado e identidade correspondente em `FEISHU_VIEWER_ACCOUNTS_JSON`. Um login real completo ainda precisa ser validado com o aplicativo e a conta autorizada. As tabelas de sessão estão descritas em `db/local-feishu-auth.sql`; o login não cria tabelas automaticamente. Não execute migrations nem altere D1 durante verificações.

## Modo demonstração

Ative `VITE_DASHBOARD_DEMO_MODE=true` no arquivo local de ambiente e reinicie `pnpm dev`. Desative com `false` ou removendo a variável e reiniciando o servidor. Os sete painéis reutilizam seus processadores e componentes existentes com dados fictícios. O modo bloqueia upload e não lê nem escreve em `/api/workbook`, D1 ou R2.

A home contém chat sem IA, grupos Feishu fictícios para simulação de compartilhamento e cadastro de dashboards mantido apenas em memória. A tela **Controle de usuários** mostra oito usuários fictícios; alterações ficam no `sessionStorage` do navegador e não concedem acesso na aplicação nem alteram permissões reais. Consulte o [inventário de funcionalidades](docs/status-funcionalidades.md) para separar recursos reais, demonstrações e itens pendentes.

## Estrutura do projeto

| Diretório/arquivo | Responsabilidade |
| --- | --- |
| `app/page.tsx` | Entrada da aplicação e montagem da central. |
| `app/dashboard-app.tsx` | Estado da navegação, autenticação visual, carregamento e apresentação dos sete painéis. |
| `app/components/` | Home/chat, login, faixa de ações, prévia Feishu simulada e controle visual de usuários. |
| `app/api/` | Rotas de autenticação, logout, upload e acesso a planilhas. |
| `app/lib/` | Processamento Excel, fórmulas, escopo, autenticação Feishu e fixtures. |
| `app/globals.css` | Estilos globais, home, cabeçalho e painéis. |
| `db/` | Binding D1, schema Drizzle e SQL da autenticação local. |
| `drizzle/` | Histórico e metadados de migrations. |
| `worker/` | Entry point Cloudflare Worker. |
| `build/` | Plugin Vite para configuração do ambiente de execução. |
| `public/` | Logos, ícones e imagens da interface. |
| `tests/` | Testes Node das fórmulas, processamento, autenticação e renderização. |
| `vite.config.ts` | vinext/Vite, Worker e bindings locais D1/R2. |

## Rotas principais

| Rota | Uso |
| --- | --- |
| `/` | Login, home e painéis. |
| `/api/auth/feishu/login` | Início local do OAuth Feishu. |
| `/api/auth/feishu/callback` | Callback OAuth Feishu. |
| `/api/feishu/login` e `/api/feishu/callback` | Aliases compatíveis para as rotas Feishu. |
| `/api/view-auth` | Verificação da sessão e login local de desenvolvimento. |
| `/api/logout` | Revogação da sessão Feishu e limpeza do cookie. |
| `/api/upload-auth` | Verificação das credenciais de upload. |
| `/api/workbook` | Leitura/gravação das planilhas via D1/R2, conforme autenticação e modo ativo. |

## Verificações

```bash
pnpm lint
pnpm test
pnpm build
```

`pnpm test` executa o build antes de rodar `node --test tests/*.test.*`. O build gera `dist/` para vinext/Cloudflare. O script de testes pode acessar os processadores; não aponte configurações locais para recursos de produção.

## Branches e remotes

- `main`: produção. Não publicar alterações diretamente nessa branch.
- `develop`: desenvolvimento e integração das mudanças atuais.
- `origin`: repositório oficial `dataanalyticsjet/redes-paineis`.
- `upstream`: repositório de origem `apvalan-maker/dashboard-jt-t4t5-coletas`, para consulta histórica.

Preserve o histórico existente. Revise mudanças, segredos e testes antes de qualquer push; publicação e deploy exigem sua etapa própria.

## Banco e armazenamento

O schema Drizzle fica em `db/schema.ts`; as migrations estão em `drizzle/`. A rota de planilhas também contém verificações de schema em tempo de execução. Não execute migrations nem acione `/api/workbook` contra bancos remotos sem revisão e autorização específicas.
