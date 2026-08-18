Este documento deve ser atualizado sempre que qualquer comando slash, botão ou regra de interação do Discord for criado, removido ou alterado no código.

# Comandos e Interações do Discord

## Comportamento global durante shutdown/reinício
- Quando o processo entra em shutdown (ex.: SIGINT/SIGTERM), novas interações de slash command e botões são recusadas no roteador central.
- Mensagem retornada quando possível: "O bot está reiniciando. Tente novamente em instantes." (ephemeral).
- Objetivo: evitar início de operações novas enquanto schedulers, integração HTTP, Discord e SQLite estão sendo encerrados de forma coordenada.

## Regra obrigatória de permissões dos canais
- O bot nunca altera automaticamente privacidade nem permission overwrites dos canais de painel/fila.
- Isso vale para startup local, startup no Railway, restart, redeploy, reconciliação do scheduler, abertura/fechamento automático (19:00/08:00), `/scheduler-open`, `/scheduler-close`, inicialização/recuperação de painel e shutdown.
- `open`/`closed` controla apenas estado operacional da fila e estado visual dos botões.
- Canais privados permanecem privados e canais públicos permanecem públicos, exatamente conforme configuração manual no Discord.
- O bot não executa autoajuste de `ViewChannel`, `SendMessages`, `ReadMessageHistory`, `AddReactions`, `UseApplicationCommands`, permissões de threads, overwrite de `@everyone`, overwrite de cargos ou overwrite individual de membros.
- Sem acesso suficiente ao canal, o bot não se auto-concede acesso e registra código seguro `CHANNEL_ACCESS_DENIED`.

## Auditoria administrativa de fila e lobbies
- Fonte oficial: tabela SQLite `admin_command_audit_logs`.
- Escopo auditado nesta etapa (comandos mutáveis): `/scheduler-open`, `/scheduler-close`, `/lobby-form-force`, `/lobby-start`, `/lobby-swap`, `/lobby-remove`.
- Consulta administrativa auditada nesta etapa: `/kick-status usuario:@Membro` quando o alvo é terceiro.
- Consultas próprias continuam fora da auditoria administrativa.
- Comandos administrativos de consulta ainda não auditados nesta etapa: `/scheduler-status`, `/fila-status`, `/lobby-status`.
- Cada tentativa registra início (`pending`) e resultado final (`success`, `failed` ou `denied`) com código seguro.
- Metadados permitidos: `interaction_id`, `guild_id`, `channel_id`, ator, comando, parâmetros saneados, `queue_cycle_id`, estado operacional seguro antes/depois, `error_code` e timestamps.
- Dados proibidos: tokens, secrets, payload completo de interação/Discord, stack trace, mensagem interna de exceção, dados sensíveis de OAuth/Kick.
- Se a auditoria obrigatória falhar antes da mutação, a ação administrativa mutável é recusada.
- Em `/kick-status` administrativo, apenas ator, alvo por Discord ID, comando, horário e resultado seguro são persistidos.
- Falha de publicação opcional no Discord não desfaz operação concluída e gera apenas warning seguro.
- Canal opcional de resumo: `ADMIN_AUDIT_CHANNEL_ID` (com validação de guild e `allowedMentions` sem menções).
- Retenção automática: `ADMIN_AUDIT_RETENTION_DAYS` (padrão 30 dias; inteiro seguro entre 1 e 3650).
- Cutoff de retenção: remove apenas registros com `started_at_ms` estritamente anterior a `agora - retentionDays`.
- Fronteira: registro exatamente no cutoff é preservado.
- Resultados antigos elegíveis para limpeza: `pending`, `success`, `failed` e `denied`.
- Escopo da limpeza: somente `admin_command_audit_logs`; sem `VACUUM` automático.

## Autorização operacional centralizada
- Regra: o bot busca o membro real no servidor antes de autorizar a ação.
- Permite quando o ator tiver `Administrator`, `Manage Guild` ou algum cargo listado em `BOT_OPERATOR_ROLE_IDS`.
- `BOT_OPERATOR_ROLE_IDS` é opcional, aceita IDs de cargos separados por vírgula, remove espaços, ignora itens vazios e valida cada snowflake.
- Sem `BOT_OPERATOR_ROLE_IDS`, o comportamento permanece restrito a `Administrator` e `Manage Guild`.
- A lista de IDs nunca aparece em respostas ou logs.

