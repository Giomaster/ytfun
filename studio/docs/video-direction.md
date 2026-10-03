# Direção de vídeo antes da geração

Esta ficha é um guia prospectivo para preparar prompts antes da geração, subordinado
à [política editorial e operacional única](ai-meow-operation.md). Não é uma etapa
automática do servidor nem uma garantia de obediência do modelo. As intenções de
direção abaixo não criam critérios para descartar, corrigir, regenerar ou impedir
a publicação de resultados por imperfeições da IA. Prepare os campos pertinentes e
transforme-os em um prompt adequado à modalidade e aos controles disponíveis.

## Princípio geral: premissa absurda, execução convincente

As regras valem para humor, fantasia, ficção científica, surrealismo, cenas
satisfatórias e outros formatos de entretenimento. Cada obra define seu universo,
tom e linguagem visual/sonora. Uma premissa impossível pode ser o motor da história;
o contato, esforço, peso, ritmo, materiais, luz e reações ao redor dela precisam
convencer e manter as regras estabelecidas.

Por padrão, respeitar gravidade, inércia, atrito, apoio e respostas dos materiais.
Uma direção criativa explícita pode estabelecer uma exceção para determinada obra,
cena ou comportamento. Registrar o alcance dessa exceção e aplicá-la de maneira
consistente; não transformar uma licença para o absurdo em incoerência acidental.

Planejar prazer visual e sonoro: composição legível, antecipação, ritmo e recompensa,
texturas, iluminação e efeitos adequados ao acontecimento. O som original não verbal
pode tornar visíveis o peso, contato, energia e espaço por meio da sincronização,
textura e dinâmica. Não adicionar faíscas a todo corte, ruído a todo movimento ou
efeitos sem função; escolher de acordo com o material, gênero e intenção. O idioma
global do AI Meow permanece visual, com áudio original não verbal incorporado
pela MESTRE. O perfil `silent` é uma opção técnica legada e não finaliza a nova
entrega compartilhada; usar `nonverbal` para preservar a base sonora.

## Em todo vídeo: componentes relevantes muito detalhados, fundo estável

Cada prompt de geração deve detalhar muito os componentes relevantes para a ação,
a leitura visual e o desfecho; não deixar essa direção apenas na ficha. Para cada
personagem, objeto ou ferramenta relevante, definir identidade/aparência, forma e
escala, material, posição/orientação, estado inicial/final, contatos, trajetória,
evolução do movimento e respostas pertinentes. Explicitar o que permanece constante
entre frames e planos. Não inventar propriedades ou interações sem função na cena.

Concentrar a profundidade nesses componentes e manter poucos elementos com ações
independentes por plano. Outros componentes podem compor uma paisagem ou fundo,
com aparência e disposição estáveis e comportamento simples de manter entre frames.
O fundo pode ser visualmente bonito e rico, sem exigir coreografia própria,
figurantes em movimento ou interações incidentais. Se um elemento do fundo passa
a ser puxado, cortado, transformado ou usado pelo personagem, ele se torna relevante
e precisa de direção; reduzir a complexidade ou dividir o plano quando necessário.

Traduzir os detalhes relevantes em ações observáveis na estrutura aceita pelo
modelo. Profundidade não é enumerar toda decoração nem acumular ações simultâneas;
o roteiro completo continua separado do prompt. Observações dos resultados podem
melhorar o planejamento de conteúdos novos, sem refazer o conteúdo já gerado.

## Revelações: o interior precisa superar o exterior

Quando houver revelação interna, o exterior constrói a curiosidade e o interior
entrega o maior impacto visual. Definir o conteúdo revelado, como a abertura o
expõe e como contraste, luminosidade, profundidade, textura e movimento tornam
o desfecho mais impressionante. Não basta pedir um interior "UAU": o prompt
precisa descrever características visíveis e reservar tempo para apreciá-las.
Manter poucos componentes relevantes e um fundo estável.

O impacto respeita a execução: cascas e fragmentos conservam peso e apoio;
líquidos viscosos escorrem para baixo, dobram e se acumulam, sem levantar a casca
nem virar fios de chiclete. Estiramento elástico pertence a materiais elásticos
ou a uma exceção criativa explícita. Planejar tanto a superioridade visual do interior
quanto a continuidade e resposta dos materiais antes da geração.

## Preparação do prompt

Quando o usuário pedir geração sem novas imagens, ajustar o prompt e gerar o vídeo
diretamente pela rota compatível; uma rota image-to-video pode reutilizar a referência
existente. Não inserir geração de imagens ou novos storyboards nessa rodada.
Concentrar a direção no corte/ação, material, revelação e fim. Esse planejamento
vale para um novo conteúdo; não autoriza outra tentativa para corrigir um resultado.

## Ficha por plano

Usar somente os campos pertinentes ao plano. Não preencher campos sem função nem
produzir uma ficha separada por obrigação; a direção pode estar no próprio roteiro.

