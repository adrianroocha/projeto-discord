# Projeto Discord Bot

Bot para Discord focado em gerenciamento de fila de jogadores, formação de lobbies, painel de status e scheduler automático de abertura e fechamento.

O projeto usa `discord.js` v14, `SQLite`, `dotenv` e `Jest`.

## O que o bot faz hoje

- Controla uma fila com prioridade para subscribers.
- Respeita cooldown de saída da fila.
- Forma lobbies automaticamente com base na ordem da fila.
- Permite criar ou iniciar lobbies manualmente via comandos administrativos.
- Mantém um painel no Discord com o estado atual da fila e dos lobbies.
- Faz reset completo do ciclo quando a fila abre novamente.
- Executa scheduler em desenvolvimento com ciclo imediato de abertura, 5 minutos aberto e 5 minutos fechado, repetindo indefinidamente.
- Está preparado para futura integração com Kick sem acoplar essa lógica ao fluxo principal da fila.

## Estrutura principal

- `src/index.js` - bootstrap do bot, registro de comandos, painel e scheduler.
- `src/config/` - leitura das variáveis de ambiente.
- `src/database/` - conexão SQLite e criação do esquema.
- `src/commands/` - comandos slash do Discord.
- `src/buttons/` - handlers dos botões do painel.
- `src/services/` - regras centrais da fila, painel, scheduler e eventos.
- `src/events/` - eventos do Discord.
- `src/handlers/` - carregamento e registro de comandos e eventos.
- `tests/` - suíte automatizada.
- `data/` - banco SQLite local.

## Requisitos

- Node.js 18 ou superior.
- `npm`.
- Um bot criado no Discord Developer Portal.
- Um servidor Discord para testar os comandos e o painel.

## Instalação

1. Instale as dependências:

```bash
npm install
```

2. Crie o arquivo `.env` a partir do modelo:

```bash
copy .env.example .env
```

No PowerShell, você também pode usar:

```powershell
Copy-Item .env.example .env
```

3. Preencha o `.env` com os dados do seu bot e do seu servidor.

## Configuração de ambiente

O arquivo [.env.example](.env.example) contém apenas valores seguros e serve como base para o `.env` local.

Variáveis usadas hoje:

```env
# Discord
DISCORD_TOKEN=
CLIENT_ID=
GUILD_ID=

# Channels
QUEUE_PANEL_CHANNEL_ID=
QUEUE_CHANNEL_ID=
KICK_LINK_CHANNEL_ID=
ADMIN_AUDIT_CHANNEL_ID=
ADMIN_AUDIT_RETENTION_DAYS=30

# Roles
SUBSCRIBER_ROLE_ID=
BOT_OPERATOR_ROLE_IDS=

# Database
DATABASE_PATH=./data/database.sqlite

# Environment
NODE_ENV=development
SHUTDOWN_TIMEOUT_MS=10000

# Production Scheduler
QUEUE_OPEN_TIME=19:00
QUEUE_CLOSE_TIME=08:00
QUEUE_TIMEZONE=America/Sao_Paulo

# Development Scheduler
QUEUE_TEST_INTERVAL_MINUTES=5

# SQLite Backup
SQLITE_BACKUP_ENABLED=true
SQLITE_BACKUP_DIRECTORY=./backups
SQLITE_BACKUP_TIME=08:15
SQLITE_BACKUP_TIMEZONE=America/Sao_Paulo
SQLITE_BACKUP_RETENTION_DAYS=7
SQLITE_BACKUP_STARTUP_DELAY_SECONDS=60

# Kick HTTP Hardening
KICK_HTTP_MAX_BODY_BYTES=1048576
KICK_HTTP_BODY_TIMEOUT_MS=10000
KICK_HTTP_MAX_URL_LENGTH=8192
```

### Observações importantes