## /dev-clear-test-data
- Nome: /dev-clear-test-data
- Finalidade: limpar dados fictícios de fila/lobbies usados em desenvolvimento.
- Quem pode usar: Administrator ou Manage Guild.
- Onde usar: servidor Discord (uso em desenvolvimento).
- Parâmetros: confirmar (boolean, obrigatório).
- Resposta: ephemeral.
- Exemplo: /dev-clear-test-data confirmar:true
- Efeitos no banco: remove dados de teste da fila e lobbies via queueService.clearTestData().
- Efeitos em cargo: nenhum.
- Efeitos na fila: limpa entradas/lobbies de teste.
- Limitações: bloqueado fora de NODE_ENV=development.

## /dev-fill-queue
- Nome: /dev-fill-queue
- Finalidade: preencher fila com jogadores fictícios para testes.
- Quem pode usar: Administrator ou Manage Guild.
- Onde usar: servidor Discord (uso em desenvolvimento).
- Parâmetros: quantidade (integer 1-50, obrigatório), subs (integer 0-50, opcional).
- Resposta: ephemeral.
- Exemplo: /dev-fill-queue quantidade:20 subs:5
- Efeitos no banco: insere múltiplas entradas na fila.
- Efeitos em cargo: nenhum.
- Efeitos na fila: adiciona jogadores de teste e marca parte como SUB.
- Limitações: bloqueado fora de NODE_ENV=development; subs não pode ser maior que quantidade.

## /kick-events-sync
- Nome: /kick-events-sync
- Finalidade: sincronizar subscriptions oficiais de eventos Kick para webhook.
- Quem pode usar: Administrator.
- Onde usar: servidor Discord.
- Parâmetros: force (boolean, opcional).
- Resposta: ephemeral com defer/edit.
- Exemplo: /kick-events-sync force:true
- Efeitos no banco: nenhum direto; sincronização ocorre na API da Kick.
- Efeitos em cargo: nenhum.
- Efeitos na fila: nenhum.
- Limitações: depende de configuração Kick válida e disponibilidade da API externa.
- Comportamento: o modo padrão cria apenas eventos ausentes; `force:true` tenta ressincronizar os quatro eventos desejados usando diagnóstico seguro da subscription existente.

## /kick-link
- Nome: /kick-link
- Finalidade: alternativa de vínculo OAuth Kick do usuário Discord (o fluxo principal também está no painel permanente).
- Quem pode usar: qualquer usuário.
- Onde usar: servidor Discord.
- Parâmetros: nenhum.
- Resposta: ephemeral com botão de link OAuth.
- Exemplo: /kick-link
- Efeitos no banco: nenhum imediato; vínculo é persistido no callback OAuth.
- Efeitos em cargo: após o callback OAuth, recalcula elegibilidade e sincroniza automaticamente o cargo SUB (com tolerância a falhas, sem desfazer vínculo).
- Efeitos na fila: nenhum.
- Limitações: integração Kick precisa estar habilitada; não cria novo vínculo se já existir vínculo ativo.

## /kick-status
- Nome: /kick-status
- Finalidade: mostrar vínculo Kick, estado da assinatura Kick, concessão manual, elegibilidade final e diagnóstico seguro do cargo SUB.
- Quem pode usar: qualquer usuário.
- Onde usar: servidor Discord.
- Parâmetros: usuario (user, opcional).
- Resposta: ephemeral.
- Exemplo: /kick-status
- Exemplo: /kick-status usuario:@Membro
- Efeitos no banco: apenas leitura.
- Efeitos em cargo: nenhum.
- Efeitos na fila: nenhum.
- Regras de acesso:
- Sem `usuario`, o comando consulta o próprio autor.
- Com `usuario` apontando para o próprio autor, a consulta é permitida normalmente.
- Com `usuario` apontando para outro membro, exige autorização operacional centralizada (`Administrator`, `Manage Guild` ou cargo em `BOT_OPERATOR_ROLE_IDS`).
- Consulta de terceiro é recusada quando o membro alvo não estiver disponível no servidor.
- Consulta de terceiro é auditada sem persistir username Kick, Kick ID, estado detalhado de assinatura, motivo manual ou resposta completa.
- Limitações: depende de eventos webhook para observar assinatura Kick; reflete apenas estado local já persistido; não força atualização na API da Kick, não sincroniza cargo automaticamente e não recalcula snapshot de prioridade para usuários já na fila no ciclo atual.

## /kick-unlink
- Nome: /kick-unlink
- Finalidade: iniciar desvinculação administrativa da conta Kick de um membro.
- Quem pode usar: Administrator.
- Onde usar: servidor Discord.
- Parâmetros: usuario (user, obrigatório), motivo (string, obrigatório).
- Resposta: ephemeral com botões de confirmar/cancelar.
- Exemplo: /kick-unlink usuario:@Membro motivo:Solicitação do usuário
- Efeitos no banco: nenhum direto no comando; remoção + auditoria ocorrem ao confirmar no botão.
- Efeitos em cargo: ao confirmar, recalcula elegibilidade e sincroniza automaticamente o cargo SUB do alvo.
- Efeitos na fila: nenhum.
- Limitações: confirmação expira em 5 minutos, é de uso único e só pode ser confirmada pelo administrador que iniciou.

