# ytfun — estúdio original de IA via MCP

O ytfun persiste projetos, executa produção e registra distribuição pelo MCP.
Este README descreve capacidades e contratos técnicos; a estratégia vigente do
AI Meow está na [política editorial e operacional única](docs/ai-meow-operation.md).

## Direção acordada

Leia a [política única](docs/ai-meow-operation.md) para modos por rede, papéis da
MESTRE/especialistas, aproveitamento do acervo, duração, direção, cadência e
autonomia. Não interpretar exemplos técnicos ou blueprints históricos como
requisitos editoriais atuais. Não existe requisito geral de master, 96 cenas,
oito ou 12 minutos para lançar uma obra.

A [ficha de direção por plano](docs/video-direction.md) auxilia o planejamento
antes da geração; não introduz piloto obrigatório, refação ou gate estético após
o resultado. Os mecanismos técnicos de revisão permanecem vinculados a hashes,
com o aceite de imperfeições e a evidência verdadeira definidos pela política.

Referências: [identidade visual](assets/brand/ai-meow/README.md) e
[pesquisa datada de plataformas/serviços](docs/monetization-landscape.md).
O pacote `studio/` é independente do CLI histórico da raiz.

## Fluxo implementado

A conexão autenticada por HTTP para conversas na cloud está descrita em
[cloud-mcp.md](docs/cloud-mcp.md). Ela mantém chaves dos providers no servidor,
valida dono/cliente/audiência e separa leitura, produção e publicação. Hospedagem,
conexão no ChatGPT e transferência do publicador são etapas operacionais
separadas; o transporte novo não habilita uma auditoria YouTube nem converte
exportação TikTok em publicação.

1. A IA lê projetos e episódios anteriores, pesquisa contexto e propõe a série.
2. Registra premissa, público, idioma e continuidade dentro da autorização vigente.
3. Planeja episódio com ângulo próprio, hook, narrativa, cenas, formato, modo de áudio e metadados. `format=short` é o padrão: até 12 cenas/180 s. `format=long` permite até 120 cenas/900 s. `audioMode=narrated` exige narração; `silent` usa somente visuais; `nonverbal` exige áudio original por cena sem narração ou legendas. O gerador de voz não atende `nonverbal`; importar efeitos originais com evidência de autoria/licença.
4. Gera imagem/voz/vídeo na inferência remota do Hugging Face ou importa assets
   originais de outros conectores. Provider, modelo, prompt, licença e hashes
   ficam ligados à cena. Fonte de tendência nunca vira footage para edição.
5. FFmpeg monta 1080×1920 (portrait padrão) ou 1920×1080 (`renderCanvas: "landscape"` explícito), 30 fps em worker remoto. Vídeos fonte são encaixados inteiros com margens neutras; imagens mantêm o zoom existente. No modo narrado, exige voz e gera legendas com timing aproximado por cena. `silent` descarta áudio embutido e não gera SRT; `nonverbal` usa áudio original por cena sem legendas. Nos modos sem fala, vídeo mais curto que a cena é bloqueado, sem repetição automática. Imagens recebem movimento simples; áudio maior que a cena é bloqueado para evitar truncamento. Master longo aceita até 512 MiB; render curto e cada asset de origem mantêm 100 MiB. A montagem externa pode ser registrada por manifesto exato e ffprobe independente. [Contrato remoto e limites](docs/long-form-production.md).
6. O registro de revisão/aprovação fica vinculado aos hashes do episódio, arquivo
   final e proveniência. Preserve evidência verdadeira de originalidade, fatos e
   exame efetivamente realizado; não invente audição ou visualização. A política
   única aceita imperfeições da IA e não exige validação humana ou aprovação estética.
