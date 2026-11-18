# Runbook de Backup e Restore SQLite

## Objetivo

Este runbook descreve o procedimento seguro para:

- criar backups consistentes do SQLite com o bot online;
- validar integridade dos backups;
- restaurar backup somente com o bot offline;
- reduzir risco de corrupção e sobrescrita parcial.

## Configuração

Variáveis opcionais:

- `SQLITE_BACKUP_ENABLED` (padrão `true`)
- `SQLITE_BACKUP_DIRECTORY` (padrão `./backups`)
- `SQLITE_BACKUP_TIME` (padrão `08:15`, formato `HH:MM`)
- `SQLITE_BACKUP_TIMEZONE` (padrão `America/Sao_Paulo`)
- `SQLITE_BACKUP_RETENTION_DAYS` (padrão `7`)
- `SQLITE_BACKUP_STARTUP_DELAY_SECONDS` (padrão `60`)

## Estratégia de backup consistente

1. O processo principal mantém conexão SQLite aberta (`better-sqlite3`).
2. O backup usa API própria do SQLite (`db.backup(...)`), não `copyFile` de arquivo aberto.
3. O backup é criado em arquivo temporário no diretório de backup.
4. O temporário é validado com `PRAGMA integrity_check` em modo read-only.
5. Somente com integridade `ok` ocorre rename atômico para o nome final.
6. Falhas limpam somente arquivos temporários do próprio backup.
7. O banco ativo nunca é removido/modificado durante backup.

## Operação diária automática

- Scheduler diário roda no timezone IANA configurado.
- Horário padrão: `08:15` em `America/Sao_Paulo`.
- Se o bot iniciar após o horário e ainda não houver execução válida do dia, dispara uma única execução após `SQLITE_BACKUP_STARTUP_DELAY_SECONDS`.
- Estado diário é persistido para evitar duplicidade após restart.
- Falha dispara retry controlado (sem loop rápido).

## Retenção

- Atua apenas dentro de `SQLITE_BACKUP_DIRECTORY` resolvido.
- Remove apenas arquivos com padrão `database-YYYY-MM-DD_HH-mm-ss.sqlite`.
- Não remove recursivamente.
- Não remove `DATABASE_PATH`.
- Arquivos não relacionados são preservados.
- Falha de retenção não invalida backup já concluído.

## Auditoria

Tabela: `app_sqlite_backup_runs`.

Campos registrados:

- `trigger_type`
- `started_at_ms`
- `finished_at_ms`
- `file_name`
- `size_bytes`
- `integrity_result`
- `result`
- `error_code`
- `created_at_ms`

Sem conteúdo de tabelas, sem secrets.

## Backup manual (CLI)

Executar:

```bash
npm run db:backup
```

Status:

```bash
npm run db:backup:status
```

O status lista e valida os arquivos sem abrir o banco ativo. Por isso, não consulta
`app_sqlite_backup_runs`; os resultados de execução gravados somente nessa tabela
não ficam disponíveis nesse comando.

O CLI de backup exige que o arquivo do banco já exista e adquire o lock
operacional antes de abrir a conexão. Ele não inicializa o esquema nem executa
migrações. Se o bot estiver usando o banco, o comando falha sem abrir outra
conexão.

## Restore offline (CLI)

### Regras críticas

- Bot totalmente desligado.
- Obrigatório `--confirm`.
- Origem validada e restrita ao diretório de backup configurado.
- Path traversal e links simbólicos para fora do diretório de backups são bloqueados.
- O restore adquire o lock operacional antes de qualquer acesso ao banco e o
  mantém durante verificações, backup pré-restore, troca e rollback.
- No encerramento normal, o processo proprietário remove seu próprio lock.
  Locks de outras instâncias ou abandonados nunca são removidos automaticamente,
  ainda que antigos, com PID não encontrado ou com metadados Railway diferentes.
- Se o rollback falhar (`RESTORE_ROLLBACK_FAILED`), o processo termina com erro,
  mantém o lock e preserva os arquivos disponíveis para recuperação. O banco
  exige intervenção manual; não inicie outra instância nem remova o lock até
  confirmar e recuperar manualmente o estado do banco.
- A presença de `-wal`, `-shm` ou `-journal` ao lado do banco bloqueia o restore;
  os arquivos auxiliares não são removidos automaticamente.
- Backup pré-restore obrigatório antes de substituir.
- Swap controlado com arquivo temporário no diretório do banco.
- Em falha, rollback para o banco anterior.

### Comando

```bash
npm run db:restore -- --file <nome-ou-caminho-controlado> --confirm
```

### Fluxo seguro

1. Validar `--confirm`.
2. Validar origem e `PRAGMA integrity_check` da origem.
3. Adquirir o lock operacional e verificar sidecars e lock exclusivo SQLite.
4. Criar e validar backup pré-restore.
5. Preparar arquivo temporário de restore.
6. Trocar arquivos por rename controlado.
7. Validar banco restaurado.
8. Se validação final falhar, tentar rollback do banco anterior.
9. Se não for possível confirmar o rollback, terminar com erro, preservar os
   arquivos disponíveis e manter o lock para impedir novas instâncias.

## Lock abandonado e recuperação manual

Um lock existente sempre bloqueia novas conexões. O timestamp, o estado do PID e
os metadados Railway servem apenas para diagnóstico e não autorizam a remoção
automática.

O processo proprietário remove seu próprio lock ao encerrar normalmente. Um
lock mantido por falha crítica de rollback (`RESTORE_ROLLBACK_FAILED`) indica que
o estado do banco não pôde ser confirmado: os arquivos devem ser avaliados e
recuperados manualmente antes de qualquer nova inicialização. Locks de outras
instâncias ou abandonados também nunca são removidos automaticamente.

Para recuperar um lock abandonado:

1. Pare o serviço do bot e confirme no Railway que a instância está parada; não
   basta iniciar um segundo deploy ou observar um PID ausente.
2. Confirme que não há outra instância nem processo CLI usando esse `DATABASE_PATH`.
3. Faça uma cópia preservando o arquivo `<DATABASE_PATH>.lock` para diagnóstico.
4. Remova manualmente somente esse lock, sem remover ou editar o banco e seus
   arquivos auxiliares.
5. Inicie o serviço e confirme que ele adquiriu o lock e abriu o banco.

Se não for possível confirmar que todos os processos pararam, não remova o lock.
O bootstrap e os CLIs falharão de forma segura e exigirão intervenção operacional.

O comando `db:backup:status` não abre o banco nem remove ou inspeciona locks. Ele
valida cada arquivo de backup diretamente e informa que a auditoria de execuções
armazenada no banco ativo não foi consultada.

## Integração com shutdown gracioso

Ordem de shutdown:

1. Marcar shutdown.
2. Parar novos agendamentos de backup.
3. Aguardar backup em andamento até `SHUTDOWN_TIMEOUT_MS`.
4. Encerrar HTTP/Discord.
5. Fechar SQLite.
6. Remover lock operacional.

## Limitação importante

Backups no mesmo disco não protegem contra perda total do host/disco.

Próxima etapa recomendada:

- copiar diretório de backups para armazenamento externo criptografado.
