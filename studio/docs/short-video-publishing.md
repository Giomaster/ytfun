# Distribuição de vídeos originais

Verificação das fontes oficiais: **30/09/2026**. A capacidade de publicar não
confirma participação em um programa de monetização. Conta criada, credenciais
configuradas, autorização válida, upload e publicação confirmada são etapas
distintas.

| Destino | Caminho implementado | Condição antes de publicar |
| --- | --- | --- |
| YouTube | Publisher oficial e pacote revisado | OAuth, canal correto, revisão do episódio e gates de visibilidade |
| Facebook | Publisher de Reels de Página e pacote revisado | Token da Página, versão Graph explícita, permissões e gates do adapter |
| TikTok | Pacote para conclusão pelo criador | Importar pelo TikTok ou integração permitida e confirmar publicação |
| Kwai internacional | Pacote para conclusão pelo criador | Conferir as opções disponíveis na conta e publicar pelo Kwai |

## O que a consulta de capacidades significa

`distributionCapabilities(env)` não faz chamadas externas e não revela valores de
credenciais. `configuration.complete` significa que as variáveis obrigatórias
estão presentes, com verificações de formato onde previstas. `readyForPreflight`
indica que o publisher pode iniciar sua verificação, não que a autorização já foi
confirmada. `authorizationVerified` permanece falso nesta consulta local.