7. YouTube recebe upload pela rota configurada, declaração de conteúdo sintético, privacidade
   escolhida explicitamente e agendamento opcional. Facebook recebe cortes como
   Page Reels e episódios `long` pela Page Video API, com declaração de IA e
   confirmação de propriedade/processamento; o master exige permalink oficial.
   TikTok mantém exportação e uma rota REST de sessão experimental, habilitada
   explicitamente para a conta autorizada. Kwai recebe pacotes para envio manual.
   [Zernio/TikTok](docs/tiktok-zernio.md) e [Zernio/YouTube](docs/youtube-zernio.md)
   são rotas separadas autorizadas pelo dono, com público obrigatório e binding
   dos IDs nativos. Não alteram a auditoria do aplicativo próprio nem migram
   tentativas iniciadas. A seleção é explícita no env privado, depois de CI e
   comprovação da conta; sem fallback silencioso entre providers.
8. Métricas observadas e estimativas de custo orientam o próximo experimento.
   Métricas das plataformas ficam separadas; ausência de dado não vira zero.

Na API específica `deriveShort`, um short é derivado de cenas escolhidas de um
pai longo válido e já renderizado. Essa exigência pertence somente àquela API;
uma obra independente pode ser planejada e montada com fontes existentes sem
esperar um master. A operação `deriveShort` copia/remapeia os assets originais e
preserva proveniência, hashes, lineage e intervalos da timeline planejada; não
corta o MP4, não inventa uma nova geração e não aprova o resultado. O short fica
`planned`, precisa de render e revisão próprios. Nesta API, cenas repetidas,
títulos repetidos e outras histórias quase iguais continuam bloqueados; a exceção
de reutilização narrativa é documentada entre pai e filho. Mudanças no pai invalidam a derivação
para revisão e entrega. A seleção deve ter hook, desenvolvimento e final completo.

### Registro verdadeiro de aceite técnico

`Studio.approveEpisode` / `ytfun_episode_approve` mantêm revisão com
`renderWatched:true` como comportamento padrão. A alternativa explícita
`review.mode="owner_accepted_technical"` registra `renderWatched:false`, sem
afirmar playback/audição, somente quando
`YTFUN_OWNER_ACCEPTED_TECHNICAL_REVIEW_ENABLED=true` no runtime. Exige
`originalityChecked:true`, `factsChecked:true`, `reviewedBy`, `notes` e
`technicalAcceptance` estruturado com `renderSha256`, `renderFileChecked:true`,
`sourceFilesChecked:true`, `commercialRightsChecked:true`,
`ownerAcceptedImperfections:true`, `acceptedBy`, `acceptanceReference` e `reason`.
Esses campos representam verificações e aceite reais, não um token nas notas.
A API confere arquivos, direitos/proveniência e hashes atuais; Publisher e
exportação revalidam o mesmo contrato e flag, inclusive ao executar a fila.
Desabilitar a flag bloqueia entregas com esse modo. Não libera auditoria pública,
conta, cadência, gerações pendentes ou reenvio de resultados desconhecidos.

## Inicialização do MCP

Requer Node 22+, pnpm 10.33.0 e armazenamento privado persistente. O servidor
stdio não inicia HTTP nem roda modelos locais. Instalar o pacote não configura
contas e não dispara geração, render ou publicação.

```sh
cd /absolute/path/to/ytfun/studio
pnpm install --frozen-lockfile --ignore-scripts
```

Configure no host MCP, substituindo os caminhos pelos do seu checkout:

```json
{
  "mcpServers": {
    "ytfun": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/ytfun/studio/src/mcp.mjs"],
      "env": {
        "YTFUN_PRIVATE_ENV_FILE": "/absolute/private/path/ytfun.env"
      }
    }
  }
}
```

Veja `.env.example` para variáveis opcionais. Ela é documentação: o servidor
usa variáveis do processo e lê somente o arquivo explicitamente indicado por
`YTFUN_PRIVATE_ENV_FILE`, regular, do proprietário, modo0600 e fora do Git.
Nesse arquivo mantenha `YTFUN_STUDIO_DIR` e as credenciais já autorizadas; no Mac
use `YTFUN_REMOTE_ASSEMBLY_ONLY=true`. O MCP local por stdio não precisa de
ngrok, servidor HTTP ou login AWS. `.env` não é lido automaticamente. Nunca coloque tokens
em prompts, nos projetos ou nos assets. Configuração específica de cada host,
credenciais, auditorias e deployment ainda dependem do ambiente de operação.