- `DISCORD_TOKEN` e outras credenciais nunca devem ser versionadas.
- `BOT_OPERATOR_ROLE_IDS` é opcional e aceita IDs de cargos operacionais separados por vírgula; espaços são removidos, itens vazios são ignorados e cada item deve ser um snowflake válido.
- `NODE_ENV=development` ativa o comportamento de desenvolvimento do scheduler.
- `DATABASE_PATH` aponta para o banco SQLite local por padrão.
- `QUEUE_TEST_INTERVAL_MINUTES` controla o intervalo de ciclo em desenvolvimento.
- `SHUTDOWN_TIMEOUT_MS` define o timeout de segurança do shutdown gracioso (padrão 10s).
- Em produção, `QUEUE_OPEN_TIME` e `QUEUE_CLOSE_TIME` são interpretados no `QUEUE_TIMEZONE` IANA configurado (não no timezone local do host).
- Backups SQLite usam API de backup consistente do próprio SQLite (via `better-sqlite3`) e não fazem cópia insegura de arquivo aberto.
- O scheduler de backup diário roda em timezone IANA real (`SQLITE_BACKUP_TIMEZONE`), independente do timezone local do host.
- O backup padrão executa às 08:15 em `America/Sao_Paulo`, após o fechamento padrão da fila às 08:00.
- A retenção padrão remove backups antigos após 7 dias e preserva apenas arquivos do padrão do projeto.
- Limites HTTP da Kick (`KICK_HTTP_MAX_BODY_BYTES`, `KICK_HTTP_BODY_TIMEOUT_MS`, `KICK_HTTP_MAX_URL_LENGTH`) são opcionais e usam fallback seguro para os padrões quando ausentes, inválidos ou fora dos limites aceitos.

## Railway

Este projeto está preparado para primeiro deploy de homologação no Railway com SQLite em volume persistente e apenas uma instância do bot.

### Variáveis obrigatórias (homologação)

```env
NODE_ENV=production
DISCORD_TOKEN=
GUILD_ID=
SUBSCRIBER_ROLE_ID=
QUEUE_PANEL_CHANNEL_ID=
QUEUE_CHANNEL_ID=
KICK_LINK_CHANNEL_ID=
KICK_CLIENT_ID=
KICK_CLIENT_SECRET=
KICK_BROADCASTER_USER_ID=
KICK_REDIRECT_URI=
KICK_HOST=0.0.0.0
DATABASE_PATH=/data/database.sqlite
SQLITE_BACKUP_DIRECTORY=/data/backups
QUEUE_OPEN_TIME=19:00
QUEUE_CLOSE_TIME=08:00
QUEUE_TIMEZONE=America/Sao_Paulo
```

### Variáveis adicionais já existentes (recomendadas)

```env
# Shutdown gracioso
SHUTDOWN_TIMEOUT_MS=10000

# Reconciliação SUB
SUB_ROLE_RECONCILIATION_ENABLED=true
SUB_ROLE_RECONCILIATION_INTERVAL_MINUTES=15
SUB_ROLE_RECONCILIATION_STARTUP_DELAY_SECONDS=30
SUB_ROLE_RECONCILIATION_DISCOVERY_TIMEOUT_MS=20000
SUB_ROLE_RECONCILIATION_USER_SYNC_TIMEOUT_MS=12000

# Autorização operacional opcional por cargo
BOT_OPERATOR_ROLE_IDS=

# Backup SQLite
SQLITE_BACKUP_ENABLED=true
SQLITE_BACKUP_TIME=08:15
SQLITE_BACKUP_TIMEZONE=America/Sao_Paulo
SQLITE_BACKUP_RETENTION_DAYS=7
SQLITE_BACKUP_STARTUP_DELAY_SECONDS=60

# HTTP Kick hardening
KICK_HTTP_MAX_BODY_BYTES=1048576
KICK_HTTP_BODY_TIMEOUT_MS=10000
KICK_HTTP_MAX_URL_LENGTH=8192

# Porta da aplicação (fallback local)
KICK_PORT=3000

# Canal opcional de resumo de auditoria administrativa
ADMIN_AUDIT_CHANNEL_ID=

# Retenção automática da auditoria administrativa (1..3650)
ADMIN_AUDIT_RETENTION_DAYS=30
```

### Regras operacionais no Railway

- `PORT` é fornecida automaticamente pelo Railway e não deve ser fixada manualmente.
- O host deve ser configurado explicitamente com `KICK_HOST=0.0.0.0` no Railway.
- O domínio público inicial será o domínio gerado `*.up.railway.app`.
- Após obter o domínio, configure:
- `KICK_REDIRECT_URI=https://DOMINIO/kick/callback`
- webhook Kick em `https://DOMINIO/kick/webhooks`
- O volume persistente deve ser montado exatamente em `/data`.
- Em restart do Railway no mesmo deployment, o lock operacional no volume é recuperado com segurança para evitar loop de reinicialização.
- A configuração de réplica única deve ser conferida manualmente no painel do Railway (Scaling).
- O próprio uso de volume persistente impede operação segura com múltiplas réplicas para este serviço SQLite.
- Deployments com volume persistente podem causar pequena indisponibilidade durante troca de versão.
- Não há promessa de zero downtime neste modo de deploy.
- `drainingSeconds=30` no [railway.json](railway.json) dá janela maior que `SHUTDOWN_TIMEOUT_MS=10000`, ajudando o shutdown gracioso a concluir antes de SIGKILL.
- Backups no mesmo volume ajudam em erro lógico/restore, mas não protegem contra perda do próprio volume.
- Depois da homologação, configure backup externo ou backup nativo do volume.

