# Inventário de funcionalidades — Redes Painéis

“Funcional real” descreve código que executa localmente sob as configurações atuais; não significa que foi certificado para produção.

## FUNCIONAL REAL

- **Sete painéis First Mile:** Monitoramento de coleta, Taxa de coleta, Cobertura EPOP, Monitoramento de sellers prioritários J&T, Sem movimentação, Falha na coleta PDD e Extravio. A interface e as regras permanecem no recurso `src/features/dashboards/` e os cálculos reutilizáveis em `src/lib/`.
- **Planilhas e filtros:** parsers `xlsx`, normalização e fórmulas locais existentes; os painéis continuam dirigidos pelos mesmos datasets e estados de filtro.
- **Upload e persistência local:** FastAPI `/api/workbook` e `/api/data-sources/*` validam e persistem versões/arquivos em `DATA_DIRECTORY`, fora do checkout por padrão. O acesso é limitado pela sessão/escopo atual e o upload usa credenciais server-side.
- **Login Feishu:** a versão local FastAPI faz OAuth v2, valida `state`, consulta o perfil, aplica domínio e allowlist e cria uma sessão HttpOnly. O login real foi confirmado em uma execução local anterior; esta migração não repetiu o OAuth. Persistência de sessão compartilhada para produção ainda falta.
- **Geração de PDF:** usa a impressão do navegador (`window.print`); não há serviço que gere/guarde PDF próprio.
- **Resumo de análise local:** compõe texto usando o painel/filtros disponíveis; não chama um modelo de IA.

## MOCK / DEMONSTRAÇÃO

- **Fixtures dos sete painéis:** `src/lib/demo-fixtures.ts`, habilitadas localmente por `VITE_DASHBOARD_DEMO_MODE=true`.
- **Controle de usuários:** `src/features/users/demo-user-control.tsx` mostra oito usuários fictícios. Ativação e acessos ficam no navegador e não alteram permissões reais.
- **Dashboards adicionados pela home:** título/link temporário mantido apenas na sessão React.
- **Chat:** `src/features/home/assistant-home.tsx` exibe pergunta e aviso fixo “Assistente em preparação”; não consulta dados ou serviço de IA.
- **Compartilhamento Feishu:** `src/components/feishu-share-dialog.tsx` usa grupos fictícios e simula a confirmação; não consulta nem envia mensagens ao Feishu.

## AINDA NÃO IMPLEMENTADO / PENDENTE

- IA real, respostas baseadas nos indicadores e histórico persistente.
- Consulta de grupos Feishu e envio real de mensagens/anexos.
- Gestão persistente de usuários, papéis/grants de dashboards e aplicação desses grants nas APIs.
- Geração de PDF no servidor.
- Store compartilhado e durável para estados OAuth/sessões; o estado local atual fica em memória do processo.
- Produção: domínio/callback HTTPS aprovados, TLS, persistência durável compartilhada, hardening de proxy e validação operacional. Nenhum deploy foi feito.

## Arquivos de referência

| Área | Arquivos |
| --- | --- |
| Entrada/rota atual | `src/routes/__root.tsx`, `src/routes/index.tsx`, `src/router.tsx` |
| Home, autenticação visual e navegação | `src/features/dashboards/dashboard-app.tsx`, `src/features/auth/presentation-login.tsx`, `src/features/home/assistant-home.tsx` |
| Dashboards e estilos | `src/features/dashboards/`, `src/styles/globals.css` |
| Fórmulas e parsers | `src/lib/` |
| Fontes de dados | `src/features/data-sources/data-source-dialog.tsx`, `backend/app/api/data_sources.py`, `backend/app/services/data_sources.py` |
| OAuth/sessão | `backend/app/api/auth.py`, `backend/app/services/feishu_auth.py` |
| Workbooks/upload | `backend/app/api/workbooks.py`, `backend/app/services/local_workbooks.py` |
| FastAPI | `backend/app/main.py` |