## /kick-webhook-status
- Nome: /kick-webhook-status
- Finalidade: exibir diagnóstico do recebimento de webhooks Kick (último evento, totais auditados e follows).
- Quem pode usar: Administrator.
- Onde usar: servidor Discord.
- Parâmetros: nenhum.
- Resposta: ephemeral.
- Exemplo: /kick-webhook-status
- Efeitos no banco: apenas leitura.
- Efeitos em cargo: nenhum.
- Efeitos na fila: nenhum.
- Limitações: mostra somente estado conhecido localmente pelo banco/auditoria.

## /lobby-form-force
- Nome: /lobby-form-force
- Finalidade: forçar criação manual de lobby em formação com N jogadores.
- Quem pode usar: autorização operacional centralizada (`Administrator`, `Manage Guild` ou cargo em `BOT_OPERATOR_ROLE_IDS`).
- Onde usar: servidor Discord.
- Parâmetros: quantidade (integer 1-4, obrigatório).
- Resposta: ephemeral.
- Exemplo: /lobby-form-force quantidade:4
- Efeitos no banco: move/consome jogadores da fila e cria lobby em formação.
- Efeitos em cargo: nenhum.
- Efeitos na fila: reduz fila e atualiza painel.
- Limitações: falha se não houver jogadores suficientes.
- Auditoria administrativa: registra tentativa, quantidade solicitada, quantidade usada, lobby criada (ID/número seguro), ciclo e resultado seguro (`success`, `failed` ou `denied`).

## /lobby-start
- Nome: /lobby-start
- Finalidade: iniciar lobby que está em formação.
- Quem pode usar: autorização operacional centralizada (`Administrator`, `Manage Guild` ou cargo em `BOT_OPERATOR_ROLE_IDS`).
- Onde usar: servidor Discord.
- Parâmetros: numero (integer, obrigatório, mínimo 1).
- Resposta: ephemeral.
- Exemplo: /lobby-start numero:3
- Efeitos no banco: altera estado da lobby para iniciada.
- Efeitos em cargo: nenhum.
- Efeitos na fila: atualiza painel.
- Limitações: recusa ausência, zero, negativo e valor não inteiro; nunca escolhe lobby automaticamente.
- Estado final operacional: após iniciar, a lobby passa para `in_game` e permanece assim até o reset do ciclo.
- Estado iniciável canônico preservado do domínio: `forming` e `open`; `in_game` não pode ser reiniciada.
- Reentrada de jogadores: usuários da lobby iniciada (`in_game`) podem entrar novamente na fila no mesmo ciclo.
- Histórico: os registros anteriores em `lobby_players` permanecem preservados até o próximo `resetQueueCycle`.
- Auditoria administrativa: registra tentativa, número solicitado, lobby alvo (ID/número seguro), estado anterior/seguinte (`in_game`) quando aplicável, ciclo e resultado seguro (`success`, `failed` ou `denied`).

## /lobby-swap
- Nome: /lobby-swap
- Finalidade: trocar administrativamente dois participantes mutáveis do ciclo atual.
- Quem pode usar: autorização operacional centralizada (`Administrator`, `Manage Guild` ou cargo em `BOT_OPERATOR_ROLE_IDS`).
- Onde usar: servidor Discord.
- Parâmetros: usuario_a (user, obrigatório), usuario_b (user, obrigatório), motivo (string 3-200, obrigatório).
- Resposta: ephemeral.
- Exemplo: /lobby-swap usuario_a:@A usuario_b:@B motivo:Troca combinada
- Efeitos no banco: executa troca transacional única entre os estados permitidos (`queue` e `forming_lobby`) preservando identidade, snapshot de prioridade real e `joined_at_ms` quando aplicável.
- Efeitos em cargo: nenhum.
- Efeitos na fila: suporta fila↔fila, fila↔`forming`, `forming`↔fila e `forming`↔`forming` (inclusive dois slots da mesma lobby `forming`) sem criar mutações parciais.
- Regras de imutabilidade: um participante só bloqueia a operação com `LOBBY_IMMUTABLE` quando não possui participação mutável atual (fila ou lobby `forming`); registros históricos em lobby `in_game` não impedem a troca de uma participação mutável posterior e a lobby `in_game` permanece intocada.
- Locks e rebuild: quando há lobby `forming` envolvida, a(s) lobby(s) afetada(s) recebem `rebuild_locked=1` para o rebuild automático não desfazer a troca; o lock é reconciliado no fluxo normal de saída/remoção.
- Overrides temporários: `admin_sort_priority_override` é aplicado apenas quando necessário para manter posição absoluta após trocas entre categorias diferentes e some quando a entrada termina.
- Limitações: usuário fora da fila e fora de lobby `forming` retorna falha segura; conflitos de estado/slot/ordem também retornam falha segura sem mutação.
- Auditoria administrativa obrigatória: registra tentativa com parâmetros saneados (incluindo motivo), resultado seguro (`success`, `failed` ou `denied`), código seguro e resumo de estado operacional antes/depois.