### Sobre railway.json

O arquivo [railway.json](railway.json) já define:

- `startCommand: npm start`
- healthcheck em `/health`
- política de restart contínuo (`ALWAYS`)
- `drainingSeconds: 30`

Replicas não são definidas neste `railway.json`. Ajuste manualmente em Service > Settings > Scaling para manter exatamente 1 réplica.

## Comandos disponíveis

Documentação detalhada e mandatória de comandos slash e botões: [DISCORD_COMMANDS.md](DISCORD_COMMANDS.md).

### Comandos administrativos

- `/scheduler-open` - abre a fila manualmente e reinicia o ciclo atual.
- `/scheduler-close` - fecha a fila manualmente sem limpar os dados do ciclo atual.
- `/scheduler-status` - mostra o estado atual do scheduler.
- `/lobby-start` - inicia uma lobby pelo número informado obrigatoriamente.
- `/lobby-form-force` - força a criação de uma lobby com jogadores suficientes.
- `/lobby-swap` - troca administrativamente um jogador em lobby em formação por um jogador da fila mantendo posição operacional.
- `/lobby-remove` - remove administrativamente um jogador ausente de uma lobby em formação sem retorná-lo para a fila.
- `/kick-events-sync` - sincroniza os event subscriptions oficiais da Kick para o webhook da aplicação e aceita `force:true` para uma ressincronização manual.
- `/kick-webhook-status` - mostra auditoria resumida do último webhook válido recebido pela integração Kick.

### Autorização operacional centralizada

- A regra operacional consulta o membro real no servidor antes de permitir a ação.
- Um comando operacional é permitido quando o ator tiver `Administrator`, `ManageGuild` ou algum cargo listado em `BOT_OPERATOR_ROLE_IDS`.
- Se `BOT_OPERATOR_ROLE_IDS` estiver ausente ou vazio, o comportamento permanece limitado a `Administrator` e `ManageGuild`.
- A lista de IDs nunca é exposta em respostas ou logs do bot.

### Auditoria administrativa de fila e lobbies

- Fonte oficial: SQLite (`admin_command_audit_logs`).
- Escopo atual auditado: `/scheduler-open`, `/scheduler-close`, `/lobby-form-force`, `/lobby-start`, `/lobby-swap`, `/lobby-remove` e consultas administrativas de `/kick-status usuario:@Membro` para terceiros.
- Consultas próprias continuam fora da auditoria administrativa.
- Comandos administrativos de consulta ainda fora desta etapa: `/scheduler-status`, `/fila-status`, `/lobby-status`.
- Para cada tentativa, o bot registra início (`pending`) e finaliza como `success`, `failed` ou `denied`.
- Campos persistidos são apenas metadados seguros: `interaction_id`, `guild_id`, `channel_id`, ator, comando, parâmetros saneados, `queue_cycle_id`, estados operacionais seguros, código seguro e timestamps.
- Dados proibidos no log: token, secret, payload completo do Discord, OAuth/Kick sensível, stack trace e mensagens internas de exceção.
- Se a criação do registro obrigatório no SQLite falhar antes da mutação, a ação administrativa mutável é recusada.
- Na consulta administrativa de `/kick-status`, o log persiste apenas ator, alvo por Discord ID, comando, resultado seguro e timestamps.
- Se a ação principal concluir e a finalização da auditoria falhar, a ação não é revertida; o bot gera apenas warning seguro.
- Idempotência por `interaction_id`: a mesma interação não gera duas execuções auditadas.

#### Canal privado opcional de resumo

- Variável: `ADMIN_AUDIT_CHANNEL_ID`.
- Quando ausente, a auditoria em SQLite continua ativa e o bot inicia normalmente.
- Quando presente, o bot valida que o canal pertence ao `GUILD_ID` e publica um resumo curto com `allowedMentions.parse = []`.
- Falha de envio no Discord não reverte ação concluída e não cria loop de retry.

#### Retenção automática da auditoria administrativa

