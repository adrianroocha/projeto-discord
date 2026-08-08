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

Tabela: `sqlite_backup_runs`.

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

## Restore offline (CLI)

### Regras críticas

- Bot totalmente desligado.
- Obrigatório `--confirm`.
- Origem validada e restrita ao diretório de backup configurado.
- Path traversal bloqueado.
- Lock operacional ativo bloqueia restore.
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
3. Detectar uso ativo (lock operacional e tentativa de lock exclusivo).
4. Criar e validar backup pré-restore.
5. Preparar arquivo temporário de restore.
6. Trocar arquivos por rename controlado.
7. Validar banco restaurado.
8. Se validação final falhar, tentar rollback do banco anterior.

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