## /lobby-remove
- Nome: /lobby-remove
- Finalidade: remover administrativamente um jogador ausente de uma lobby `forming`, localizada automaticamente pelo Discord ID.
- Quem pode usar: autorização operacional centralizada (`Administrator`, `Manage Guild` ou cargo em `BOT_OPERATOR_ROLE_IDS`).
- Onde usar: servidor Discord.
- Parâmetros: usuario (user, obrigatório), motivo (string 3-200, obrigatório).
- Resposta: ephemeral.
- Exemplo: /lobby-remove usuario:@Membro motivo:Jogador ausente
- Efeitos no banco: remove o jogador da lobby `forming` em transação única, remove eventual `queue_entry` residual do mesmo Discord ID e libera `rebuild_locked` quando aplicável antes do rebuild canônico.
- Efeitos em cargo: nenhum.
- Efeitos na fila: o usuário removido não retorna automaticamente para a fila; para voltar, precisa entrar novamente pelo botão normal.
- Limitações: lobby `in_game` é imutável; jogador fora de lobby removível retorna falha segura sem mutação; o comando não funciona como remoção genérica da fila.
- Reentrada posterior: ao voltar, o usuário recebe nova posição normal com novo `queue_order_key`, `admin_sort_priority_override` nulo e prioridade calculada pela regra/snapshot canônica do ciclo.
- Auditoria administrativa obrigatória: registra tentativa e finalização (`success`, `failed` ou `denied`) com código seguro, ciclo, alvo e resumo operacional saneado, mantendo retenção padrão de 30 dias.

## /lobby-status
- Nome: /lobby-status
- Finalidade: listar lobbies ativas registradas no banco.
- Quem pode usar: qualquer usuário.
- Onde usar: servidor Discord.
- Parâmetros: nenhum.
- Resposta: ephemeral.
- Exemplo: /lobby-status
- Efeitos no banco: apenas leitura.
- Efeitos em cargo: nenhum.
- Efeitos na fila: nenhum.
- Limitações: retorna vazio quando não há lobbies ativas.

## /ping
- Nome: /ping
- Finalidade: health check simples do bot.
- Quem pode usar: qualquer usuário.
- Onde usar: servidor ou DM.
- Parâmetros: nenhum.
- Resposta: pública (não ephemeral).
- Exemplo: /ping
- Efeitos no banco: nenhum.
- Efeitos em cargo: nenhum.
- Efeitos na fila: nenhum.
- Limitações: nenhuma.

## /fila
- Nome: /fila
- Finalidade: exibir botões para entrar/sair da fila.
- Quem pode usar: qualquer usuário.
- Onde usar: servidor ou DM.
- Parâmetros: nenhum.
- Resposta: ephemeral com botões join_queue e leave_queue.
- Exemplo: /fila
- Efeitos no banco: nenhum direto no comando.
- Efeitos em cargo: nenhum.
- Efeitos na fila: nenhum direto no comando.
- Limitações: ações reais dependem dos botões.

## /fila-add-teste
- Nome: /fila-add-teste
- Finalidade: adicionar usuário específico na fila para testes.
- Quem pode usar: Administrator ou Manage Guild.
- Onde usar: servidor Discord, somente em NODE_ENV=development.
- Parâmetros: usuario (user, obrigatório), subscriber (boolean, obrigatório).
- Resposta: ephemeral.
- Exemplo: /fila-add-teste usuario:@Jogador subscriber:true
- Efeitos no banco: insere entrada na fila.
- Efeitos em cargo: nenhum.
- Efeitos na fila: adiciona usuário e marca subscriber conforme parâmetro.
- Limitações: ferramenta de desenvolvimento; fora de development o comando não deve ser registrado e interações legadas são recusadas sem alterar fila/banco.

