# Retenção e desconexão do YouTube

Contrato para um MCP pessoal com uma conta. Não é um serviço de múltiplos usuários
nem uma confirmação de aprovação da auditoria do YouTube.

## Dados e prazo

Tendências do YouTube, métricas e recibos de API têm `apiData.provider`,
`authorized`, `grantId`, `fetchedAt` e `expiresAt`. A expiração é de 30 dias. Editar estado
local não renova a data de consulta. Dados antigos sem proveniência usam a data
da observação/última verificação; datas ausentes ou inválidas expiram de forma
conservadora. Observações manuais de desempenho do YouTube seguem a mesma
retenção, inclusive quando o arquivo/export não veio diretamente desta API.

Antes de responder a qualquer tool/resource, o MCP expurga os snapshots
vencidos em uma transação. Um janitor a cada minuto funciona mesmo com
`YTFUN_DELIVERY_WORKER_ENABLED=false`. Ele verifica a autorização diariamente:
renova o grant, quando houver refresh token, e consulta `channels?mine=true`.
`invalid_grant` ou HTTP 401 em requisição autorizada bloqueiam acesso. A limpeza
automática valida o grant atual e retém o lock do ambiente antes de remover dados
autorizados daquela geração. Se o arquivo já contém um grant novo, retorna
parcial, preserva o novo ambiente e registra apenas a barreira da geração antiga.
Expiração também pode causar esses sinais, portanto eles não provam revogação
externa. O janitor bloqueado limita a limpeza antecipada à geração invalidada;
a retenção de snapshots vencidos continua global em todas as gerações.

Barreiras persistem em `youtubeConnections`, por `grantId`; mudar de geração não
apaga barreiras antigas. Uma resposta atrasada de A não pode substituir recibos
de B. Dados antigos sem geração são tratados como `legacy` para retenção;
não são reassociados automaticamente a uma concessão nova.

O expurgo remove os metadados, estatísticas, IDs de conta/vídeo e URLs da
plataforma. Mantém apenas identificadores, hashes e decisões locais necessários
para impedir uma segunda tentativa do mesmo episódio. Recibos expurgados viram
`localOnly`, com estado `unknown` e motivo `youtube_api_data_removed`. Nenhum
recibo é resetado para retry. Uma resposta de upload que chegue após o expurgo
não pode recriar os dados removidos. Referências a tendências removidas saem do
episódio e podem invalidar a revisão, exigindo nova revisão real.

## Preview e execução explícita

`ytfun_youtube_data_maintenance` usa `execute=false` por padrão e mostra os
snapshots vencidos; `execute=true` expurga apenas esses dados. A manutenção
automática já pode tê-los removido antes do preview.

`ytfun_youtube_disconnect` também usa preview por padrão. Para executar, informe
`execute=true` e `expectedChannelId` com o canal pessoal configurado. Configure
`YTFUN_PRIVATE_ENV_FILE` no host MCP com o caminho absoluto do mesmo arquivo
passado ao Node com `--env-file`. O servidor não infere esse caminho e não carrega
um `.env` automaticamente. O arquivo deve estar fora de Git, ser regular, sem
links, pertencer ao usuário e ter modo 0600; limite de 64 KiB. Um arquivo inseguro
ou outro grant/canal interrompe a execução antes da revogação.

OAuth no MCP exige `YTFUN_YOUTUBE_GRANT_ID`, um identificador local único por
consentimento, sem reutilização. O setup grava um UUID novo. Para migrar um grant
pré-existente, pare todos os processos MCP e atribua seu UUID inicial no ambiente
antes de iniciar esta versão. Isso não solicita novo consentimento nem registra
fingerprints de credenciais. Não substitua tokens manualmente mantendo o ID antigo.

A execução bloqueia novas operações, aborta requisições Google em andamento,
invalida a cache de tokens compartilhada por publicação e pesquisa, grava uma
barreira persistente e remove os dados do YouTube. Entregas não iniciadas são
canceladas; tentativas iniciadas preservam somente o bloqueio local. Depois faz
um único POST ao endpoint oficial de revogação, sem redirect ou retry.

Quando o arquivo atual foi validado e bloqueado, o pedido explícito limpa os dados
do YouTube de todas as gerações deste store pessoal. Se ele chega durante/depois
da limpeza automática, aguarda essa operação e limpa completamente a geração
invalidada, inclusive sua cache pública. Essa continuação não declara revogação
completa quando o grant já foi removido: retorna `complete=false`, o estado real
de revogação e ação manual. Dados de uma nova geração permanecem protegidos.

**A revogação do Google remove todos os escopos concedidos ao projeto, inclusive
os concedidos por outros clientes OAuth desse projeto.** HTTP 200 confirma o
pedido; erro/timeout retorna resultado parcial, com orientação para remover o
acesso em [conexões da Conta Google](https://myaccount.google.com/connections).
Uma tentativa ambígua persistida nunca é repetida automaticamente.

A limpeza do arquivo retém o mesmo lock `.oauth.lock` do setup desde a validação
até o fim da revogação e do rename, impedindo setup concorrente. Verifica conteúdo
e inode antes do rename atômico e preserva os demais valores. Remove tokens de
usuário, expirações, canal e geração local do grant; desliga os dois gates
públicos. Credenciais do cliente/API key e credenciais de outras redes ficam
no arquivo. Falha de lock/arquivo/armazenamento não é declarada como sucesso;
o retorno separa revogação, limpeza de ambiente e limpeza de dados.

Consentimento novo pelo setup OAuth escreve um novo `YTFUN_YOUTUBE_GRANT_ID`.
Reinicie o MCP para usar esse grant. Apenas reiniciar o processo ou editar flags
não remove a barreira do grant antigo nem os bloqueios locais de uploads.

## Limites operacionais

O janitor precisa do processo e da máquina ativos. Este código não instala um
serviço do sistema nem remove backups, cópias de `state.json`, transcrições,
logs/snapshots do host de IA ou dados em conversas. O operador precisa manter um
runtime ativo e apagar essas cópias separadamente para cumprir os prazos. Uma
máquina desligada por semanas não oferece garantia de limpeza em prazo; na volta,
o MCP expurga dados antes de expô-los. Não alegar conformidade integral com base
somente neste código. Falhas de acesso/armazenamento exigem ação operacional.

Desconectar e remover dados locais não apaga vídeos no YouTube. A exclusão dos
vídeos deve ser feita pelo criador no YouTube. Arquivos originais de imagem, voz,
render, roteiro e séries não são eliminados por este mecanismo.

## Fontes oficiais

Verificadas em 2026-10-01:

- [YouTube Developer Policies, III.D.2 e III.E.4](https://developers.google.com/youtube/terms/developer-policies): exclusão/atualização de API Data em 30 dias, remoção de dados solicitada pelo usuário em até 7 dias e remoção após revogação externa em até 30 dias.
- [Google OAuth, Token revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke): endpoint, resposta HTTP 200 e efeito sobre todos os escopos do projeto.

Testes de expiração, barreiras, concorrência e falhas pertencem ao GitHub Actions.
Nenhum teste local é permitido nesta máquina.
