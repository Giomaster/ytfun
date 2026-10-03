# Áudio original e montagem remota de fontes existentes

A política editorial única está em [ai-meow-operation.md](ai-meow-operation.md).
Este guia descreve os contratos técnicos das rotas. Não impõe master, número de
cenas, duração mínima, revisão estética ou validação humana à operação.

As rotas deste documento foram implementadas para o acervo histórico volume01.
Seus números (96 bindings/WAVs, fontes de7,5s e master720s) descrevem os packets
daquela implementação, não requisitos de uma obra nova. A rota selecionada ainda
reutiliza o artifact original completo de áudio; não exige que todas essas fontes
entrem no vídeo escolhido. Não gerar ou esperar96 áudios/cenas para adequar um
novo roteiro a esse helper. Para outras origens, escolher uma rota compatível
ou fazer manutenção concreta do worker, preservando a mídia existente.

Os novos workers são produção explícita, sem inferência, envio a redes ou alteração
do store canônico. Cada lançamento exige um packet privado gzip/base64 com menos
de 48 KiB, vinculado pelo SHA-256 canônico ao arquivo público `launch`. Os workflows
rodam somente quando esses arquivos mudam na branch `codex/ai-original-studio`.
Não há workflow_dispatch, chamadas pagas, POST ao provider ou nova imagem.
Os testes usam mocks e uma integração real de montagem somente no GitHub CI;
não executar testes, áudio ou render no laptop.

## Montagem selecionada do acervo histórico volume01

`selected-assembly-packets.mjs` e `remote-selected-assembly-worker.mjs` aceitam
fontes distintas existentes de 7,5 s, sem exigir o master de 96 cenas.
O manifesto nativo `short` aceita de 1 a 12 cenas, até 180 s e exatamente
100 MiB como limite de arquivo; `long` aceita de 1 a 96 cenas nesta rota,
até 720 s e exatamente 512 MiB. A duração da seleção sempre é cenas × 7,5 s,
portanto uma seleção `short` de 12 fontes tem 90 s, dentro do teto do domínio.
O limite de arquivo é vinculado ao formato e conferido na saída pelo worker.
O workflow `AI Meow Selected Assembly` só inicia quando muda deliberadamente
`studio/batches/selected-assembly-launch.json` na branch de produção. Alterar
o código executa CI e não relança mídia. O contrato legado abaixo permanece intacto.

Crie um episódio próprio por `Studio.planEpisode` com `format: "short"` ou `"long"`,
`audioMode: "nonverbal"` e o canvas desejado; importe os vídeos/WAVs existentes por
`Production.registerAsset` preservando a proveniência verdadeira e a linhagem
nos registros da composição. Não edite o episódio de origem nem o store à mão.
Exporte seu manifesto inteiro por `Production.exportRenderManifest`.

O packet privado tem `schemaVersion: 1`, `type: "selected-assembly"`, `id`,
`episodeId` de destino, `sourceEpisodeId` do áudio original, `manifest`,
`audioBindings` com todas as 1 a 96 cenas/hashes do artifact original, `audioArtifact` no formato abaixo
e `sources`: `{ assetId, sha256, sourceSceneId, sourceIndex, remoteRequest }`.
`assetId` aponta ao visual do novo manifesto; cena/índice apontam ao WAV original.
A ordem final é exclusivamente a ordem do manifesto, podendo diferir da origem.
Fontes, hashes, requests e índices repetidos são recusados. Cada WAV precisa
corresponder ao hash exato do áudio selecionado para a cena de destino.

Para finalizar o próprio episódio bruto, `episodeId` pode ser igual a
`sourceEpisodeId` somente quando todos os bindings/cenas estão presentes e
cada fonte mantém `sourceSceneId` igual à cena do manifesto e `sourceIndex`
igual à sua posição a partir de 1. Isso permite uma cena inteira com seu áudio
próprio, sem planejar um episódio equivalente nem exigir um master. Qualquer
vínculo ausente, alterado ou reordenado nesse modo é recusado. A composição
entre episódios continua preservando os índices e hashes originais.

Use `packSelectedAssemblyPacket` para guardar o valor `encoded` no secret
`AI_MEOW_SELECTED_ASSEMBLY_PACKET`. O launch público contém somente
`{ schemaVersion: 1, type: "selected-assembly", batchId, episodeId, packetSha256 }`.
Nunca grave o packet, recibos privados do provider ou credenciais no Git/logs.
Antes do lançamento confira exclusões por IDs, hashes e linhagem, uso editorial
e reservas. Uma variante do mesmo conceito não cria outra ideia automaticamente.