## /fila-status
- Nome: /fila-status
- Finalidade: mostrar fila atual ordenada.
- Quem pode usar: qualquer usuário.
- Onde usar: servidor Discord.
- Parâmetros: nenhum.
- Resposta: ephemeral.
- Exemplo: /fila-status
- Efeitos no banco: apenas leitura.
- Efeitos em cargo: nenhum.
- Efeitos na fila: nenhum.
- Limitações: nenhuma.

## /scheduler-close
- Nome: /scheduler-close
- Finalidade: fechar fila manualmente sem limpar o ciclo atual.
- Quem pode usar: Administrator ou Manage Guild.
- Onde usar: servidor Discord.
- Parâmetros: nenhum.
- Resposta: ephemeral com defer/edit.
- Exemplo: /scheduler-close
- Efeitos no banco: mantém dados do ciclo; altera estado de fila no scheduler.
- Efeitos em cargo: nenhum.
- Efeitos na fila: fecha fila para novas entradas.
- Efeitos em permissões de canal: nenhum (não altera visibilidade nem overwrites).
- Limitações: ação administrativa.
- Efeitos em lobbies: preserva lobbies existentes (`forming` e `in_game`) e seus registros em `lobby_players`.
- Persistência de override: o fechamento manual permanece após restart até a próxima transição agendada (ex.: 08:00/19:00 no timezone configurado).
- Mensagem administrativa: "Fila fechada manualmente. O ciclo atual foi preservado."
- Auditoria administrativa: registra tentativa, estado anterior/posterior, ciclo atual preservado e resultado seguro (`success`, `failed` ou `denied`).

## /scheduler-open
- Nome: /scheduler-open
- Finalidade: abrir fila manualmente e reiniciar ciclo.
- Quem pode usar: Administrator ou Manage Guild.
- Onde usar: servidor Discord.
- Parâmetros: nenhum.
- Resposta: ephemeral com defer/edit.
- Exemplo: /scheduler-open
- Efeitos no banco: limpeza/reinício de ciclo conforme regra do scheduler.
- Efeitos em cargo: nenhum.
- Efeitos na fila: abre fila e reinicia ciclo.
- Efeitos em permissões de canal: nenhum (não altera visibilidade nem overwrites).
- Limitações: ação administrativa.
- Efeitos em lobbies: limpa `lobbies` e `lobby_players` ao iniciar o novo ciclo.
- Persistência de override: a abertura manual permanece após restart até a próxima transição agendada.
- Auditoria administrativa: registra tentativa, estado anterior/posterior, ciclo anterior/novo ciclo quando disponível e indicação de reinício manual de ciclo.

## Regras de transição agendada (produção)
- Fechamento automático (08:00 no timezone configurado): fecha entradas novas e finaliza o ciclo de forma transacional.
- Limpeza da finalização automática: remove `queue_entries`, `lobby_players`, `lobbies` (incluindo `forming` e `in_game`) e `queue_priority_snapshots` do ciclo encerrado.
- Idempotência persistida: a finalização automática é marcada por cycle key em `scheduler_state` e não é aplicada duas vezes no mesmo ciclo.
- Abertura automática (19:00): abre ciclo novo vazio; se o fechamento das 08:00 foi perdido por offline, a finalização pendente é aplicada uma única vez antes da abertura.
- As transições automáticas mudam apenas estado interno e botões do painel; não alteram permissões/privacidade de canal.
- Observação de auditoria: as transições automáticas (08:00/19:00) não possuem moderador humano e não entram na auditoria administrativa de comandos slash.

## /scheduler-status
- Nome: /scheduler-status
- Finalidade: mostrar estado atual e próximos horários do scheduler.
- Quem pode usar: Administrator ou Manage Guild.
- Onde usar: servidor Discord.
- Parâmetros: nenhum.
- Resposta: ephemeral com defer/edit.
- Exemplo: /scheduler-status
- Efeitos no banco: nenhum direto.
- Efeitos em cargo: nenhum.
- Efeitos na fila: nenhum direto.
- Limitações: depende de scheduler já inicializado.
- Campos exibidos: estado atual, origem (`scheduled`, `manual_open` ou `manual_close`), timezone efetivo, horários configurados, próxima abertura, próximo fechamento e chave do ciclo atual quando aplicável.
- Regra de ciclo operacional (produção): com `QUEUE_OPEN_TIME=19:00`, `QUEUE_CLOSE_TIME=08:00` e `QUEUE_TIMEZONE=America/Sao_Paulo`, a abertura das 19:00 inicia o ciclo da data local da abertura e ele permanece aberto durante a madrugada até 08:00 do dia seguinte.

