# Acesso offline ao YouTube

O provider `src/oauth.mjs` renova uma autorização já concedida pelo dono do canal.
Ele não abre login, pede senhas, cria cliente OAuth, aceita termos nem concede
permissões. A conta criada no site e a autorização da API são etapas distintas.

## Configuração do worker

Para automação, configure no ambiente privado do host MCP/worker:

| Variável | Uso |
|---|---|
| `YOUTUBE_CHANNEL_ID` | Canal que o publisher precisa confirmar antes de enviar |
| `YOUTUBE_REFRESH_TOKEN` | Grant offline obtido com consentimento do usuário |
| `YOUTUBE_CLIENT_ID` | Cliente que recebeu esse grant |
| `YOUTUBE_CLIENT_SECRET` | Segredo desse mesmo cliente |
| `YOUTUBE_REFRESH_TOKEN_EXPIRES_AT` | Opcional: expiração conhecida, em ISO UTC, como `2026-10-07T12:00:00Z` |

Qualquer campo preenchido do trio de refresh seleciona esse modo e exige os três.
Não há fallback silencioso para um access token antigo quando o refresh falha.
As credenciais são lidas na construção do provider; após corrigir a configuração,
reinicie o processo. O servidor não carrega `.env` automaticamente.

O modo manual continua disponível com `YOUTUBE_ACCESS_TOKEN`. Pode incluir
`YOUTUBE_ACCESS_TOKEN_EXPIRES_AT` no mesmo formato. Sem essa data, a validade e os
escopos do token manual continuam desconhecidos até a API responder; não existe
renovação desse modo. Para operação contínua, prefira o grant offline.

Nunca cole tokens, códigos ou client secrets na conversa, em projetos, prompts,
metadados de mídia ou logs. Use o armazenamento de segredos do ambiente de
operação, fora do checkout, com acesso limitado ao worker.

## Helper Desktop para configurar o ambiente

O helper do studio realiza o consentimento de um **cliente Desktop** do Google
com a biblioteca oficial `google-auth-library`. Ele pede somente `youtube.upload`
e `youtube.readonly`; não pede Analytics ou acesso financeiro nesta configuração.

Prepare dois arquivos privados fora do repositório, pertencentes ao usuário e
com permissão `0600`: o JSON do cliente (`installed`) e um `.env` já existente.
Nesse `.env`, configure primeiro o `YOUTUBE_CHANNEL_ID` pretendido. Para AI Meow,
o canal confirmado nesta configuração é `UCjwAEFZPOQ6FIfweosLmCTg`.

Execute a partir de `studio/`, com Node 22+ e as dependências instaladas:

```sh
node scripts/youtube-oauth-setup.mjs \
  --client "/private/oauth/google-client.json" \
  --env-file "/private/ytfun.env"
```

Os argumentos contêm somente caminhos. O helper imprime a URL de consentimento
do Google e aguarda por até dez minutos; não abre o navegador nem confirma a
tela. Abra a URL no perfil Chrome correto, entre diretamente no Google e confira
o canal e as duas permissões antes de consentir. A URL contém client ID público,
`state`, challenge PKCE e callback; não contém client secret, tokens ou códigos.
Não compartilhe capturas de telas/URLs que contenham o código de retorno.

O callback usa porta efêmera em `127.0.0.1` e valida origem, caminho, parâmetros
limitados, estado e uso único. A troca usa PKCE S256 e não repete o authorization
code. O listener fecha na conclusão, cancelamento ou timeout. O helper só grava
o refresh token depois de confirmar `channels.list(mine=true)` para o ID esperado.
Escolher outro canal ou negar um escopo deixa o arquivo original intacto.

A atualização usa arquivo temporário privado, fsync e rename, com lock exclusivo
entre helpers e detecção de mudanças concorrentes. Preserva as demais configurações
e comentários em assignments de uma linha, remove access tokens/expirações antigos
e fixa `YTFUN_YOUTUBE_PUBLIC_ENABLED=false` e `YTFUN_YOUTUBE_AUDIT_CONFIRMED=false`.
O helper não aceita arquivos com valores multiline, symlinks ou permissões abertas.
Um lock `.oauth.lock` deixado por interrupção abrupta só deve ser removido depois
de confirmar que nenhum helper continua ativo.