- Variável: `ADMIN_AUDIT_RETENTION_DAYS` (padrão `30`, faixa `1..3650`, inteiro seguro).
- Configuração inválida interrompe startup com erro seguro de configuração.
- A limpeza remove apenas metadados antigos da tabela `admin_command_audit_logs`.
- Regra de cutoff: remove apenas registros com `started_at_ms < (agora - retentionDays)`.
- Na fronteira exata (`started_at_ms === cutoff`), o registro é preservado.
- Registros antigos `pending`, `success`, `failed` e `denied` são elegíveis para remoção.
- A limpeza roda no startup do processo e depois no máximo uma vez a cada 24h com `setTimeout` encadeado.
- A rotina não executa `VACUUM`; após `DELETE`, o SQLite pode reutilizar internamente o espaço liberado.
- Backups SQLite podem manter cópias antigas por um período adicional conforme a retenção dos backups.

### Comandos de suporte e diagnóstico

- `/ping` - checagem básica de latência.
- `/status` - visão geral do bot.
- `/queue` - exibe informações da fila.
- `/queue-status` - mostra o estado detalhado da fila.
- `/lobby-status` - mostra o estado dos lobbies.
- `/fila-add-teste` - adiciona jogador de teste à fila (somente em desenvolvimento).
- `/dev-fill-queue` - preenche a fila com jogadores fictícios em desenvolvimento.
- `/dev-clear-test-data` - limpa dados de teste.

## Painel da fila

O painel é atualizado automaticamente e exibe:

- jogadores em espera;
- lobbies em formação;
- lobbies ativas;
- estado de fila aberta ou fechada;
- botões de entrada e saída.

Quando a fila está fechada, os botões ficam desabilitados.

### Permissões dos canais de painel

- O scheduler controla apenas estado operacional da fila (`open`/`closed`) e estado visual dos botões no painel.
- Startup, restart e novo deploy (incluindo Railway) não alteram privacidade do canal nem permission overwrites configurados manualmente no Discord.
- O bot nunca executa ajuste automático de `ViewChannel`, `SendMessages`, `ReadMessageHistory`, `AddReactions`, `UseApplicationCommands`, permissões de thread, overwrite de `@everyone`, overwrite de cargos ou overwrite individual de membros nos canais de painel.
- Canais privados permanecem privados; canais públicos permanecem públicos.
- Se o bot não tiver acesso suficiente ao canal do painel, ele não se auto-concede acesso: registra código seguro `CHANNEL_ACCESS_DENIED` e o administrador deve corrigir permissões manualmente no Discord.
- Antes da liberação oficial, um administrador deve tornar os canais visíveis manualmente quando necessário.
- O bot precisa receber manualmente permissões para visualizar canal, enviar mensagens e ler histórico para conseguir publicar/atualizar os painéis.

## Regras de negócio principais

- Subscribers têm prioridade na ordenação da fila.
- A prioridade SUB na fila é um snapshot calculado na entrada de cada usuário no ciclo atual.
- A fonte do snapshot é a elegibilidade central (`subscriberEligibilityService`): assinatura Kick ativa OU concessão manual ativa.
- Após a primeira entrada válida no ciclo, o snapshot de prioridade fica imutável durante todo o ciclo.
- Sair e entrar novamente no mesmo ciclo reaproveita a mesma categoria (SUB ou comum), sem nova consulta de elegibilidade.
- O snapshot só deixa de valer quando um novo ciclo é iniciado por `resetQueueCycle` (incluindo `/scheduler-open`).
- Se a elegibilidade estiver indisponível no momento da entrada, o usuário entra como comum (sem prioridade indevida).
- A ordenação usa timestamp numérico em milissegundos.
- O cooldown de saída é de 120 segundos.
- O scheduler de produção calcula o estado usando timezone IANA (`QUEUE_TIMEZONE`) e não depende do timezone local do servidor.
- Regra oficial recomendada: abertura às 19:00 e fechamento às 08:00 em `America/Sao_Paulo`.
- Nesse modelo, o ciclo operacional começa na abertura das 19:00, permanece aberto durante a madrugada e fecha às 08:00 do dia seguinte.
- A chave do ciclo corresponde à data local de abertura (ex.: ciclo `2026-08-07` vai de 07/08 19:00 até 08/08 08:00, no horário de Brasília).
- No fechamento automático das 08:00, o ciclo vigente é finalizado de forma transacional: limpa `queue_entries`, `lobby_players`, `lobbies` e os `queue_priority_snapshots` do ciclo encerrado.
- O fechamento automático remove lobbies `forming` e `in_game`, pois representam o estado operacional de partidas já despachadas no ciclo encerrado.
- O scheduler de desenvolvimento abre imediatamente ao iniciar o bot, mantém a fila aberta por 5 minutos, fecha por 5 minutos e repete indefinidamente.
- Abrir a fila limpa completamente o ciclo anterior: fila, lobby players e lobbies.
- Abrir/fechar fila significa apenas alterar estado interno e atualizar painel/botões; não altera visibilidade nem permissões do canal.