## /status
- Nome: /status
- Finalidade: diagnóstico geral do bot (uptime, servidores, cache).
- Quem pode usar: qualquer usuário.
- Onde usar: servidor ou DM.
- Parâmetros: nenhum.
- Resposta: pública (embed não ephemeral).
- Exemplo: /status
- Efeitos no banco: nenhum.
- Efeitos em cargo: nenhum.
- Efeitos na fila: nenhum.
- Limitações: métricas baseadas em cache em memória do client.

## /sub-grant
- Nome: /sub-grant
- Finalidade: conceder manualmente benefício SUB para elegibilidade.
- Quem pode usar: Administrator.
- Onde usar: servidor Discord.
- Parâmetros: usuario (user, obrigatório), motivo (string, obrigatório), dias (integer 1-365, opcional).
- Resposta: ephemeral.
- Exemplo: /sub-grant usuario:@Usuario motivo:Pix dias:30
- Efeitos no banco: cria registro em manual_sub_grants.
- Efeitos em cargo: recalcula elegibilidade e sincroniza automaticamente o cargo SUB do usuário.
- Efeitos na fila: não altera snapshot de prioridade de usuários já aguardando no ciclo atual.
- Limitações: não permite bots; bloqueia concessão duplicada ativa.

## /sub-grant-extend
- Nome: /sub-grant-extend
- Finalidade: estender administrativamente uma concessão manual existente de benefício SUB sem criar concessão paralela.
- Quem pode usar: Administrator.
- Onde usar: servidor Discord.
- Parâmetros: usuario (user, obrigatório), dias (integer 1-365, obrigatório), motivo (string 3-200, obrigatório).
- Resposta: ephemeral.
- Exemplo: /sub-grant-extend usuario:@Membro dias:20 motivo:Renovação via PIX
- Efeitos no banco: atualiza apenas `expires_at_ms` do registro manual mais recente e elegível para extensão, em transação única.
- Efeitos em cargo: após persistir a extensão, recalcula elegibilidade e sincroniza automaticamente o cargo SUB.
- Efeitos na fila: não altera snapshot de prioridade de usuários já aguardando no ciclo atual.
- Regra para concessão ativa: soma os dias ao vencimento atual (`novo_vencimento = vencimento_atual + dias`).
- Regra para concessão expirada naturalmente (não revogada): reativa a partir de agora (`novo_vencimento = agora + dias`).
- Concessão revogada: não é reativada por este comando; deve usar novo `/sub-grant`.
- Concessão inexistente: o comando não cria concessão implícita; orienta uso de `/sub-grant`.
- Concessão sem vencimento: não é convertida para temporária e retorna falha segura de não extensível.
- Auditoria administrativa obrigatória: registra tentativa e finalização (`success`, `failed` ou `denied`) com código seguro e saneamento de payload.
- Idempotência: mesma `interaction_id` não aplica extensão duas vezes e retorna resposta segura de interação já processada.

## /sub-revoke
- Nome: /sub-revoke
- Finalidade: revogar concessão manual SUB ativa.
- Quem pode usar: Administrator.
- Onde usar: servidor Discord.
- Parâmetros: usuario (user, obrigatório), motivo (string, obrigatório).
- Resposta: ephemeral.
- Exemplo: /sub-revoke usuario:@Usuario motivo:Encerrado
- Efeitos no banco: marca concessão ativa como revogada.
- Efeitos em cargo: recalcula elegibilidade (Kick OU manual) e sincroniza automaticamente o cargo SUB.
- Efeitos na fila: não altera snapshot de prioridade de usuários já aguardando no ciclo atual.
- Limitações: falha quando não existe concessão ativa.

## /sub-status
- Nome: /sub-status
- Finalidade: consultar elegibilidade SUB consolidada de um usuário (Kick + manual).
- Quem pode usar: Administrator.
- Onde usar: servidor Discord.
- Parâmetros: usuario (user, obrigatório).
- Resposta: ephemeral.
- Exemplo: /sub-status usuario:@Usuario
- Efeitos no banco: apenas leitura.
- Efeitos em cargo: nenhum direto (diagnóstico).
- Efeitos na fila: nenhum nesta etapa.
- Limitações: não sincroniza cargo diretamente; elegibilidade Kick depende de dados recebidos por webhook.