YouTube aceita token de acesso ou o conjunto de refresh token, client ID e client
secret. Um conjunto de refresh incompleto não é mascarado por um token estático.
Uploads externos ou agendados dependem dos gates de auditoria e liberação; o
provider ainda precisa confirmar escopos e canal. O Google restringe a visibilidade
de uploads de projetos não auditados nas condições descritas em
[Videos: insert](https://developers.google.com/youtube/v3/docs/videos/insert).

Facebook usa `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN` e
`FACEBOOK_GRAPH_API_VERSION`. O envio depende de
`YTFUN_FACEBOOK_PUBLISH_ENABLED=true` e
`YTFUN_FACEBOOK_APP_REVIEW_CONFIRMED=true`. A configuração local não comprova que
o token representa a Página pretendida ou possui os acessos necessários. O
adapter deve verificar isso e acompanhar o processamento conforme a
[documentação de Reels](https://developers.facebook.com/docs/video-api/guides/reels-publishing/).
O [SDK oficial da Meta](https://github.com/facebook/facebook-python-business-sdk/blob/788f363d15b1269ab5efb7cd00fb5e3b133cd99b/facebook_business/adobjects/page.py#L4842-L4866)
documenta `is_ai_generated` como parâmetro booleano de criação de Reels; o pacote
preserva essa intenção em `disclosure.isAiGenerated`.

## TikTok: limite do nosso tipo de aplicativo

O MCP atual é uma ferramenta privada para gerenciar contas da própria marca.
As [regras de revisão de apps](https://developers.tiktok.com/doc/app-review-guidelines)
excluem aplicativos de uso pessoal ou privado. As
[regras de Direct Post](https://developers.tiktok.com/doc/content-sharing-guidelines)
também excluem utilitários destinados apenas às contas do desenvolvedor ou da
equipe. Por isso, um token ou flag de ambiente não habilita Direct Post neste
projeto.

Uma futura integração permitida precisa oferecer prévia, edição de metadados,
seleção de privacidade, controles de interação e consentimento explícito para
enviar o conteúdo. A auditoria da API e a autorização da conta continuam
necessárias. Não acrescentamos watermarks promocionais ao material exportado.
Esses requisitos estão nas
[diretrizes de compartilhamento](https://developers.tiktok.com/doc/content-sharing-guidelines).

**Upload-to-Inbox é uma alternativa de integração, não publicação automática.**
Exige app aprovado para `video.upload` e autorização do usuário. Após o envio, o
criador abre a notificação no TikTok, revisa e conclui a postagem. Não implementamos
esse transporte para apresentar um app privado como aprovado. Uma integração
compatível de terceiros precisaria ser avaliada separadamente. Fonte:
[Get Started — Upload](https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content).

O pacote preserva o limite de **2200 unidades UTF-16** para caption, com hashtags
incluídas, e marca `isAigc: true`. O campo correspondente em uma integração oficial
é `is_aigc`. A referência oficial documenta ambos os limites e controles em
[Direct Post](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post).
Textos excessivos são rejeitados: não truncamos material já revisado.

A [guia de transferência](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide)
aceita MP4 e recomenda H.264; documenta 23–60 FPS, dimensões entre 360 e 4096 pixels
em cada eixo e até 4 GB. A duração final permitida depende da conta; Direct Post
precisa consultar o limite atual do criador. O studio continua usando seu próprio
limite de render e upload mais restrito. Exportar uma referência MP4 não comprova
que codec, dimensões ou conta já foram aceitos pelo TikTok.

`creatorRewardsDurationCandidate` conserva a regra interna existente de duração
**maior que 60 segundos**. É apenas um candidato de duração, sem confirmar sequer
os demais requisitos do programa. `eligibilityConfirmed` permanece falso.

## Kwai internacional e Kuaishou são integrações distintas

Nas fontes oficiais consultadas, não verificamos uma API pública suportada de
publicação para as contas do Kwai internacional. Isso é um limite da evidência
disponível, não uma afirmação de que a empresa não oferece integrações privadas
ou de parceiros.

O portal chinês documenta um fluxo de upload e publicação com
`user_video_publish`, app registrado e OAuth. O resultado é assíncrono e deve ser
consultado para confirmar a publicação. Essa documentação de
[criação de vídeo do Kuaishou](https://open.kuaishou.com/platformDocs/openAbility/contentManagement/createAVideo.html)
não estabelece suporte para a conta Kwai internacional da AI Meow. Não reutilizamos
esses endpoints, cookies ou credenciais como se fossem intercambiáveis.

O destino `kwai` gera vídeo, caption, hashtags, referência de legendas quando
existente e passos para conclusão pelo criador. Não inventamos um limite global
de caption nem um campo de API para rotular IA. O pacote declara essas condições
como não verificadas e orienta conferir os controles disponíveis na conta.
O Kwai apresenta ferramentas de criação e legendas em
[Creators — Create](https://www.kwai.com/creators/create), e orienta verificar o
Programa de Receita de Anúncios na Central do Criador em
[Creators — Earn](https://www.kwai.com/creators/earn).

## Contrato do pacote revisado

`publicationPackage({ platform, plan, episode, createdAt })` é um construtor puro.
O chamador fornece o resultado de uma preflight bem-sucedida, com os arquivos,
direitos de uso e cadence verificados. O construtor exige correspondência entre
episódio, plataforma, revisão editorial, caption, hashtags e referência do MP4.
Ele não lê arquivos nem concede autorização de publicação.

O resultado é um snapshot JSON profundamente congelado com:

- IDs e hash da revisão; `status: exported`, nunca `published`.
- Referência relativa do vídeo e SHA-256; SRT e SHA-256 quando presentes.
- Caption e hashtags preservadas exatamente como revisadas.
- Declaração de conteúdo sintético e controles específicos já conhecidos.
- Passos do criador, avisos de cadence e limites de evidência por destino.
- Elegibilidade de monetização não confirmada e fontes oficiais consultadas.

`createdAt` usa o formato UTC de `new Date().toISOString()`. O writer do publisher
verifica os arquivos antes de gravar o pacote; os hashes são referências, não
prova de leitura feita pelo construtor. Alterar vídeo, legendas ou metadados exige
uma revisão nova. `metadataEditable: true` descreve a capacidade de editar no
destino, acompanhada de `changedContentRequiresNewReview: true`.

Cadence é uma decisão editorial do projeto, não garantia de alcance nem proteção
automática contra limites das plataformas. O registro de um pacote exportado
não deve ser apresentado como upload, agendamento ou postagem concluída.

Os testes de contrato são executados exclusivamente no GitHub Actions; não há
testes ou renderizações locais para validar essa integração.
