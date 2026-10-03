# Composição de fragmentos prontos

`FragmentComposition.plan` / `ytfun_episode_compose` é a rota direta para combinar
fontes audiovisuais existentes, sem gerar um master longo primeiro. Aceita episódios
curtos ou longos com render `nonverbal` e áudio, e cria destino `short` ou `long`.
Canvas e duração são escolhas técnicas independentes da classificação da plataforma.

```js
import { FragmentComposition } from '../src/fragment-composition.mjs';
const composition = new FragmentComposition(store, { env });
const { episode, reused } = await composition.plan({
  projectId,
  sources: [
    { episodeId: fragmentA.id, expectedRenderSha256: fragmentA.render.sha256,
      sceneIds: fragmentA.scenes.map(scene => scene.id) },
    { episodeId: fragmentB.id, expectedRenderSha256: fragmentB.render.sha256,
      sceneIds: fragmentB.scenes.map(scene => scene.id) },
  ],
  format: 'long', renderCanvas: 'landscape',
  title: 'Two complete impossible reveals',
  hook: 'Two familiar objects reveal impossible worlds.',
  synopsis: 'A coherent sequence of independent complete reveals.',
  originalAngle: 'Contrast the two interiors in one audiovisual sequence.',
  metadata: { description: 'Original AI animation.', hashtags: ['#AIArt'] },
});
```

Esta primeira API seleciona cenas completas na ordem declarada. Não faz cortes
parciais nem download, geração, encoding, aprovação ou publicação. Para recortes
mais finos, usar os intervalos explícitos da rota selected-assembly v2; não fingir
que um plano inteiro representa um recorte de segundos diferentes.

O planejamento é atômico: valida render, fontes, direitos, áudio e hashes, copia
somente registros com linhagem exata e preserva bytes, reviews históricos e custos.
Uma seleção repetida não cria outro episódio apenas por título: uma composição
idêntica no mesmo projeto/formato/canvas retorna `reused:true`. Seleção integral
de uma fonte já compatível pode reutilizar o próprio episódio sem nova montagem.
Mesma cena/visual repetido dentro da montagem não fabrica duração.

Para uma composição nova, exportar o manifesto com `Production.exportRenderManifest`,
montar remotamente e registrar com `Production.registerRemoteRender`. O manifesto
congela seleção/linhagem e as fontes são revalidadas antes do registro e da publicação.
[Áudio e montagem](audio-and-assembly.md) descreve os packets remotos. O retorno
`planned` não é um vídeo montado e `reused` não significa publicação numa rede.

Adaptar texto pelo snapshot de publicação, sem alterar a fonte compartilhada:
`publicationMetadata={title,description,hashtags,tags}` e seu hash normalizado pelo
`ytfun_publication_metadata_prepare`. Cada rede mantém sua utilização, conta e recibo.
O Publisher impede reenvio dos mesmos bytes e, quando a linhagem permite provar
os intervalos usados, da mesma composição na mesma conta. Sobreposição de arquivos
brutos sem intervalos não prova duplicidade. Reuso entre redes continua permitido.
Conferir exclusões humanas e uso editorial da seleção.
Testes desta API rodam somente no GitHub Actions.

Esta API permanece experimental na PR6. A revisão encontrou perda de intervalos
em fontes previamente montadas por selected-assembly v2: copiar seus assets brutos
pode remontar outro trecho. Não ativar esta implementação antes de preservar os
recortes até o worker ou restringir a rota a fontes de reconstrução comprovada.
O reuso integral que devolve o próprio render não tem essa remontagem. Acervo e
intervalos originais devem ser preservados, sem nova geração corretiva.