## /sub-sync
- Nome: /sub-sync
- Finalidade: sincronizar manualmente o cargo SUB de um usuário com base na elegibilidade atual (Kick OU concessão manual).
- Quem pode usar: Administrator.
- Onde usar: apenas no servidor configurado por GUILD_ID.
- Parâmetros: usuario (user, obrigatório), motivo (string, obrigatório).
- Resposta: ephemeral com defer/edit.
- Exemplo: /sub-sync usuario:@Usuario motivo:Sincronização manual
- Efeitos no banco: registra auditoria em subscriber_role_sync_audit.
- Efeitos em cargo: adiciona/remove apenas o cargo configurado por SUBSCRIBER_ROLE_ID quando aplicável.
- Efeitos na fila: não altera snapshot de prioridade de usuários já aguardando no ciclo atual.
- Limitações: permanece como ferramenta manual de diagnóstico/reconciliação mesmo com gatilhos automáticos.

## /sub-reconcile
- Nome: /sub-reconcile
- Finalidade: executar reconciliação em massa do cargo SUB para candidatos relevantes (vínculos Kick, histórico manual e membros com SUB).
- Quem pode usar: Administrator.
- Onde usar: apenas no servidor configurado por GUILD_ID.
- Parâmetros: motivo (string, obrigatório).
- Resposta: ephemeral com defer/edit.
- Exemplo: /sub-reconcile motivo:Reconciliação pós-instabilidade
- Efeitos no banco: preserva auditoria individual em subscriber_role_sync_audit e registra execução em subscriber_role_reconciliation_runs.
- Efeitos em cargo: adiciona/remove apenas o cargo configurado por SUBSCRIBER_ROLE_ID conforme elegibilidade central.
- Efeitos na fila: não altera snapshot de prioridade de usuários já aguardando no ciclo atual.
- Limitações: se uma execução já estiver em andamento, uma nova chamada é recusada com aviso de execução ativa.
- Limitações: quando a descoberta de membros com SUB estiver incompleta (falha/timeout do Discord), remoções são bloqueadas por segurança nessa execução; adições para elegíveis conhecidos continuam permitidas.
- Requisito operacional: para descoberta completa de membros do servidor, o bot usa GuildMembers intent e o Server Members Intent deve estar ativado no Discord Developer Portal.
- Resumo da resposta: inclui contagem total e por código seguro para ignorados/falhas; `member_not_found` entra como ignorado.

## Botão join_queue
- Nome: join_queue
- Finalidade: adicionar o usuário na fila.
- Quem pode usar: qualquer usuário que clique no botão.
- Onde usar: mensagem do painel/comando com botões.
- Parâmetros: nenhum.
- Resposta: ephemeral.
- Exemplo: clique em "Entrar na fila".
- Efeitos no banco: insere usuário na fila e possivelmente o move para lobby em formação.
- Efeitos em cargo: nenhum.
- Efeitos na fila: entra na fila; pode entrar direto em lobby em formação; prioridade SUB é snapshot calculado na entrada.
- Limitações: bloqueado com fila fechada; impede duplicidade; snapshot de prioridade não é recalculado durante o ciclo; usuário em lobby `forming` não pode reentrar.
- Usuário em lobby `in_game`: pode reentrar na fila no mesmo ciclo.
- Reentrada no mesmo ciclo: sair e entrar novamente reaproveita a mesma categoria já registrada para o ciclo atual.
- Novo ciclo: após reset do ciclo (ex.: /scheduler-open), a próxima entrada consulta elegibilidade novamente.
- Fonte da prioridade: elegibilidade central (Kick ativa OU concessão manual ativa) no momento da entrada, nunca presença de cargo Discord.
- Falha de elegibilidade na entrada: usuário entra como comum e sem prioridade indevida.

## Botão leave_queue
- Nome: leave_queue
- Finalidade: remover usuário da fila e de lobbies atuais.
- Quem pode usar: qualquer usuário que clique no botão.
- Onde usar: mensagem do painel/comando com botões.
- Parâmetros: nenhum.
- Resposta: ephemeral.
- Exemplo: clique em "Sair da fila".
- Efeitos no banco: remove usuário da fila/lobbies conforme regras do serviço.
- Efeitos em cargo: nenhum.
- Efeitos na fila: saída sujeita a cooldown.
- Limitações: respeita cooldown de saída.

## Painel permanente Vincular conta Kick
- Nome: Painel permanente Vincular conta Kick.
- Finalidade: disponibilizar um ponto fixo para usuários iniciarem o vínculo OAuth Kick no servidor.
- Quem pode usar: qualquer usuário que visualize o canal.
- Onde usar: canal configurado em KICK_LINK_CHANNEL_ID (mesmo servidor de GUILD_ID).
- Parâmetros: nenhum.
- Resposta: mensagem fixa do bot com dois botões (`Vincular conta Kick` e `💚 Consultar meu vínculo`).
- Exemplo: mensagem iniciando com "Vincule sua conta Kick".
- Efeitos no banco: nenhum direto no painel.
- Efeitos em cargo: o callback OAuth iniciado pelo painel pode sincronizar automaticamente o cargo SUB se houver fonte ativa.
- Efeitos na fila: nenhum.
- Limitações: se KICK_LINK_CHANNEL_ID estiver ausente, o painel é desativado e /kick-link continua funcionando.
- Operação recomendada do canal: negar "Enviar mensagens" para @everyone para manter o canal apenas de painel.

