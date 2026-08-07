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

# Roles
SUBSCRIBER_ROLE_ID=

# Database
DATABASE_PATH=./data/database.sqlite

# Environment
NODE_ENV=development

# Production Scheduler
QUEUE_OPEN_TIME=18:58
QUEUE_CLOSE_TIME=06:00
QUEUE_TIMEZONE=America/Sao_Paulo

# Development Scheduler
QUEUE_TEST_INTERVAL_MINUTES=5
```

### Observações importantes

- `DISCORD_TOKEN` e outras credenciais nunca devem ser versionadas.
- `NODE_ENV=development` ativa o comportamento de desenvolvimento do scheduler.
- `DATABASE_PATH` aponta para o banco SQLite local por padrão.
- `QUEUE_TEST_INTERVAL_MINUTES` controla o intervalo de ciclo em desenvolvimento.

## Comandos disponíveis

Documentação detalhada e mandatória de comandos slash e botões: [DISCORD_COMMANDS.md](DISCORD_COMMANDS.md).

### Comandos administrativos

- `/scheduler-open` - abre a fila manualmente e reinicia o ciclo atual.
- `/scheduler-close` - fecha a fila manualmente sem limpar os dados do ciclo atual.
- `/scheduler-status` - mostra o estado atual do scheduler.
- `/lobby-start` - inicia uma lobby pelo número.
- `/lobby-form-force` - força a criação de uma lobby com jogadores suficientes.
- `/kick-events-sync` - sincroniza os event subscriptions oficiais da Kick para o webhook da aplicação.
- `/kick-webhook-status` - mostra auditoria resumida do último webhook válido recebido pela integração Kick.

### Comandos de suporte e diagnóstico

- `/ping` - checagem básica de latência.
- `/status` - visão geral do bot.
- `/queue` - exibe informações da fila.
- `/queue-status` - mostra o estado detalhado da fila.
- `/lobby-status` - mostra o estado dos lobbies.
- `/queue-add-test` - adiciona jogador de teste à fila.
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

## Regras de negócio principais

- Subscribers têm prioridade na ordenação da fila.
- A ordenação usa timestamp numérico em milissegundos.
- O cooldown de saída é de 120 segundos.
- O scheduler de produção segue os horários configurados em `QUEUE_OPEN_TIME` e `QUEUE_CLOSE_TIME`.
- O scheduler de desenvolvimento abre imediatamente ao iniciar o bot, mantém a fila aberta por 5 minutos, fecha por 5 minutos e repete indefinidamente.
- Abrir a fila limpa completamente o ciclo anterior: fila, lobby players e lobbies.

## Scripts úteis

- `npm start` - inicia o bot.
- `npm run dev` - inicia com `nodemon` para desenvolvimento.
- `npm run lint` - valida o código com ESLint.
- `npm run format` - formata arquivos com Prettier.
- `npm test` - executa a suíte automatizada.
- `npm run test:watch` - executa os testes em modo assistido.
- `npm run test:coverage` - executa os testes com cobertura.

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
- `/kick-status` mostra o estado do vínculo Kick do usuário, o estado observado da assinatura via webhook e a elegibilidade consolidada.
- `/kick-unlink` é administrativo e desvincula um usuário alvo com confirmação explícita por botões.
- A confirmação de desvinculação usa identificador temporário, de uso único e com expiração de 5 minutos.
- Se o bot reiniciar, confirmações de desvinculação pendentes são invalidadas.
- A desvinculação remove apenas `kick_accounts` e grava auditoria em `kick_unlink_audit`.
- Concessões manuais, histórico de subscriptions, cargo e fila não são alterados nesta etapa.
- A sincronização automática de cargo/prioridade no Discord ainda não está implementada nesta etapa.

## Concessão manual de benefício SUB (etapa atual)

- Comandos administrativos: `/sub-grant`, `/sub-revoke` e `/sub-status`.
- A concessão manual é registrada separadamente para auditoria e não representa assinatura Kick.
- Os registros de concessão e revogação são preservados no histórico.
- Nesta etapa, não há sincronização de cargo e não há alteração da fila por esses comandos.
- A elegibilidade final atual considera assinatura Kick ativa OU concessão manual ativa, sem misturar os conceitos.
- A sincronização de cargo SUB no Discord é manual nesta etapa, via comando administrativo `/sub-sync`.
- O cargo é identificado exclusivamente por `SUBSCRIBER_ROLE_ID` (nunca por nome).
- O bot precisa da permissão `ManageRoles` e seu cargo deve estar acima do cargo SUB na hierarquia.
- Automações de sincronização por webhook/link/unlink/grant/scheduler ficam para etapa posterior.

## Kick Webhooks (etapa atual)

- Endpoint local: `POST /kick/webhooks`.
- Assinatura do webhook é obrigatória e validada com RSA SHA-256 sobre o corpo bruto da requisição.
- Eventos suportados: `channel.subscription.new`, `channel.subscription.renewal`, `channel.subscription.gifts` e `channel.followed`.
- Idempotência por `event_message_id`, com persistência em `kick_webhook_events`.
- Assinaturas são persistidas em `kick_subscriptions` com controle por `expires_at_ms` (sem booleano fixo de subscriber).
- Renovação e eventos fora de ordem não reduzem `expires_at_ms`.
- Eventos `channel.followed` são auditados em `kick_follow_events` apenas para diagnóstico da integração real.
- `channel.followed` não concede benefício SUB e não altera cargo, fila ou elegibilidade.
- O endpoint permanece local (loopback), ainda não acessível externamente pela Kick nesta etapa.
- O cadastro de event subscriptions usa o comando administrativo `/kick-events-sync`.
- A URL pública do webhook continua configurada manualmente no painel da Kick.
- Cargo Discord e fila ainda não são sincronizados por webhook nesta etapa.

## Kick Event Subscriptions (etapa atual)

- Comando administrativo: `/kick-events-sync`.
- Finalidade: sincronizar na API oficial da Kick os eventos obrigatórios para webhooks da aplicação, sem duplicar subscriptions.
- Eventos registrados:
	- `channel.subscription.new` v1
	- `channel.subscription.renewal` v1
	- `channel.subscription.gifts` v1
	- `channel.followed` v1 (temporário para diagnóstico da integração real)
- A sincronização é idempotente: cria apenas eventos ausentes e preserva subscriptions extras existentes.
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

- Ainda não há integração com cargos do Discord.
- Ainda não há integração com a fila.
- Ainda não há expiração automática de cargos.