O worker verifica integralmente o artifact de áudio original (propriedade,
run/commit/workflow, recibo, WAVs e hashes), recupera vídeos somente por GET,
encaixa cada fonte inteira no canvas do manifesto e concatena os WAVs na nova
ordem. Não há loop, alongamento, inferência ou revisão estética. Produz somente
`master.mp4` e `render-manifest.json`, no artifact
`ai-meow-selected-assembly-<id>` com retenção de sete dias. O recibo inclui nova
cena, cena/índice originais, hashes e intervalos de origem/saída.
O recibo também conserva `sourceProbe` e `measuredOriginalDurationSeconds` de
cada bruto e o `masterProbe` integral obtido por ffprobe no runner remoto. O
probe do master é validado contra o manifesto entre duas leituras do hash do
arquivo, vinculando streams e SHA aos mesmos bytes. Esses dados são medições
técnicas, sem atestar playback, sincronismo ou revisão estética.
Nenhum artifact confirma aprovação ou publicação. Expiração ou falha de GET exige recuperar o
material preservado; não autoriza nova síntese/inferência nem rerun automático.

Verifique run/artifact/recibo/hashes e registre por `Production.registerRemoteRender`
com o manifesto exportado exato. O resultado é `rendered`; aprovação técnica,
cadência, visibilidade pública e recibo de publicação continuam separados.
Para material não assistido sob o aceite explícito do dono, `Studio.approveEpisode`
aceita `review.mode: "owner_accepted_technical"` e `renderWatched: false` com a
configuração habilitada e `technicalAcceptance` completo ligado ao SHA atual,
arquivos/fontes/direitos realmente conferidos e referência ao aceite. Ver schema
em [README](../README.md). Não declarar audição nas notas quando não ocorreu;
aceite técnico não relaxa fingerprints, licenças, conta, cadência ou auditoria.

## Prévia para revisão audiovisual

`review-packets.mjs` e `remote-review-worker.mjs` montam até 12 fontes distintas
já observadas e aceitas com seus WAVs originais. O packet privado vincula o hash
aceito de cada vídeo, seu recibo original, a posição/cena correspondente e os
96 bindings de áudio. `ownedAudioArtifact` reaplica as verificações de propriedade,
recibo e todos os WAVs; a projeção de áudio não é um manifesto de render do master.
Os vídeos são recuperados somente por GET e precisam manter hash e duração.

Secret `AI_MEOW_REVIEW_PACKET`; launch público `studio/batches/review-launch.json`
contém somente schemaVersion1, type `review`, batchId, episodeId e packetSha256.
O workflow `AI Meow Audiovisual Review` produz MP4s no perfil final e MP3s para
audição, com `review-manifest.json`, no artifact `ai-meow-review-<batchId>`.
Não gera imagens, inferência, aprovações, publicações ou registros canônicos.
Recibos de revisão têm `reviewOnly:true`, `approved:false`, `published:false`;
gerar/copiar um arquivo não atesta que alguém o ouviu ou revisou o sincronismo.
A seleção parcial permite observar material conhecido sem encerrar nem reenviar
uma geração pendente de outra cena. Somente o packet do master histórico de96
fontes descreve aquela coleção completa; esse formato não limita as publicações
selecionadas nem cria uma etapa obrigatória de revisão estética atual.

`AI Meow Audio Input Diagnosis` é uma verificação remota somente de leitura,
lançada somente por uma alteração explícita de `review-diagnostic.json` com a
identidade exata do review preparado. Alterar o código do worker não relança
esse diagnóstico operacional com um packet histórico. Os testes dos workers
continuam obrigatórios no AI Studio CI.
`audioOnly:true` para antes de qualquer GET ao provider, FFmpeg ou upload.
Falhas mostram somente rótulos de etapas e códigos internos conhecidos; nunca
mensagens arbitrárias, caminhos, tokens ou respostas de transporte.

## Áudio do lote histórico de96 cenas

`studio/scripts/assembly-packets.mjs` exporta `packAssemblyPacket`, `packetHash`
e `canonicalJson`. Não escrever o conteúdo `encoded` em logs, comentários ou
arquivos públicos; ele é o valor do secret `AI_MEOW_AUDIO_PACKET`.