Client ID/secret e refresh token são gravados no `.env` privado; os arquivos de
credenciais originais não são alterados. O helper não imprime resultados de APIs,
tokens ou erros brutos do SDK, e desativa os interceptores de logging OAuth.
Depois de configurar, reinicie o worker com esse arquivo de ambiente; configurar
um grant não publica vídeo nem habilita auditoria. Esse fluxo segue as
[regras oficiais para aplicativos Desktop e loopback](https://developers.google.com/identity/protocols/oauth2/native-app).

## Obter o grant com o dono do canal

1. No projeto Google Cloud pessoal escolhido, habilite YouTube Data API v3;
   habilite YouTube Analytics API somente se for coletar métricas.
2. Configure um cliente OAuth adequado ao ambiente e seu callback autorizado.
   Use o fluxo oficial com biblioteca Google para consentimento e troca do código,
   validando `state` e os requisitos do tipo de cliente. O provider deste pacote
   não implementa um callback de autorização; o helper Desktop acima oferece
   esse passo para clientes `installed`.
3. Peça `access_type=offline`. O dono entra diretamente no Google e confere o
   canal e as permissões antes de consentir. Escolha o canal AI Meow quando houver
   seleção entre canal pessoal e canais de marca.
4. Confira os **escopos efetivamente concedidos** na resposta. Para upload e
   confirmação de propriedade, o studio utiliza:

   ```text
   https://www.googleapis.com/auth/youtube.upload
   https://www.googleapis.com/auth/youtube.readonly
   ```

   A coleta de métricas também utiliza:

   ```text
   https://www.googleapis.com/auth/yt-analytics.readonly
   ```

5. Armazene o refresh token e os dados do mesmo cliente no ambiente privado.
   Se houver expiração informada no consentimento, registre a data absoluta.
   Quando um grant existente não inclui offline/escopos necessários, faça novo
   consentimento; uma chamada de refresh não amplia permissões.

O comando histórico `youtube-auth` do CLI solicita somente `youtube.upload`.
Um token obtido por ele não comprova o escopo de leitura exigido pelo studio nem
o escopo de Analytics. Não transfira esse token supondo que ele já permite todas
as operações. As [instruções oficiais de OAuth para YouTube](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps)
descrevem a configuração do cliente e o consentimento; o [fluxo offline do Google](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
descreve a renovação. Os [escopos de Analytics](https://developers.google.com/youtube/analytics/reference/reports/query#authorization)
separam métricas de audiência de relatórios financeiros.

## Contrato e falhas

`new YouTubeAuth({ env, fetchImpl, now })` permite injetar rede e relógio no CI.
`readiness({ requiredScopes })` não faz rede: retorna modo, barreiras sem segredos,
`refreshable` e `scopesVerified`. `ready` comprova somente configuração conhecida,
não consentimento válido, propriedade do canal, monetização ou liberação pública.
`getAccessToken({ requiredScopes })` é a única operação que entrega a credencial;
seu retorno serve apenas ao header Bearer da API e não deve virar resposta MCP.

O endpoint de renovação é fixo: HTTPS `oauth2.googleapis.com/token`, com POST
form-encoded, redirecionamento proibido e timeout de 30 segundos. Tokens ficam em
campos privados na memória. Chamadas simultâneas compartilham uma renovação por
instância; processos diferentes não compartilham cache. O cache respeita a
expiração retornada, antecipa 60 segundos e tem limite adicional de 24 horas.
Não há serialização de credenciais, gravação de token no store ou renovação por
timer. Cada operação solicita um token antes de contatar a API.

Quando Google retorna `scope`, o provider bloqueia escopos requeridos ausentes.
Sem essa informação, `scopesVerified=false`; a checagem da API continua necessária.
O provider exige os escopos exatos solicitados pelos adapters, sem presumir que
uma permissão ampla equivale automaticamente a outra. `refresh_token_expires_in`,
quando retornado, limita a validade conhecida do grant.

`invalid_grant`, cliente rejeitado ou escopo rejeitado interrompem novas tentativas
nessa instância. Corrija a configuração ou obtenha novo consentimento e reinicie.
Falhas transitórias não são repetidas na mesma chamada; uma chamada explícita
posterior pode tentar novamente após cooldown de 30 segundos. Erros de rede e
corpos de erro do Google não são propagados. Uma falha de autenticação não autoriza
repetir um upload cujo resultado ficou desconhecido.

Refresh tokens podem expirar ou ser revogados. Aplicações externas em **Testing**
com escopos de YouTube recebem grants que expiram em sete dias. Verifique o estado
real do consentimento antes de depender de operação contínua; mudar a configuração
do app não deve ser tratado como renovação automática de um grant existente.
Veja [expiração de refresh tokens](https://developers.google.com/identity/protocols/oauth2#expiration).

A autorização OAuth não substitui revisão editorial, auditoria da API, escolhas de
privacidade ou conciliação de publicação. As barreiras de publicação pública do
studio continuam aplicáveis. Para remover o acesso, retire os segredos do worker
e revogue a conexão no [Google](https://myaccount.google.com/connections).

Os cenários de cache, concorrência, expiração, escopos e falhas de autenticação
têm testes com rede simulada em `test/oauth.test.mjs`. Executam somente no workflow
GitHub Actions `AI Studio CI`; não rode testes no laptop. As regressões do helper
em `test/youtube-oauth-setup.test.mjs` usam grants falsos, rede Google simulada e
callback local somente no runner do CI; nunca use o helper como smoke test local.
