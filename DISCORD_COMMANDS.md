Este documento deve ser atualizado sempre que qualquer comando slash, botão ou regra de interação do Discord for criado, removido ou alterado no código.

# Comandos e Interações do Discord

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
- Parâmetros: nenhum.
- Resposta: ephemeral com defer/edit.
- Exemplo: /kick-events-sync
- Efeitos no banco: nenhum direto; sincronização ocorre na API da Kick.
- Efeitos em cargo: nenhum.
- Efeitos na fila: nenhum.
- Limitações: depende de configuração Kick válida e disponibilidade da API externa.

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
- Finalidade: mostrar vínculo Kick, estado da assinatura Kick, concessão manual e elegibilidade final do próprio usuário.
- Quem pode usar: qualquer usuário.
- Onde usar: servidor Discord.
- Parâmetros: nenhum.
- Resposta: ephemeral.
- Exemplo: /kick-status
- Efeitos no banco: apenas leitura.
- Efeitos em cargo: nenhum.
- Efeitos na fila: nenhum.
- Limitações: não sincroniza cargo/fila nesta etapa; depende de eventos webhook para observar assinatura Kick.

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
- Quem pode usar: Administrator ou Manage Guild.
- Onde usar: servidor Discord.
- Parâmetros: quantidade (integer 1-4, obrigatório).
- Resposta: ephemeral.
- Exemplo: /lobby-form-force quantidade:4
- Efeitos no banco: move/consome jogadores da fila e cria lobby em formação.
- Efeitos em cargo: nenhum.
- Efeitos na fila: reduz fila e atualiza painel.
- Limitações: falha se não houver jogadores suficientes.

## /lobby-start
- Nome: /lobby-start
- Finalidade: iniciar lobby que está em formação.
- Quem pode usar: Manage Guild.
- Onde usar: servidor Discord.
- Parâmetros: numero (integer, opcional).
- Resposta: ephemeral.
- Exemplo: /lobby-start numero:3
- Efeitos no banco: altera estado da lobby para iniciada.
- Efeitos em cargo: nenhum.
- Efeitos na fila: atualiza painel.
- Limitações: se houver várias lobbies em formação e numero não for informado, apenas lista opções.

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
- Limitações: ação administrativa.

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
- Limitações: ação administrativa.

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
- Limitações: bloqueado com fila fechada; impede duplicidade; snapshot de prioridade não é recalculado durante o ciclo.
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
- Resposta: mensagem fixa do bot com um único botão.
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
