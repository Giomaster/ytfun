# Produção de vídeos longos e registro de montagem remota

Este documento descreve limites e APIs de produção. Estratégia, duração útil,
formatos, aceite de imperfeições e papéis seguem exclusivamente a
[política editorial e operacional única](ai-meow-operation.md). `format: "long"`
é um perfil de capacidade do Studio, sem duração mínima editorial ou requisito
de master. Exemplos de coleção e o packet legado de 96 cenas não bloqueiam
uma montagem independente mais curta.

`format: "long"` permite até 120 cenas e 900 segundos por episódio. O formato
`"short"`, inclusive episódios antigos sem `format`, mantém 12 cenas e 180
segundos. Cada cena tem entre 1 e 60 segundos. Esses são limites deste Studio,
não uma declaração dos limites de publicação das plataformas.

O master longo pode ter até 512 MiB; o master curto mantém 100 MiB. Cada asset
de origem continua limitado a 100 MiB, incluindo imports, referências e mídia
gerada. O hash/cópia do master usa blocos de até 1 MiB para evitar carregar um
master inteiro de 512 MiB na memória.

O canvas é uma escolha independente do limite de duração: `renderCanvas` omitido
ou `"portrait"` produz 1080×1920; `"landscape"` produz 1920×1080. Ambos usam
MP4, 30 fps, H.264, com o áudio
planejado: `silent` remove áudio e legendas; `narrated` usa as vozes das cenas e
legendas aproximadas; `nonverbal` exige áudio original de efeitos, ambiente ou
música por cena, com narração vazia e sem legendas/texto gerado. O campo `format`
amplia duração, quantidade de cenas e tamanho do master; não decide o canvas nem
classifica a publicação numa plataforma. A execução real ocorre em worker remoto;
testes só no CI. Escolha `renderCanvas: "landscape"` ao planejar um regular
horizontal, inclusive uma montagem curta que cabe nos limites de `format: "short"`.
Vídeos fonte são encaixados inteiros com margens neutras, sem recortar a ação.
Imagens mantêm o movimento de zoom existente; planeje suas margens de composição.
Essa adaptação não solicita nova geração nem comprova elegibilidade para receita.

Em `nonverbal`, importe o áudio original já preparado por cena. Geração `audio`
pela rota atual de text-to-speech é recusada antes de reservar custos; ela não é
um sintetizador de efeitos sonoros. O renderer usa somente o áudio importado
selecionado, ignora som embutido no vídeo, verifica sua duração antes do encoding
e preenche apenas o silêncio restante com `apad`. Áudio maior que a cena é
recusado para evitar corte (a tolerância técnica existente é de 0,05 s); vídeos
curtos não são repetidos nesse modo. Ajuste o plano/arquivos quando necessário.
Narração vazia e ausência de legendas não provam automaticamente que o áudio
importado ou o vídeo não contêm fala/texto: isso exige atestado e revisão reais.

## Contrato da API de montagem remota

O fluxo JS suportado separa a montagem do registro. A API não faz download,
upload, geração ou encoding durante esse registro e não aceita URL de mídia.

1. Planeje o episódio e registre os assets originais com evidência comercial.
2. Chame `production.exportRenderManifest({ episodeId })`.
3. Transfira ao worker o manifesto e apenas os arquivos originais selecionados.
   Os caminhos do manifesto são relativos ao diretório `assets/` do Studio;
   não são URLs públicas nem contêm tokens. Confira os hashes no worker antes
   de montar a sequência na ordem e duração das cenas.
4. Monte o MP4 no worker e transfira o arquivo final para um arquivo local
   regular acessível ao processo que registra o resultado. “Local” aqui pode
   ser o filesystem do worker; este fluxo não exige encoding no laptop.
5. Chame `production.registerRemoteRender({ episodeId, localPath, manifest,
   provenance })` com o manifesto exportado, sem alterações.
6. Registre a evidência verdadeira e o aceite aplicável ao arquivo exato. O registro
   termina em `rendered`, limpa a aprovação anterior e exige nova aprovação técnica
   vinculada aos hashes antes de publicar. Esse mecanismo não cria aprovação
   estética/humana obrigatória nem autoriza refação das imperfeições aceitas.

Exemplo de integração JS; este documento não executa o código:

