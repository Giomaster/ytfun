# TikTok REST com sessão privada

Esta rota experimental foi solicitada para a conta AI Meow. Não é a API oficial
OAuth/Direct Post, nem comprova sua auditoria ou suporte contratual. Os caminhos
foram observados no cliente público TikTok Studio e na captura autorizada em
02/10/2026; a aceitação real do servidor continua necessária. Nenhum código de
uploader de terceiros é executado e nenhum desafio de autenticação é contornado.

Configure `TIKTOK_ACCOUNT_ID` numérico, `TIKTOK_ACCOUNT_HANDLE` sem `@`,
`TIKTOK_SESSION_FILE` absoluto e `YTFUN_TIKTOK_SESSION_PUBLISH_ENABLED=true`.
O arquivo de sessão deve ficar fora de Git, regular, proprietário atual, um link,
modo 0600 e diretório privado. Seu conteúdo tem `expectedAccount` com `accountId`
e `handle` (com `@`), além de `cookies` com nome, valor, domínio, caminho e prazo.
`requestHeaders` aceita somente User-Agent e Accept-Language observados.
Cookies e CSRF nunca entram no store, no MCP ou nos recibos públicos.

A sessão verifica a conta pela rota `/api/v1/user/profile/upload/`, obtém novas
credenciais temporárias por `/api/v1/video/upload/auth/` e atualiza o CSRF pela
rota `/tiktokstudio/api/web/user`. Credenciais de upload não são cookies de login.
Rotação `Set-Cookie` legítima é persistida privadamente. A expiração exibida pelo
Chrome não garante validade no servidor. Sessão revogada, CAPTCHA/2FA, mudança
de conta ou resposta não reconhecida interrompe o fluxo. O usuário pode então
recapturar os cookies privadamente; não existe promessa de autenticação eterna.

`ytfun_tiktok_publish` exige hash da revisão, `privacy=public` e `execute=true`.
O publisher verifica os bytes e reserva o episódio/conta antes das mutações.
O perfil inicial admite clips MP4 até 180 segundos e 8 MiB, dimensões explícitas
e áudio original. A duração também precisa caber no limite real da conta.
A assinatura V4 do upload usa exclusivamente as credenciais fornecidas à sessão,
no gateway observado e região retornada na captura. Cookies não vão para o CDN.
A postagem solicita `visibility_type=0` e `aigc_label_type=1`.

Cada etapa guarda criação, vídeo, fase e estado, sem credenciais. Nenhuma mutação
é repetida automaticamente. Resultados incertos continuam reservados, inclusive
após reinício. `ytfun_tiktok_publication_sync` faz somente GET: projeto aceito ou
transferência completa não significam postagem pública. O esquema observado usa
`project_id` para consultar o projeto e `task_list` para acompanhar o item. Além do
processamento concluído, a confirmação lê a página pública sem cookies e verifica
ID, autor, vídeo original, privacidade e rótulo sintético real. Uma página de desafio
ou esquema diferente mantém o estado pendente/processando/desconhecido. Nunca
repita POST para resolver uma falha de leitura do resultado.

Uma recuperação operacional estreita aceita somente a rejeição local do destino
na fase de alocação, antes de qualquer transferência/commit/post. Ela exige o
arquivo privado original, hash exato, origem da resposta e evidência observada;
revalida revisão, conta e cadência, mantém a mesma reserva/criação e preserva o
histórico. Não é aceita para postagem, transferência ou commit de resultado incerto.
Os destinos de armazenamento continuam limitados aos hosts efetivamente observados.

O dispatcher admite entregas TikTok públicas por esta rota e mantém os pacotes
exportados distintos. A cadência é compartilhada por toda a conta e por todos os
formatos. Não há fallback de publicação pelo navegador. Os testes de autenticação,
isolamento de credenciais, reservas e falhas são executados só no GitHub Actions.