### Restart e overrides manuais do scheduler

- O scheduler persiste o último ciclo de abertura programada já aplicado e a última finalização automática por cycle key, evitando duplicidade em restart/reconciliação.
- Restart no período fechado (08:00-18:59:59 em Brasília): mantém fila fechada, sem criar novo ciclo.
- Restart no período aberto (após 19:00 e durante madrugada): mantém fila aberta no ciclo correto sem reset repetido.
- Se o bot perder o fechamento das 08:00 (offline), a finalização pendente é aplicada uma única vez na reconciliação seguinte antes de abrir novo ciclo.
- Se o bot iniciar após 19:00 sem ter executado o fechamento das 08:00, ele finaliza o ciclo anterior e só então abre o ciclo novo vazio.
- `/scheduler-open` cria novo ciclo manualmente (com limpeza transacional), e `/scheduler-close` fecha sem limpar.
- Overrides manuais permanecem até a próxima transição agendada; nessa transição o scheduler volta ao estado `scheduled`.
- A finalização automática é idempotente por cycle key persistida em `scheduler_state.last_scheduled_close_cycle_key`.
- As transições automáticas de 08:00 e 19:00 não têm moderador humano e não entram na auditoria administrativa de comandos slash.

### Ciclo de lobbies no ciclo atual

- `forming`: lobby ainda sendo montada. Jogadores desta lobby não podem voltar para a fila.
- `in_game`: lobby iniciada/despachada. Este é o último estado operacional da lobby no ciclo atual.
- Após `in_game`, o jogador pode entrar novamente na fila imediatamente e participar de outra lobby no mesmo ciclo.
- Registros anteriores em `lobby_players` são preservados como histórico do ciclo até o próximo reset.
- O mesmo `discord_id` pode aparecer em lobbies diferentes no mesmo ciclo de forma intencional.
- `/scheduler-close` preserva lobbies existentes (forming e in_game).
- `/scheduler-open` inicia novo ciclo e limpa `lobbies` e `lobby_players` via `resetQueueCycle`.
- No fechamento automático agendado, `forming` e `in_game` são removidas junto com o restante do ciclo encerrado.

## Scripts úteis

- `npm start` - inicia o bot.
- `npm run dev` - inicia com `nodemon` para desenvolvimento.
- `npm run lint` - valida o código com ESLint.
- `npm run format` - formata arquivos com Prettier.
- `npm test` - executa a suíte automatizada.
- `npm run test:watch` - executa os testes em modo assistido.
- `npm run test:coverage` - executa os testes com cobertura.
- `npm run db:backup` - executa backup manual seguro do SQLite com validação de integridade.
- `npm run db:backup:status` - lista metadados seguros de backups (sem conteúdo de tabelas).
- `npm run db:restore -- --file <nome-ou-caminho-controlado> --confirm` - restaura backup offline com confirmação explícita.

## Backup e restore do SQLite

- O backup diário é feito por scheduler dedicado, com `setTimeout` encadeado, sem `setInterval`.
- Cada backup cria arquivo temporário, valida com `PRAGMA integrity_check`, e só depois faz rename atômico para o arquivo final.
- Falha de retenção não invalida backup já concluído.
- Execuções são auditadas em `sqlite_backup_runs` (somente metadados seguros).
- Estado de execução diária do scheduler é persistido em `sqlite_backup_scheduler_state` para evitar duplicidade após restart.

### Restore offline obrigatório

- O bot deve estar desligado para restore.
- O restore exige `--confirm`; sem isso, nada é alterado.
- O arquivo de origem é restrito ao diretório configurado de backup e protegido contra path traversal.
- Antes de restaurar, o script cria backup pré-restore do banco atual e valida esse backup.
- A substituição usa arquivo temporário e swap controlado; em falha, o banco anterior é preservado.

Runbook completo: [docs/runbooks/sqlite-backup-restore.md](docs/runbooks/sqlite-backup-restore.md).

### Limite de proteção (off-host)

- Backups no mesmo disco não protegem contra perda total do servidor/disco.
- Em produção, o diretório de backups deve ser copiado para armazenamento externo criptografado.
- Nunca versionar backups no Git.

## Shutdown gracioso