Para edição, o worker remoto precisa de FFmpeg/ffprobe com libx264 e libass.
Render não deve rodar no laptop; a regra do proprietário manda executar testes
somente no GitHub Actions. Manifesto e registro remoto são APIs de produção:
hashes/ffprobe não comprovam semanticamente a montagem nem substituem assistir
e ouvir o vídeo. Operações com muitas fontes podem exceder um minuto; manter o
worker vivo e ajustar o timeout do cliente.

## Ferramentas

| Área | Ferramentas |
|---|---|
| Contexto | `ytfun_overview`, `ytfun_project_list`, resource `ytfun://studio/state`, prompt `studio-director` |
| Projetos | `ytfun_project_create`, `ytfun_project_insights` |
| Pesquisa de audiência | `ytfun_trend_discover` (YouTube oficial), `ytfun_trend_record` (outros conectores/evidência) |
| Ferramentas de produção | `ytfun_production_models` (catálogo Hugging Face; sem sinal de audiência) |
| Roteiro | `ytfun_episode_plan`, `ytfun_episode_get`, `ytfun_episode_derive_short` |
| Assets e edição | `ytfun_asset_generate`, `ytfun_asset_import`, `ytfun_episode_render`, `ytfun_episode_render_manifest`, `ytfun_episode_render_register` |
| Produção demorada | `ytfun_production_job_start`, `ytfun_production_job_get`, `ytfun_production_job_reconcile` |
| Revisão | `ytfun_episode_review`, `ytfun_episode_approve` |
| Distribuição | `ytfun_distribution_capabilities`, `ytfun_publish_plan`, `ytfun_youtube_publish`, `ytfun_youtube_publication_sync`, `ytfun_facebook_publish`, `ytfun_facebook_publication_sync`, `ytfun_tiktok_export`, `ytfun_tiktok_publish`, `ytfun_tiktok_publication_sync`, `ytfun_kwai_export` |
| Fila de entrega | `ytfun_delivery_enqueue`, `ytfun_delivery_list`, `ytfun_delivery_run_due`, `ytfun_delivery_reschedule`, `ytfun_delivery_cancel`, `ytfun_delivery_reconcile` |
| Resultados | `ytfun_metrics_record`, `ytfun_youtube_metrics_sync` |
| Dados YouTube | `ytfun_youtube_data_maintenance`, `ytfun_youtube_disconnect` (preview por padrão) |

O MCP expurga snapshots de API do YouTube com 30 dias antes de responder e mantém
um janitor independente do worker de entregas. Para a desconexão explícita,
configure `YTFUN_PRIVATE_ENV_FILE` como o mesmo arquivo privado 0600 usado pelo
host. Ela revoga todos os escopos Google do projeto, remove dados/tokens do
YouTube e conserva bloqueios locais contra reenvio; não apaga vídeos na rede.
[Retenção, falhas parciais e limites de backups/runtime](docs/youtube-data.md).

Operações demoradas podem retornar um job persistido imediatamente. Há um job
ativo por store. O processo MCP precisa continuar vivo; reiniciar não refaz
inferência automaticamente. A ferramenta de reconciliação fecha apenas o
registro de worker depois de inspeção do operador, preservando estados de
cobrança/publicação incertos. Os jobs de produção são separados da
[fila de distribuição](docs/delivery-queue.md), que guarda entregas já revisadas.

Vídeos `fal-ai` enviados pelo router Hugging Face usam o hook público `Options.fetch`
do SDK fixado em `4.13.30`. Antes de liberar a resposta do POST para polling, o
worker grava `spending[].remoteRequest`: `requestId`, URL de envio, caminho de
resultado remoto, status inicial e instante da captura. A validação aceita apenas
HTTPS dos hosts esperados, o parâmetro fixo `?_subdomain=queue` e um caminho de
resultado ligado ao mesmo ID. Headers, credenciais, logs e URLs de mídia assinadas
não são persistidos. O POST recusa redirecionamentos e continua com
`retry_on_error:false`; cada hook permite no máximo um POST.