| Decisão | O que definir |
| --- | --- |
| Obra e exceções | Gênero, tom, linguagem visual/sonora, regras do universo e alcance de cada impossibilidade deliberada. |
| Função narrativa | O que o espectador precisa perceber e qual é a ação principal. |
| Impacto da revelação | Quando houver interior, o que o torna mais impressionante que o exterior e como o payoff permanece legível no fim. |
| Componentes relevantes e fundo | Quais elementos conduzem a ação/desfecho e exigem detalhe profundo no prompt; quais compõem apenas cenário estável e simples de manter entre frames. |
| Estado inicial e final | Objetos presentes, posições, orientações e transformação esperada. |
| Câmera e composição | Posição, perspectiva, enquadramento, foco e movimento deliberado ou câmera fixa. |
| Geometria | Posição/orientação, contatos e eixos de movimento; plano de corte e trajetória das partes quando aplicável. |
| Materiais | Rigidez, resistência, deformação, atrito e resposta na interação ou ruptura, quando aplicável. |
| Forças e movimento | Causa, direção, evolução da força, aceleração/desaceleração, apoio e peso visual. |
| Encenação | Ordem dos acontecimentos, ações simultâneas dependentes, duração suficiente e momento de repouso. |
| Personagem | Olhar, antecipação, emoção, esforço, contatos do personagem e reação ao acontecimento, quando aplicável. |
| Luz e efeitos | Origem, gatilho, cor, intensidade, direção e influência sobre a cena. |
| Som | Áudio-base original não verbal, incorporado pela MESTRE; contatos, ação e consequência orientam os efeitos. Modelo sem áudio precisa de pista separada na montagem. |
| Continuidade | Identidade, escala, câmera, iluminação e estado dos objetos entre planos; fim completo do short. |
| Intenções observáveis | Resultados desejados para orientar o prompt e aprender com conteúdos novos, sem gate estético após a geração. |
| Modelo e custo | Controles realmente disponíveis, limites de complexidade, referências e custo estimado da tentativa. |

Não basta escrever “cortar naturalmente” ou “respeitar a física”. Descrever o contato
e a resposta que tornam o acontecimento visível. Não é necessário colocar cada
linha da ficha no prompt: selecionar os detalhes pertinentes ao plano, em ordem
clara, sem instruções conflitantes ou adjetivos que substituam o movimento.

## Exemplo proposto: esfera e buraco negro do AI Meow

Exemplo histórico de direção para uma esfera e um buraco negro. Não descreve um
vídeo concluído nem estabelece obrigação de produzir/refazer essa obra. Aproveite
apenas os conceitos úteis ao planejamento de conteúdos novos.

**Material e contato.** A esfera tem uma casca preta resistente com veios violetas.
O fio comprido da mesma faca encosta primeiro; a ponta permanece voltada para o lado.
A descida desacelera ao encontrar resistência. A superfície cede progressivamente
sob a pressão, com uma fissura seguindo o plano de corte. A ferramenta mantém
identidade, tamanho e orientação; não vira uma prensa ou outra máquina.

**Ruptura, luz e faíscas.** A fissura emite luz violeta, que ilumina a lâmina, a mesa
e o rosto do gato de acordo com a distância. Pequenas faíscas estilizadas da energia
interna surgem nos pontos pressionados e se apagam rapidamente; não são uma explosão
sem causa nem uma afirmação sobre o corte real de qualquer pedra. A casca se separa
em duas partes sólidas por uma trajetória compatível com a orientação da lâmina.

**Formação e sucção.** Conforme a abertura cresce, aparece um centro realmente
negro com anel violeta. A atração começa durante essa formação, aumenta gradualmente
e aponta para o mesmo centro. As partículas antes liberadas curvam suas trajetórias
para dentro; pelos e pontas soltas do tecido respondem antes dos móveis pesados.
Os móveis vencem o atrito e passam de um pequeno deslocamento a um arrasto crescente.
O buraco negro segue uma regra estilizada consistente do universo, sem exigir uma
simulação científica literal.

**Atuação e consequência.** A curiosidade do gato vira surpresa e esforço. Ele se
agarra ao próprio sofá com as duas patas dianteiras; tecido, postura, pelo e cauda
mostram a direção da tração. O sofá desliza levando o gato consigo. Mesa, luminária,
plantas e demais móveis entram no mesmo horizonte por ocultação progressiva, mantendo
silhuetas reconhecíveis; não explodem, encolhem magicamente nem somem por uma fusão.

**Divisão em planos.** Definir primeiro a abertura progressiva e o início da atração;
depois o esforço do gato e o arrasto dos móveis; por fim a entrada completa e a sala
vazia com tempo para o desfecho. Ações dependentes podem se sobrepor. Se o corte e a
retirada da faca não couberem com clareza no primeiro plano, dar mais tempo ou separar
a retirada com continuidade, sem forçar a transformação completa em cinco segundos.

## Planejar e registrar o próximo conteúdo

1. Conferir referências e geometria. Os quadros devem ser estados alcançáveis pela
   ação prevista, com câmera, escala, identidade e orientação consistentes.
2. Conferir a rota e os controles suportados, além da ordem/identidade dos arquivos
   encaminhados. Registrar hashes, referências, prompt, parâmetros e estimativa.
3. Gerar uma vez os fragmentos planejados dentro da autorização e das reservas de
   custo. O primeiro fragmento de um conceito também pertence ao acervo, sem piloto
   descartável ou obrigação de financiar uma versão corretiva.
4. Preservar o resultado como entregue e registrar apenas o exame efetivamente
   realizado. Se houver observações, separar fatos de hipóteses e aproveitá-las nos
   prompts de conteúdos futuros; fluidez não comprova causalidade.
5. Conferir os requisitos técnicos necessários para montar/transportar/publicar,
   proveniência, conta, hashes e resultado real. Aplicar o aceite de imperfeições
   da política única, sem esperar validação estética ou humana. Uma chamada sem
   arquivo ou com cobrança incerta exige recuperação/reconciliação, nunca retry cego.

Todas as mídias de produção do AI Meow ficam na pasta `AI Meow` da Mesa. Revisão de
mídia de produção não substitui testes de software: testes só no GitHub Actions.