- Ao receber `SIGINT` (Ctrl+C) ou `SIGTERM`, o bot inicia shutdown coordenado e define `process.exitCode` sem forçar saída imediata na primeira tentativa.
- Ordem de encerramento: marcar shutdown, parar scheduler da fila e scheduler de backup, aguardar backup em andamento (limitado por `SHUTDOWN_TIMEOUT_MS`), parar servidor HTTP da Kick, encerrar client Discord e fechar SQLite.
- Novas interações e novas requisições HTTP da integração Kick passam a receber resposta de indisponibilidade durante o shutdown.
- Em erro fatal (`uncaughtException` ou `unhandledRejection`), o encerramento usa `exitCode=1`.
- Se o timeout (`SHUTDOWN_TIMEOUT_MS`) for excedido, o processo marca falha de shutdown com `exitCode=1`.
- Um segundo sinal durante shutdown pode forçar encerramento.

### Operação segura

- Para reiniciar localmente: use `Ctrl+C` e aguarde o processo finalizar antes de iniciar novamente.
- Em produção: envie `SIGTERM` e aguarde o término do processo antes de subir nova instância.
- Exclusão manual de banco SQLite só deve ocorrer com o processo totalmente parado.

## Testes automatizados

A suíte cobre:

- regras de fila e ordenação;
- cooldown;
- formação de lobbies;
- reset total do ciclo;
- scheduler em desenvolvimento;
- painel da fila;
- helpers de banco temporário usados nos testes.

Para rodar tudo:

```bash
npm test
npm run test:coverage
```

## Banco de dados

O projeto usa SQLite local com criação automática do esquema em `data/database.sqlite` por padrão.

Durante os testes, o banco é isolado em arquivos temporários para não tocar no banco real.

## Organização interna

- `src/services/queueService.js` concentra a maior parte das regras da fila e dos lobbies.
- `src/services/schedulerService.js` controla o ciclo de abertura e fechamento.
- `src/services/queueMessageService.js` monta e atualiza o painel.
- `src/database/database.js` cria e evolui o esquema do SQLite.

## Status do projeto

O projeto já possui base funcional e suíte automatizada. A próxima expansão natural é integrar o fluxo com sistemas externos, como Kick, sem quebrar a lógica central da fila.

## Kick OAuth (etapa 2)

- O vínculo com a Kick usa OAuth 2.1 Authorization Code com PKCE (`S256`) e escopo `user:read`.
- A tentativa de vínculo (`state` + `code_verifier`) é armazenada em memória por 10 minutos.
- O `state` é de uso único e é removido após consumo ou expiração.
- Se o bot reiniciar, tentativas pendentes são perdidas e o usuário deve gerar novo link pelo comando.

## Kick (etapa atual)

- Painel permanente de vínculo: mensagem única com botão `Vincular conta Kick` no canal configurado por `KICK_LINK_CHANNEL_ID`.
- O comando `/kick-link` permanece disponível como alternativa ao painel.
- `/kick-status` aceita consulta própria (`/kick-status`) e consulta opcional de terceiro (`/kick-status usuario:@Membro`) para quem possui `Administrator` ou `Manage Guild`.
- A resposta de `/kick-status` é sempre privada (`ephemeral`) e usa apenas estado local persistido (SQLite + services existentes), sem chamada extra à API da Kick por consulta.
- `/kick-status` não sincroniza cargo automaticamente, não altera banco e não recalcula snapshot de prioridade de quem já entrou na fila no ciclo atual.
- Em `/kick-status`, elegibilidade de negócio e estado real do cargo Discord são exibidos separadamente (cargo presente/ausente/indisponível e membro gerenciável/não gerenciável/indisponível).
- Prioridade da fila: definida por snapshot na primeira entrada do usuário em cada ciclo.
- `/kick-unlink` é administrativo e desvincula um usuário alvo com confirmação explícita por botões.
- A confirmação de desvinculação usa identificador temporário, de uso único e com expiração de 5 minutos.
- Se o bot reiniciar, confirmações de desvinculação pendentes são invalidadas.
- A desvinculação remove apenas `kick_accounts` e grava auditoria em `kick_unlink_audit`.
- Após callback OAuth do vínculo Kick, o bot recalcula elegibilidade e tenta sincronizar automaticamente o cargo SUB.
- Após confirmação administrativa de `/kick-unlink`, o bot recalcula elegibilidade e tenta sincronizar automaticamente o cargo SUB do alvo.
- Falhas de sincronização de cargo não desfazem vínculo/desvínculo persistido no banco.

## Concessão manual de benefício SUB (etapa atual)