## Botão kick-link-start
- Nome: kick-link-start
- Finalidade: iniciar vínculo Kick de forma segura a partir do painel.
- Quem pode usar: qualquer usuário no servidor correto.
- Onde usar: painel permanente Vincular conta Kick.
- Parâmetros: nenhum.
- Resposta: ephemeral; se não vinculado, retorna botão/link "Autorizar na Kick" com URL temporária.
- Exemplo: clique em "Vincular conta Kick".
- Efeitos no banco: nenhum direto no clique; persistência ocorre no callback OAuth.
- Efeitos em cargo: após persistência do vínculo no callback, pode adicionar/manter/remover cargo SUB conforme elegibilidade final.
- Efeitos na fila: nenhum.
- Limitações: bloqueado em guild diferente do configurado; reutiliza o mesmo fluxo de /kick-link.

## Botão kick_link_status
- Nome: kick_link_status
- Finalidade: consultar o diagnóstico de vínculo/benefício Kick do próprio usuário a partir do painel.
- Quem pode usar: qualquer usuário no servidor correto.
- Onde usar: painel permanente Vincular conta Kick.
- Parâmetros: nenhum.
- Resposta: sempre ephemeral; consulta apenas o autor do clique e não aceita alvo de terceiro.
- Exemplo: clique em "💚 Consultar meu vínculo".
- Efeitos no banco: nenhum (somente leitura local).
- Efeitos em cargo: nenhum (não adiciona/remove/sincroniza cargo SUB).
- Efeitos na fila: nenhum.
- Limitações: não executa OAuth, não chama API externa da Kick e não substitui a consulta administrativa de terceiros via `/kick-status usuario:@Membro`.

## Botão kick-unlink-confirm:{token}
- Nome: kick-unlink-confirm:{token}
- Finalidade: confirmar desvinculação administrativa iniciada em /kick-unlink.
- Quem pode usar: somente o administrador que iniciou a confirmação.
- Onde usar: mensagem ephemeral de confirmação.
- Parâmetros: token embutido no customId.
- Resposta: update da mensagem com botões desabilitados.
- Exemplo: clique em "Confirmar desvinculação".
- Efeitos no banco: remove vínculo em kick_accounts e cria auditoria em kick_unlink_audit na mesma transação.
- Efeitos em cargo: após a transação de unlink+auditoria, recalcula elegibilidade e sincroniza o cargo SUB.
- Efeitos na fila: não altera snapshot de prioridade de usuários já aguardando no ciclo atual.
- Limitações: token expira, é de uso único e não pode ser usado por outro usuário.

## Botão kick-unlink-cancel:{token}
- Nome: kick-unlink-cancel:{token}
- Finalidade: cancelar desvinculação administrativa pendente.
- Quem pode usar: somente o administrador que iniciou a confirmação.
- Onde usar: mensagem ephemeral de confirmação.
- Parâmetros: token embutido no customId.
- Resposta: update da mensagem com botões desabilitados.
- Exemplo: clique em "Cancelar".
- Efeitos no banco: nenhum.
- Efeitos em cargo: nenhum.
- Efeitos na fila: nenhum.
- Limitações: token expira, é de uso único e não pode ser usado por outro usuário.

## Botão admin_open
- Nome: admin_open
- Finalidade: reservado para futura ação de abrir fila por botão.
- Quem pode usar: ainda não implementado.
- Onde usar: não aplicável no fluxo atual.
- Parâmetros: nenhum.
- Resposta: não implementada.
- Exemplo: não aplicável.
- Efeitos no banco: nenhum no estado atual.
- Efeitos em cargo: nenhum.
- Efeitos na fila: nenhum no estado atual.
- Limitações: arquivo contém TODO sem lógica ativa.

## Botão admin_close
- Nome: admin_close
- Finalidade: reservado para futura ação de fechar fila por botão.
- Quem pode usar: ainda não implementado.
- Onde usar: não aplicável no fluxo atual.
- Parâmetros: nenhum.
- Resposta: não implementada.
- Exemplo: não aplicável.
- Efeitos no banco: nenhum no estado atual.
- Efeitos em cargo: nenhum.
- Efeitos na fila: nenhum no estado atual.
- Limitações: arquivo contém TODO sem lógica ativa.