```js
const packet = {
  schemaVersion: 1, type: "audio", id: "<UUID do lote de áudio>",
  episodeId: "<UUID do episódio de origem>",
  scenes: [ // de 1 a 96, índices contíguos a partir de 1
    { index: 1, sceneId: "<UUID da cena>", title: "Original scene title",
      genre: "textile", seed: 20261001, durationSeconds: 7.5,
      audioProfile: "cloth-rest" }, // opcional; "quiet-water" também é aceito
  ],
};
const { encoded, packetSha256 } = packAssemblyPacket(packet);
const launch = { schemaVersion: 1, type: "audio", batchId: packet.id,
  episodeId: packet.episodeId, packetSha256 };
```

O controller instala o secret e faz push de `studio/batches/audio-launch.json`
com esse `launch`. `AI Meow Original Audio` gera WAVs estéreo PCM16, 48 kHz,
exatos 7,5 s, em `audio/001.wav` até o último índice autorizado. Uma cena gera
somente seu WAV e o recibo, sem síntese de 95 cenas adicionais. Essa duração é
o contrato nativo desta rota, não um piso editorial. Síntese é procedural, determinística
por seed/título/gênero, sem samples externos, voz, modelos ou downloads. Seis
famílias variam contato, resistência, fratura/impacto, revelação e assentamento;
picos são limitados, DC corrigido e o final termina em silêncio. Os cues são uma
direção inicial. Uma alegação de inspeção de sincronismo, prazer sonoro ou ausência
semântica de fala exige observar os arquivos reais. O aceite técnico de resultados
não assistidos registra essa ausência de observação sem impor uma refação.

Sem `audioProfile`, os seis perfis legados e suas receitas continuam como antes.
`cloth-rest` cria uma textura contínua suave para tecido e repouso;
`quiet-water` usa outro timbre contínuo para água/vento leves. Ambos têm pico
limitado a 0,18, entrada e encerramento suaves, estéreo e DC corrigido, sem
efeitos pontuais, contato, fratura ou revelação sincronizados, samples, fala ou
inferência. O perfil explícito integra a identidade/hash do pedido e o recibo.
Isso registra a intenção da construção; não afirma que alguém ouviu o resultado.

Artifact: `ai-meow-audio-<packet.id>`, retenção de sete dias, com os WAVs autorizados e
`audio-manifest.json`: identidade de lote/episódio/packet, repository/run/commit,
spec e cada sceneId/index/título/gênero/seed/duração/path/SHA/tamanho/síntese.
O verificador exige exatamente a contagem completa de bindings fornecida,
além de todos os hashes e da identidade do run/artifact; não aceitar recibo
truncado ou acrescentado para fazer uma seleção pequena passar.
O retorno do worker informa artifactId e hash canônico desse recibo. Os campos
são dados autorais do conteúdo; nenhum token, prompt ou dado de conta é incluído.

Baixe/verifique o artifact e importe cada WAV por `Production.registerAsset`
como áudio original da cena, com evidência verdadeira de autoria/termos. Use
`audioMode: "nonverbal"`. Não copie registros do store à mão. Só então exporte
o manifesto atual com `Production.exportRenderManifest`.

## Montagem do master histórico volume01

Secret `AI_MEOW_RENDER_PACKET`, preparado pelo mesmo helper:

```js
const packet = {
  schemaVersion: 1, type: "render", id: "<UUID do lote de montagem>",
  episodeId: "<UUID do master>", manifest, // objeto exportado inteiro, sem alterações
  visuals: [ // exatamente 96, vinculados aos visual.assetId/SHA do manifesto
    { assetId: "<UUID>", sha256: "<SHA original>", remoteRequest: {
      provider: "fal-ai", transport: "huggingface-router",
      requestId: "<ID real já persistido>",
      responsePath: "/fal-ai/<rota>/requests/<mesmo ID>/response",
    } },
  ],
  audioArtifact: {
    artifactId: 123, runId: 456, repository: "Giomaster/ytfun",
    commitSha: "<commit real do workflow de áudio>", batchId: "<UUID do áudio>",
    packetSha256: "<hash do packet de áudio>",
    manifestSha256: "<hash canônico do audio-manifest.json>",
  },
};
const { encoded, packetSha256 } = packAssemblyPacket(packet);
const launch = { schemaVersion: 1, type: "render", batchId: packet.id,
  episodeId: packet.episodeId, packetSha256 };
```

