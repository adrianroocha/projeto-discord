# Projeto Discord Bot

Estrutura inicial de um bot para Discord usando `discord.js` v14, `SQLite` e `dotenv`.

## Estrutura do projeto

- `src/` - código fonte do bot
- `src/config/` - configuração e variáveis de ambiente
- `src/commands/` - comandos do Discord
- `src/events/` - eventos do Discord
- `src/handlers/` - carregamento e registro de comandos/eventos
- `src/structures/` - classes customizadas ou extensões do client
- `src/utils/` - utilitários gerais
- `src/database/` - cliente e configuração do SQLite
- `data/` - arquivos de runtime, incluindo o banco SQLite
- `tests/` - testes automatizados

## Instalação

1. Instale [Node.js](https://nodejs.org/) e `npm`.
2. No terminal, execute:

```bash
npm install
```

3. Copie o arquivo de ambiente:

```bash
cp .env.example .env
```

4. Preencha as variáveis no `.env`.

## Scripts úteis

- `npm start` - inicia o bot
- `npm run dev` - inicia em modo de desenvolvimento com `nodemon`
- `npm run lint` - valida arquivos com ESLint
- `npm run format` - formata arquivos com Prettier
- `npm test` - executa testes com Jest

## Observação

A lógica do bot ainda não foi implementada; os arquivos atuais são apenas a base de projeto.