```js
const manifest = await production.exportRenderManifest({ episodeId });
// Montagem e transferência do worker são responsabilidade do chamador.
const render = await production.registerRemoteRender({
  episodeId,
  localPath: "/worker/results/original-master.mp4",
  manifest,
  provenance: {
    synthetic: true,
    provider: "original-assembly-worker",
    model: "ffmpeg-assembly-v1",
    prompt: "Montagem original das cenas do manifesto, na ordem e duração planejadas.",
    commercialLicense: {
      url: "https://example.org/assembly-terms",
      notes: "Evidência real dos termos aplicáveis à montagem e aos inputs originais.",
    },
  },
});
```

Os valores de proveniência acima são exemplos; substitua-os pelo worker,
procedimento e evidência reais. `provenance.synthetic=true` atesta que a montagem
usou os inputs originais/licenciados do manifesto. O schema usa os mesmos campos
de proveniência dos imports: `provider`, `model`, `prompt`, `commercialLicense.url`
e `commercialLicense.notes` (ou `evidence`). A licença da ferramenta de montagem
sozinha não dá direitos sobre os inputs: cada asset mantém sua própria evidência.

## Manifesto e verificações

O manifesto v1 contém `schemaVersion`, `episodeId`, `format`, `audioMode`,
`durationSeconds`, `maxRenderBytes`, `width`, `height`, `framesPerSecond`,
`editorialSha256`, `snapshotSha256` e `scenes` ordenadas. Cada cena contém
`sceneId`, `durationSeconds`, `scriptSha256`, `visual` e, nos modos `narrated` e
`nonverbal`, `audio`.
Cada descriptor de asset contém `assetId`, `path`, `kind`, `sha256` e
`provenanceSha256`.

A exportação não muda estado, reserva render ou chama ffprobe. Ela verifica os
bytes das fontes e recusa mudanças do plano/seleção observadas durante a leitura.
O registro recomputa e compara o JSON canônico completo do manifesto; reordenar
chaves de objetos é permitido, mudar valores, campos, fontes ou a ordem das cenas
não é. Alterações de script, metadados editoriais, formato, canvas, seleção ou proveniência
exigem exportar um novo manifesto e montar/revisar o resultado correspondente.

O registro reserva `rendering`, bloqueando um segundo registro e alterações de
assets pelas APIs normais. Ele confere os hashes das fontes, copia o MP4 para um
nome privado dentro de `assets/`, e usa ffprobe independente por meio do runner
injetável existente. Não aceita um laudo enviado pelo worker como substituto desse
probe. Exige o par de dimensões planejado (1080×1920 ou 1920×1080), 30 fps
(tolerância de 0,05 fps), duração planejada
(tolerância de 0,5 s), duração compatível do stream de vídeo e o áudio planejado.
Um master `silent` tem somente um stream de vídeo; `narrated` e `nonverbal` têm
um de vídeo e um de áudio. Em `nonverbal`, o áudio final precisa cobrir a duração
planejada, e nenhum stream de legenda é aceito. Streams adicionais são recusados.
O limite total de duração do formato continua valendo mesmo dentro da tolerância.
SAR explícito deve ser 1:1 e nenhuma rotação explícita é aceita. Canvas explícito
integra o hash editorial; episódios antigos sem esse campo mantêm o hash anterior
e o perfil vertical. Trocar apenas `width`/`height` num manifesto é recusado.

Antes do commit, o registro verifica novamente a identidade do episódio, o hash
editorial/da seleção, os bytes das fontes e da cópia final, e os gates de projeto,
publicação e geração pendente. O render registra SHA-256, tamanho, metadados,
`sceneAssets` e proveniência com `assembly: "remote"`, hash do manifesto/snapshot
e `parents` com IDs, hashes de bytes e hashes da proveniência das fontes.

Para `narrated`, o Studio cria um SRT auxiliar com o texto e os tempos aproximados
das cenas. Isso não prova sincronização de palavras nem presença de legendas
queimadas no MP4; a revisão real precisa verificar o resultado. Nenhum SRT ou
asset de voz é ligado a um render `silent`. `nonverbal` liga os assets de áudio
originais por cena e não cria SRT nem outros campos de captions.

Uma falha depois da reserva remove as cópias parciais, registra a tentativa como
falha e retorna um erro genérico, sem guardar stderr, URLs privadas ou segredos do
processo. Se o próprio store não puder gravar esse desfecho, a tentativa pode
continuar em `rendering`; o operador deve inspecionar e reconciliar a tentativa,
sem apagar locks ou forçar um segundo registro concorrente. O arquivo retornado
original do worker nunca é apagado pelo registro.

## Shorts derivados de um master original