Falha de validação/gravação impede o polling e mantém a cobrança incerta. Se nem
o registro de `unknown` puder ser gravado, a reserva `reserved` anterior continua
bloqueando reenvio. O recibo é evidência de identidade da tentativa, sem confirmar
fatura, sucesso ou mídia disponível; o status gravado não é atualizado por polling.
Este contrato não implementa retomada automática. O SDK atual faz polling e
download com seu `fetch` global, depois da captura, e o processo MCP ainda precisa
ficar vivo. No SDK `4.13.30`, um `response_url` válido terminado em `/response`
pode produzir polling em `/response/status` e falhar; o recibo validado permanece
para reconciliação manual, sem garantir que a geração termine. Uma interrupção
antes do commit pode deixar uma tentativa sem ID; reservas antigas não ganham
recibos retroativamente. A
[fila oficial fal.ai](https://fal.ai/docs/documentation/model-apis/inference/queue)
pode continuar processando após timeout do cliente; a reconciliação requer
inspeção do provider antes de qualquer novo envio.

Para recuperar uma tentativa com recibo, envie `resumeReservationId` em
`ytfun_asset_generate` (ou no input do job), mantendo episódio, cena, modelo,
prompt, parâmetros, referência de imagem, licença e estimativa originais. A operação faz somente GET:
retorna `pending` enquanto a fila trabalha e registra o MP4 quando concluído,
sem nova reserva ou nova inferência. Recusa worker original ativo/não reconciliado
e recuperação concorrente. Novas reservas guardam a intenção e o job original;
reservas antigas sem esses dados não são reconstruídas. URLs/erros/credenciais
remotos não são expostos; JSON tem limite de 64 KiB e MP4 de 100 MiB.

## Contratos de operação

O `state.json` versionado guarda projetos, episódios, tendências, assets,
publicações, reservas de geração, jobs e entregas. Transações usam lock de diretório,
arquivo temporário com fsync e rename. Corrupção não é convertida em store vazio.
Um lock abandonado exige verificar que nenhum processo o possui; não é apagado
automaticamente. O store foi pensado para um filesystem privado local ao worker,
não como banco distribuído multi-host.

O orçamento opcional é uma barreira sobre estimativas, não limite garantido de
fatura. Uma estimativa zero não prova que a inferência é gratuita. Confirme o
saldo/crédito e termos do provider antes de usar modelos. Não há modelo fixo,
tarifa presumida, promessa de crédito suficiente ou migração automática para pago.

Projetos sem configuração de cadência mantêm o padrão legado de 24 horas/uma
publicação. A configuração explícita aceita intervalo não negativo e contagem
positiva inteira ou `null` (sem teto editorial de quantidade). `0/null` permite
que as especialistas escolham a frequência conforme rede, modo e estratégia.
O publisher aplica políticas numéricas mais restritivas de projetos que compartilham
o canal e preserva reservas/futuros e limites reais do provider. A meta de presença
da operação AI Meow pertence à política editorial; não é um cooldown do uploader.

`ytfun_delivery_reschedule` ajusta somente uma entrega comprovadamente não iniciada,
sem reserva de publicação, após preflight atual. Exige snapshot exato de data,
rede, visibilidade, audiência, conta, rota, hashes e binding anterior; conserva ID,
histórico de provider e consentimentos. Não cancela/recria a entrega nem libera
tentativas desconhecidas. O reagendamento local não é uma agenda confirmada pelo
provider; cada envio é revalidado pelo publisher.

Geração de vídeo aceita `videoParameters` opcional na ferramenta direta e no job.
O subconjunto explícito admite resolução 480p/580p/720p, proporção 16:9/9:16,
81–121 quadros inteiros, 16 ou 24 fps, 1–40 passos, seed de 0 a 2³²−1, interpolador
`none`, zero quadros interpolados e expansão de prompt booleana. Para Wan A14B I2V
no fal.ai com referência inicial, admite também a combinação explícita
`interpolator_model: "film"`, `num_interpolated_frames: 1` e
`adjust_fps_for_interpolation: true`: 16/24 fps tornam-se 32/48 fps mantendo a
duração. Combinações incompletas ou que alonguem o clip são recusadas. Sem parâmetros,
os defaults atuais do provedor ficam intactos. Parâmetros usados ficam na reserva
e na proveniência; a estimativa e a autorização de custo continuam explícitas.
O retry automático de geração do SDK fica desativado; uma falha após a reserva
continua `unknown` e exige reconciliação antes de outra chamada.
Os nomes seguem a [API Wan 2.2 do fal.ai](https://fal.ai/models/fal-ai/wan/v2.2-a14b/text-to-video/api), encaminhados pelo SDK Hugging Face; isso não garante suporte de outros modelos/provedores nem um preço fixo.

Geração de imagem aceita `imageParameters` opcional: `width` e `height` inteiros
entre 256 e 2048, sempre juntos, `num_inference_steps` entre 1 e 50 e `seed` entre
0 e 2³²−1. Para uma referência vertical, por exemplo, use
`{ "width": 720, "height": 1280, "num_inference_steps": 28, "seed": 20261002 }`.
No fal.ai, o studio converte essas dimensões para `parameters.image_size`, pois o
SDK não faz essa tradução. A reserva e a proveniência guardam `imageParameters`
originais; sem esse campo, os defaults do provedor ficam intactos. O contrato
foi alinhado à [API Qwen Image 2512](https://fal.ai/models/fal-ai/qwen-image-2512/api).

Para animar a referência, envie `kind: "video"` e `referenceImageAssetId` com o
ID de uma imagem sintética já registrada na mesma cena e episódio. O studio
valida licença, arquivo dentro de `assets/`, formato e SHA-256 antes de reservar
a chamada. Usa `InferenceClient.imageToVideo` com um Blob de imagem e o prompt
de movimento em `parameters.prompt`; a imagem original permanece registrada.
A reserva guarda `referenceImage: { assetId, sha256 }`, e a proveniência do vídeo
guarda essa referência e `parents` com a mesma derivação. A reserva também guarda
um digest da identidade, caminho e proveniência da imagem; alterações desses
dados impedem a retomada mesmo após reiniciar o worker. A retomada exige o ID
e hash originais e usa a mesma recuperação GET, sem inferência adicional.
Para fixar o quadro final nessa rota Wan A14B/fal.ai, forneça também
`endReferenceImageAssetId`, de uma imagem original na mesma cena e episódio.
Ambas passam pelas mesmas verificações; o quadro inicial continua como Blob e o
final vira `parameters.end_image_url` em data URI somente na chamada ao SDK.
A reserva guarda `endReferenceImage` e seu digest de snapshot; a proveniência
inclui ambos os quadros em `parents`. A recuperação exige os dois IDs, hashes,
snapshots e parâmetros originais, sem persistir bytes/data URIs das referências.
FILM melhora fluidez, sem garantir física correta ou transformar 720p em 1080p
nativo. A tarifa publicada calcula segundos a 16 fps, sem taxa FILM separada:
81 quadros em 720p correspondem a aproximadamente US$0,405, estimável como US$0,41
por tentativa; confirme a [tarifa atual](https://fal.ai/models/fal-ai/wan/v2.2-a14b/image-to-video) antes de autorizar a chamada.
O [Wan 2.2 A14B I2V](https://fal.ai/models/fal-ai/wan/v2.2-a14b/image-to-video/api)
é uma rota compatível; confirme o mapping live do modelo no Hugging Face e a
tarifa atual antes de chamar. A referência orienta a geração; decisões editoriais
e aproveitamento dos resultados seguem a [política única](docs/ai-meow-operation.md),
sem piloto obrigatório ou etapa de correção estética.

YouTube precisa de OAuth válido e `YOUTUBE_CHANNEL_ID`.
Escopos: `youtube.upload` e `youtube.readonly`; métricas pedem
`yt-analytics.readonly`. A autenticação histórica do ytfun pode ser reaproveitada
para iniciar consentimento OAuth; o grant histórico com apenas upload não basta
para verificar o canal. O novo [provider OAuth](docs/youtube-auth.md) renova
tokens com `YOUTUBE_REFRESH_TOKEN`, `YOUTUBE_CLIENT_ID` e
`YOUTUBE_CLIENT_SECRET` já consentidos pelo usuário. Token manual
`YOUTUBE_ACCESS_TOKEN` continua aceito, mas não é renovado. Não ocorre
consentimento, conexão de conta ou gravação de segredos por ferramenta MCP.
O adapter admite tecnicamente privado sem liberação pública; o AI Meow exige
visibilidade pública e não usa privado/unlisted como fallback. No adapter,
unlisted/public e agendamento de tornar público exigem `YTFUN_YOUTUBE_PUBLIC_ENABLED=true` e
`YTFUN_YOUTUBE_AUDIT_CONFIRMED=true`. Só marque auditoria quando confirmada.
`madeForKids` é escolha explícita por upload. Arquivo MP4 tem limite inicial de
250 MiB no publisher. Apenas hosts Google permitidos recebem o Bearer.

Upload gera uma reserva antes da chamada externa. Rede interrompida depois da
tentativa produz resultado `unknown` e bloqueia repetição/edição. `uploaded`,
`scheduled`, `published` e `exported` são estados distintos. Um agendamento
confirmado não vira publicação confirmada sem consultar o provider. A ferramenta
`ytfun_youtube_publication_sync` verifica o vídeo recebido e só declara publicado
quando YouTube confirma processamento concluído e privacidade pública.
Para desfechos incertos, conferir no provider e reconciliar com evidência antes
de outra tentativa; não apagar registros para recomeçar. A versão inicial não
tem reconciliação automática de cobrança nem de uploads sem recibo.

[Facebook](docs/facebook-publishing.md) exige Page token, ID explícito da Página,
versão Graph fixada e confirmação dos requisitos de permissão/acesso da Meta.
As flags `YTFUN_FACEBOOK_PUBLISH_ENABLED=true` e
`YTFUN_FACEBOOK_APP_REVIEW_CONFIRMED=true` habilitam envio público depois da
configuração real. A identidade da Página é verificada antes do envio. O perfil
conservador de Reels é MP4 vertical de 4–60 segundos. Episódios explicitamente
`long` usam outra rota, Page Video API, com limite operacional de 4–900 segundos,
250 MiB e trechos de até 8 MiB. Esse limite longo pertence ao studio; a duração
máxima atual da API Meta não foi confirmada nas páginas técnicas que retornaram
429. A aceitação do servidor segue necessária. O recibo guarda a rota para
reconciliação sem reenvio; ambas as rotas compartilham a cadência da Página.
O renderer guarda resolução, fps e formato na revisão. Receber `success:true`
ao enviar não equivale a confirmar publicação; processamento e propriedade do
vídeo são consultados no provider. A fila respeita esses mesmos gates.

[TikTok](docs/tiktok-session-rest.md) tem uma rota experimental pela sessão privada,
separada do OAuth/Direct Post oficial. Ela não presume aprovação do aplicativo,
não automatiza login nem contorna desafios; publicação exige prova pública real.
O provider Zernio exige preview real do dono e consentimento para o render exato:
`ytfun_tiktok_zernio_consent_record` registra essa evidência e interações,
sem substituir a aprovação técnica nem inventar visualização.
`ytfun_zernio_delivery_migrate` move apenas claims públicos não iniciados,
preservando horário, mídia e histórico. Resultados incertos continuam na rota
original; `ytfun_tiktok_publication_sync` e `ytfun_youtube_publication_sync`
selecionam a reconciliação pelo recibo persistido, nunca pelo provider atual.
Kwai internacional fica como pacote para o criador. Não foi confirmada uma API pública de postagem para Kwai
internacional; APIs do Kuaishou chinês não são tratadas como compatíveis.
Métricas manuais aceitam as quatro plataformas, mantendo valores e fontes
separados. Nenhuma elegibilidade de monetização é inferida da exportação.

A investigação de uma integração própria para Kwai começa pelo
[inventário sanitizado de capturas](docs/kwai-capture.md). O comando offline
`pnpm inspect:kwai-har /private/location/capture.har --host observed.kwai.com`
analisa apenas hosts exatos escolhidos e omite segredos e valores. O host no
exemplo não é um endpoint confirmado. Essa ferramenta não captura tráfego,
não envia requisições e não habilita publicação na fila. HARs brutos devem
ficar em armazenamento temporário privado, fora do repositório e das mídias.

## Políticas atuais consideradas — 30/09/2026

- YouTube permite monetização de conteúdo original/autêntico; produção repetida
  com modelos genéricos de IA pode ser inelegível. Personagens recorrentes não
  dispensam histórias diferentes. [Política de monetização](https://support.google.com/youtube/answer/1311392?hl=pt-BR).
- Conteúdo sintético realista precisa de declaração. O publisher sempre envia
  `containsSyntheticMedia=true`. Projetos de API não auditados podem ficar
  restritos a privado. [Upload oficial](https://developers.google.com/youtube/v3/docs/videos/insert).
- Um MCP privado para publicar só nas próprias contas não corresponde ao uso
  permitido do TikTok Direct Post. O fluxo também pede preview, legenda editável,
  seleção de privacidade e consentimento. A rota privada REST experimental é
  separada e não afirma aprovação no Direct Post. [Diretrizes do TikTok](https://developers.tiktok.com/docs/en/content-sharing-guidelines).
- Conteúdo IA não garante elegibilidade no Creator Rewards. Formatos com pouco
  valor original, imagens repetidas ou loops podem não atender ao programa.
  [Recompensas do criador](https://support.tiktok.com/pt_BR/business-and-creator/creator-rewards-program/creator-rewards-program).

Séries não garantem distribuição, renda ou posição em tendências. Não usar
engajamento artificial, bots de views, tags enganosas ou tentativa de esconder
automação. Importar assets de IA não elimina a obrigação de conferir os termos
do modelo/provider e direitos de todos os inputs.

## Validação e expansão

`.github/workflows/ai-studio-ci.yml` executa testes do MCP/domínio/adapters e a
suíte histórica do ytfun. Os novos testes exercitam falhas de persistência,
concorrência, licenças, hashes, custos, render e rede simulada; não geram cobrança
nem publicam vídeos reais. O parecer final é o CI no commit da PR.

Os adapters e a fila exigem credenciais e um processo MCP persistente em um
worker adequado. Configurar perfis no navegador é separado de conectar APIs.
Este código não criou app OAuth, concedeu permissões, habilitou worker ou
enviou vídeos reais. A validação dos novos adapters e da fila ocorre no CI.

## Operação recorrente do AI Meow

Os papéis, modos, quantidade de obras por ciclo e autonomia de publicação seguem
exclusivamente a [política editorial e operacional única](docs/ai-meow-operation.md).
Quantidade produzida e frequência de envio são decisões separadas; a política
permite múltiplas obras/formatos por ciclo e adaptação da cadência por rede e modo.

No contrato técnico, `ytfun_project_cadence_update` altera a cadência pelo domínio,
preserva histórico e exige a política anterior esperada para impedir escrita
baseada em estado antigo. A execução lê a política efetiva e revalida todas as
publicações/reservas do canal; não editar o store à mão ou apagar o histórico.
Heartbeats locais dependem do Mac e Codex disponíveis. Filas/exportações locais
não equivalem a agendamento ou publicação confirmados pelo provider; liberação
pública do YouTube e resultados das outras integrações exigem evidência real.
