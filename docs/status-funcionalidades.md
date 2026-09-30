# Inventário de funcionalidades — Redes Painéis

Este inventário descreve o código atual. “Funcional real” significa que existe uma implementação que executa a tarefa dentro das condições/configurações descritas; não significa que serviços externos ou produção foram validados neste preparo do repositório.

## FUNCIONAL REAL

- **Sete painéis operacionais:** Monitoramento de coleta, Taxa de coleta, Cobertura EPOP, Monitoramento de sellers prioritários J&T, Sem movimentação, Falha na coleta PDD e Extravio. Cada painel tem filtros, tabelas/gráficos e processadores existentes em `app/dashboard-app.tsx` e `app/lib/`.
- **Processamento de planilhas:** leitura e normalização de arquivos Excel com `xlsx`, com cálculos e escopos implementados nos módulos de `app/lib/`.
- **Upload e persistência de planilhas:** `/api/workbook` recebe/consulta dados; D1 mantém estado e R2 armazena objetos. Upload exige autenticação separada. As rotas dependem das variáveis e bindings corretos; no modo demonstração o caminho de upload é bloqueado.
- **Autenticação local de desenvolvimento:** `/api/view-auth` valida as contas locais configuradas por ambiente; `/api/upload-auth` valida separadamente a conta de upload.
- **Implementação OAuth Feishu no servidor:** início, callback, `state`, PKCE S256, troca de código OAuth v3, consulta de perfil, autorização por lista local, sessão HttpOnly e logout/revogação estão no código. **A autenticação real com o aplicativo Feishu ainda não foi confirmada de ponta a ponta**, portanto não deve ser tratada como validada para produção.
- **Geração de impressão pelo navegador:** “Gerar PDF” chama a impressão do navegador (`window.print`); o navegador pode salvar em PDF. Não existe serviço próprio que gere e armazene o PDF.
- **Resumo local de painel:** “Análise IA” compõe texto a partir de dados/filtros existentes e oferece cópia. É um resumo local, sem modelo de IA.

## MOCK / DEMONSTRAÇÃO

- **Dados simulados dos sete painéis:** `app/lib/demo-fixtures.ts` fornece registros fictícios compatíveis com os processadores atuais. O modo é controlado por `VITE_DASHBOARD_DEMO_MODE` e existe somente em desenvolvimento local.
- **Indicadores e avisos de demonstração:** rótulos “Demonstração” identificam dados fictícios e ações simuladas na interface.
- **Controle de usuários:** `app/components/demo-user-control.tsx` apresenta oito perfis fictícios com e-mails `example.test`. Ativar/desativar e marcar acessos aos painéis altera apenas estado no `sessionStorage` do navegador; não há API, tabela, persistência no servidor ou efeito sobre permissões reais.
- **Dashboards personalizados adicionados na home:** cadastro do título/link fica somente no estado React da sessão e abre links HTTP/HTTPS. Não altera a configuração ou permissões dos sete painéis da plataforma.
- **Chat:** `app/components/assistant-home.tsx` mostra a pergunta enviada e a resposta fixa “Assistente em preparação”. Não consulta dados nem envia a pergunta a um modelo.
- **Envio Feishu simulado:** `app/components/feishu-share-dialog.tsx` lista grupos claramente fictícios e só confirma uma simulação local. Não consulta grupos, não chama APIs Feishu e não envia mensagens.
- **Prévia do compartilhamento do chat:** usa somente a resposta selecionada; no estado atual a resposta fixa de preparação é considerada inválida para compartilhar.

## AINDA NÃO IMPLEMENTADO / PENDENTE

- Integração de IA real, respostas baseadas nos painéis e histórico de conversa persistente.
- Consulta de grupos Feishu, envio real de mensagens/anexos e tratamento de confirmações reais.
- Administração persistida de usuários, atribuição real de painéis e aplicação dessas permissões nas APIs.
- Geração própria de PDF, com arquivo/anexo disponível para compartilhamento sem depender da impressão do navegador.
- Validação real completa do OAuth Feishu com as credenciais, callback e conta autorizada do aplicativo atual.
- Revisão de produção dos bindings, permissões e configuração de hospedagem do novo repositório. Nenhum deploy foi feito nesta etapa.

## Arquivos de referência

| Área | Arquivos |
| --- | --- |
| Entrada, navegação e painéis | `app/page.tsx`, `app/dashboard-app.tsx` |
| Home e chat | `app/components/assistant-home.tsx` |
| Controle mockado de usuários | `app/components/demo-user-control.tsx` |
| Dados fictícios | `app/lib/demo-fixtures.ts` |
| OAuth / sessão Feishu | `app/api/auth/feishu/`, `app/lib/feishu-auth.server.ts`, `db/local-feishu-auth.sql` |
| APIs de dados/upload | `app/api/workbook/route.ts`, `app/api/upload-auth/route.ts`, `app/lib/workbook.ts` |
| Prévia de envio simulada | `app/components/feishu-share-dialog.tsx` |
| Impressão e resumo de painel | `app/components/dashboard-action-band.tsx`, `app/dashboard-app.tsx` |