- Comandos administrativos: `/sub-grant`, `/sub-revoke` e `/sub-status`.
- A concessão manual é registrada separadamente para auditoria e não representa assinatura Kick.
- Os registros de concessão e revogação são preservados no histórico.
- `/sub-grant` e `/sub-revoke` recalculam elegibilidade e tentam sincronizar automaticamente o cargo SUB.
- Em caso de falha de sincronização de cargo, a alteração de banco permanece e a reconciliação manual pode ser feita via `/sub-sync`.
- A reconciliação em massa também pode ser executada manualmente via `/sub-reconcile` e periodicamente por scheduler dedicado.
- Esses comandos não alteram snapshot de prioridade de quem já está aguardando na fila no ciclo atual.
- A elegibilidade final atual considera assinatura Kick ativa OU concessão manual ativa, sem misturar os conceitos.
- O comando `/sub-sync` permanece disponível para diagnóstico e correção manual.
- O cargo é identificado exclusivamente por `SUBSCRIBER_ROLE_ID` (nunca por nome).
- O bot precisa da permissão `ManageRoles` e seu cargo deve estar acima do cargo SUB na hierarquia.
- Scheduler periódico ainda não está implementado para reconciliação em massa.

## Kick Webhooks (etapa atual)

- Endpoint local: `POST /kick/webhooks`.
- Assinatura do webhook é obrigatória e validada com RSA SHA-256 sobre o corpo bruto da requisição.
- Eventos suportados: `channel.subscription.new`, `channel.subscription.renewal`, `channel.subscription.gifts` e `channel.followed`.
- Idempotência por `event_message_id`, com persistência em `kick_webhook_events`.
- Assinaturas são persistidas em `kick_subscriptions` com controle por `expires_at_ms` (sem booleano fixo de subscriber).
- Renovação e eventos fora de ordem não reduzem `expires_at_ms`.
- Eventos `channel.followed` são auditados em `kick_follow_events` apenas para diagnóstico da integração real.
- `channel.followed` não concede benefício SUB e não altera cargo, fila ou elegibilidade.
- Após persistência confiável de `channel.subscription.new`, `channel.subscription.renewal` e `channel.subscription.gifts`, o bot tenta sincronizar automaticamente o cargo SUB dos usuários vinculados.
- Se o `kick_user_id` recebido não possuir vínculo local em `kick_accounts`, o evento permanece persistido sem erro e sem sincronização de cargo.
- Falhas de sincronização de cargo após persistência não causam retry do webhook e não desfazem alterações de banco.
- O endpoint permanece local (loopback), ainda não acessível externamente pela Kick nesta etapa.
- O cadastro de event subscriptions usa o comando administrativo `/kick-events-sync`.
- O comando `/kick-events-sync` também aceita `force:true` para tentar uma ressincronização manual dos quatro eventos desejados quando a API parecer inconsistente.
- O relatório do comando inclui diagnóstico seguro por subscription, com broadcaster, status, método e motivo da validação, sem expor credenciais ou URL de callback.
- A URL pública do webhook continua configurada manualmente no painel da Kick.
- Webhooks continuam sem alterar snapshot de prioridade de quem já está aguardando na fila no ciclo atual.

### Hardening HTTP da integração Kick

- `POST /kick/webhooks` valida `Content-Length` quando presente e rejeita imediatamente payload acima do limite com `413 Payload Too Large`.
- Mesmo sem `Content-Length`, o corpo é contado por bytes reais recebidos em `Buffer`; ao ultrapassar o limite, a requisição é encerrada com `413` antes de validação de assinatura, `JSON.parse` e persistência.
- O corpo do webhook mantém formato bruto (`Buffer`) para validação RSA SHA-256 sem alteração de conteúdo.
- A leitura do corpo do webhook possui timeout configurável; ao exceder o limite, a resposta é `408 Request Timeout` e o processamento é abortado de forma controlada.
- URL acima do limite configurado retorna `414 URI Too Long` antes do parsing detalhado do callback OAuth.
- `Content-Length` inválido retorna `400 Bad Request`.
- Logs de rejeição HTTP registram apenas metadados seguros (status, rota e limites), sem corpo, assinatura, token, `code` ou `state`.

### Variáveis de ambiente de hardening HTTP Kick

- `KICK_HTTP_MAX_BODY_BYTES` (opcional, padrão `1048576` = `1 MiB`)
- `KICK_HTTP_BODY_TIMEOUT_MS` (opcional, padrão `10000` = `10s`)
- `KICK_HTTP_MAX_URL_LENGTH` (opcional, padrão `8192` = `8 KiB`)

## Kick Event Subscriptions (etapa atual)