Esta seção descreve especificamente `deriveShort`. Sua exigência de pai renderizado
não se aplica a uma obra independente: planeje um episódio e registre/mapeie fontes
existentes pelas APIs suportadas, com proveniência e exclusões, e monte seu próprio
manifesto. Shorts e regulares independentes não esperam um master de 12 minutos.

`studio.deriveShort({ parentEpisodeId, sceneIds, title, hook, synopsis,
originalAngle, metadata, continuityNote? })`, exposto como
`ytfun_episode_derive_short`, recebe entre 1 e 12 IDs únicos de cenas de um
master `long` válido e renderizado. Os IDs precisam aparecer na ordem original;
a seleção pode ter lacunas e sua duração total deve caber em 180 s. Cada unidade
escolhida deve construir uma história autônoma com contexto, ação e final completo.
O servidor confere estrutura e arquivos; escolhas editoriais e aceite dos resultados
seguem a política única, sem um novo gate estético.

A operação cria IDs de episódio/cenas/assets próprios e copia os registros dos
assets sintéticos mapeados no render do pai. Os bytes originais são referenciados
pelo mesmo caminho imutável, sem cópia física ou nova geração. Proveniência e
licenças permanecem iguais. Cada asset recebe `lineage` com IDs de origem, hash
de origem e hash do render pai. O episódio registra `derivation` com o pai,
hashes do render/revisão/assets, IDs de cenas escolhidas, mappings dos novos
assets e `sourceTimeRanges`. Esses intervalos são cumulativos da timeline
planejada (`timebase: "planned-scene-boundaries"`), não um laudo de frames exatos
do MP4. O short é montado a partir dos assets remapeados; não recorta o master.

O novo episódio fica `planned`, sem render/aprovação/métricas; conserva projeto,
modo de áudio e fontes factuais, com metadados próprios. Um short derivado de
master horizontal volta ao padrão portrait e usa os assets originais remapeados.
Não reaproveita sinais de tendência como se fossem atuais. Fonte não renderizada, bytes/licenças
inválidos, cenas inexistentes/reordenadas ou desfechos de geração pendentes
impedem a operação. A mesma seleção do mesmo pai não pode ser derivada novamente,
inclusive em chamadas concorrentes. Títulos quase iguais continuam bloqueados;
a exceção de reutilização narrativa vale somente para o par pai–filho com
lineage verificado. Irmãos e outros episódios mantêm as verificações globais.

Renderize e revise cada short separadamente usando as mesmas APIs de manifesto,
montagem e aprovação. Scripts, proveniência e mappings precisam continuar
iguais à origem registrada. Mudanças no pai invalidam o snapshot da derivação;
a revisão e o plano/reserva de entrega revalidam origem e bytes antes de seguir.
Uma aprovação anterior do filho não ignora essa invalidação. Publicação e
cadência de canal continuam separadas para cada entrega.

## Limites da evidência e publicação

Hashes vinculam o registro ao plano e aos inputs exatos; não provam que o worker
realmente montou o vídeo a partir deles, que a ação é coerente ou que alguém
assistiu ao resultado. A proveniência é um atestado do operador/worker. Revisão
do operador, originalidade, fatos, licenças e aprovação vinculada aos hashes são
registros separados. A revisão não requer validação humana nem perfeição estética;
preserve o aceite da política única e não declare exame que não ocorreu.
As verificações globais de duplicidade e fontes do domínio continuam aplicadas.

O cap de produção de 512 MiB não amplia automaticamente o cap de upload do
YouTube (250 MiB neste adapter) nem o perfil Facebook Reels (4–60 s). Cada master
e cada short derivado precisa passar seus próprios contratos e revisão; um
manifesto ou arquivo exportado não representa publicação confirmada.

As regressões de produção usam apenas arquivos sintéticos, fake runner e store
temporário no GitHub Actions, incluindo caps, duração longa, proveniência,
mutação de script/assets, validação de streams, sanitização e concorrência.
Nenhum teste ou render de validação deve executar no laptop.

O worker legado `ai-meow-render` do packet v1 continua específico para 96 cenas de
7,5 segundos/720 segundos. Ele aceita os dois canvases do manifesto, usando o
mesmo canvas em todos os seus outputs; nomes de unidades curtas nesse artifact
não classificam vídeos horizontais como YouTube Shorts. Seu contrato não monta
automaticamente um regular de nove cenas/67,5 segundos. Essa seleção menor usa
o fluxo de montagem externa acima com o manifesto próprio; não preencher com
cenas repetidas para satisfazer o packet legado. Este limite pertence somente
àquele packet; use uma rota compatível com a seleção, sem financiar cenas extras.