`remoteRequest` contém apenas os quatro campos mostrados; remova os demais campos
do recibo original ao preparar o packet. Não inventar IDs, atualizar hashes para
aceitar arquivos diferentes nem trocar resultados do provider. Os 96 vídeos
precisam ser distintos, completos e já registrados como fontes originais.

O controller instala o secret e faz push de `studio/batches/render-launch.json`.
`AI Meow Remote Assembly` verifica a identidade do artifact/run de áudio: mesmo
repositório, commit/ID/nome, branch, workflow correto e execução concluída com
sucesso. O download usa `@actions/artifact` fixado em 2.3.2 com `findBy` e token
`actions:read`. O `expectedHash` conserva o formato `sha256:<hex>` que essa
versão do SDK devolve e compara; remover o prefixo causava uma falsa divergência.
Confere o recibo autorizado e o WAV/SHA de cada cena contra o
asset de áudio importado no manifesto. [API oficial de artifacts](https://github.com/actions/toolkit/tree/main/packages/artifact).

Cada vídeo é recuperado por `recoverFalVideo`, somente GET, usando o recibo
fal-ai/HF original. Se ainda estiver pendente, hash divergir ou duração for menor
que a cena, a montagem falha; não submete, repete ou cancela inferência. Downloads
de vídeo mantêm o cap de 100 MiB e o áudio próprio substitui qualquer som embutido.

O worker monta 96 MP4s de 7,5 s no canvas exato do manifesto: 1080×1920 ou
1920×1080, ambos a 30 fps. Todos os outputs do packet usam esse mesmo canvas;
um arquivo horizontal no diretório `shorts` é uma unidade curta de montagem,
não uma classificação automática de YouTube Short. H.264 yuv420p, CRF20 com
maxrate 2,2 Mbps/bufsize 4,4 Mbps, preset fast/quatro threads, AAC 128 kbps
estéreo/48 kHz, sem loop, fala ou
texto inserido. Reúne os vídeos na ordem com cópia de streams de vídeo e codifica
o áudio a partir dos WAVs originais, evitando acumular priming de AAC por unidade.
Gera oito compilações de 12 cenas/90 s e o master de 720 s. Perfil, áudio, duração,
hash e tamanho são conferidos por ffprobe e leitura dos arquivos; master deve
caber em 220 MiB, sem reencoding automático se exceder. A ausência semântica de
fala/texto não é provada por ffprobe; não declarar essa inspeção quando não ocorreu.
O aceite de imperfeições e sua representação técnica seguem a política única.

O job de montagem tem limite total de 180 minutos. Não há medida prévia de sua
velocidade ou garantia de conclusão nesse prazo. O recibo guarda tempos reais de
recuperação, encoding por unidade, montagem e elapsed do worker antes do upload,
para avaliar a primeira execução de produção remota. Essas medidas não incluem
preparação do runner ou upload do artifact e não são benchmarks locais.

Artifact `ai-meow-render-<packet.id>`, sete dias, contém `master.mp4`,
`shorts/001.mp4`…`096.mp4`, `compilations/01.mp4`…`08.mp4` e
`render-manifest.json` com hashes/metadados/proveniência de fontes e ranges.
Não inclui queue paths/IDs, URLs assinadas, prompts, credenciais ou fontes privadas.
Os ranges são limites planejados de cenas, não uma análise de movimento por frame.

Baixe/verifique os arquivos e registre o master por
`Production.registerRemoteRender({ episodeId, localPath, manifest, provenance })`
usando o manifesto original exato. Derive os shorts/compilações com
`Studio.deriveShort`, exporte seus manifestos remapeados e registre os respectivos
MP4s com proveniência verdadeira da montagem. Isso requer um master renderizado
válido; não contornar o estado com patches. Cada entrega conserva aprovação técnica
própria e verdadeira, cadência e limites da rede. O modo de aceite do dono descrito
acima não exige playback nem validação estética/humana. Nenhum artifact confirma publicação.

Logs dos helpers só informam contagens, IDs/hash de artifacts e estado. Falhas são
genéricas; stderr, packets e tokens não são persistidos. Fluxos recusam reruns da
mesma execução; use um lançamento novo somente após identificar o motivo da falha.