- Comando administrativo: `/kick-events-sync`.
- Finalidade: sincronizar na API oficial da Kick os eventos obrigatórios para webhooks da aplicação, sem duplicar subscriptions.
- Eventos registrados:
	- `channel.subscription.new` v1
	- `channel.subscription.renewal` v1
	- `channel.subscription.gifts` v1
	- `channel.followed` v1 (temporário para diagnóstico da integração real)
- A sincronização padrão é idempotente: cria apenas eventos ausentes e preserva subscriptions extras existentes.
- O modo `force:true` tenta recriar os eventos desejados sem assumir como válidas subscriptions com broadcaster errado, status inativo ou transporte diferente de webhook.
- O comando exige execução em servidor e permissão `Administrator`.
- O comando responde `ephemeral` e usa defer por envolver chamadas externas.

### URL pública do webhook

- A URL pública de `POST /kick/webhooks` deve ser configurada manualmente no painel da aplicação Kick.
- Não versione URL temporária de desenvolvimento no código ou em `.env.example`.
- Quick Tunnel (ex.: `trycloudflare`) é apenas apoio de desenvolvimento local.

### Segurança de token

- O App Access Token (Client Credentials) é mantido somente em memória.
- O token possui cache com renovação antes da expiração.
- O token nunca é salvo no SQLite.
- Credenciais e tokens não são registrados em log.

### Escopo desta etapa

- Banco SQLite é a fonte de verdade para elegibilidade observada e concessões manuais.
- A fila usa elegibilidade central apenas no momento da entrada para congelar prioridade por ciclo.
- Não há polling da API Kick para decidir elegibilidade.

## Reconciliação periódica de cargo SUB

- Serviço dedicado: reconcilia candidatos em massa reutilizando a elegibilidade central e a sincronização individual com auditoria.
- Descoberta de candidatos:
	- `discord_id` em `kick_accounts`;
	- `discord_id` com histórico em `manual_sub_grants`;
	- membros do servidor que atualmente possuem `SUBSCRIBER_ROLE_ID`.
- A listagem de membros com SUB não assume cache completo: tenta fetch explícito de membros e aplica timeout controlado.
- Em falha ou timeout da listagem de membros com SUB, a execução continua com candidatos de banco (`kick_accounts` + `manual_sub_grants`) e marca descoberta incompleta.
- Com descoberta incompleta, remoções de cargo são bloqueadas por segurança naquela execução; adições para elegíveis conhecidos continuam permitidas.
- Regra aplicada por usuário: Kick ativa OU manual ativa mantém/adiciona SUB; sem fontes ativas remove SUB; elegibilidade desconhecida nunca força remoção.
- Falha em um usuário não interrompe os demais.
- Execuções simultâneas são bloqueadas por trava em memória.
- Operações de Discord potencialmente demoradas (descoberta e sincronização por usuário) usam timeout controlado para evitar execução pendurada.
- Execuções em massa são auditadas em `subscriber_role_reconciliation_runs`.

### Requisito de intents

- O client do bot inclui `GatewayIntentBits.GuildMembers` para permitir descoberta completa de membros com SUB.
- Também é necessário ativar o **Server Members Intent** no Discord Developer Portal da aplicação; sem isso, a descoberta pode ficar parcial e as remoções serão bloqueadas por segurança.

### Variáveis de ambiente

- `SUB_ROLE_RECONCILIATION_ENABLED` (padrão `true`)
- `SUB_ROLE_RECONCILIATION_INTERVAL_MINUTES` (padrão `15`)
- `SUB_ROLE_RECONCILIATION_STARTUP_DELAY_SECONDS` (padrão `30`)
- `SUB_ROLE_RECONCILIATION_DISCOVERY_TIMEOUT_MS` (padrão `20000`)
- `SUB_ROLE_RECONCILIATION_USER_SYNC_TIMEOUT_MS` (padrão `12000`)

### Resultado e classificação

- `member_not_found` (usuário histórico fora do servidor) é contabilizado como ignorado, não como falha.
- Falhas reais de sincronização (ex.: `role_not_found`, `guild_not_found`, `missing_manage_roles`, `hierarchy_error`, `discord_sync_timeout`, `discord_api_error`, `member_not_manageable`) permanecem em falhas.
- Avisos de auditoria individual (`auditWarning`) são contabilizados separadamente de falhas de cargo.

### Limitações conhecidas

- A reconciliação de cargo não altera fila, painel, scheduler da fila ou lobbies.
- A reconciliação não consulta a API da Kick diretamente; usa somente estado persistido no banco.
