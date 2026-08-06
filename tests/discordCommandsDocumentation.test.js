const fs = require('fs');
const path = require('path');

describe('documentação de comandos Discord', () => {
  const projectRoot = path.join(__dirname, '..');
  const commandsDir = path.join(projectRoot, 'src', 'commands');
  const discordCommandsDocPath = path.join(projectRoot, 'DISCORD_COMMANDS.md');
  const readmePath = path.join(projectRoot, 'README.md');

  function getRegisteredSlashCommandNames() {
    const files = fs.readdirSync(commandsDir).filter((file) => file.endsWith('.js'));

    return files
      .map((file) => {
        const fullPath = path.join(commandsDir, file);
        const source = fs.readFileSync(fullPath, 'utf8');
        const match = source.match(/\.setName\('([^']+)'\)/);
        if (!match) {
          throw new Error(`Não foi possível extrair setName() de ${file}.`);
        }
        return match[1];
      })
      .sort();
  }

  test('DISCORD_COMMANDS.md existe na raiz', () => {
    expect(fs.existsSync(discordCommandsDocPath)).toBe(true);
  });

  test('todos os slash commands registrados aparecem no DISCORD_COMMANDS.md', () => {
    const commandNames = getRegisteredSlashCommandNames();
    const doc = fs.readFileSync(discordCommandsDocPath, 'utf8');

    for (const commandName of commandNames) {
      expect(doc).toContain(`/${commandName}`);
    }
  });

  test('README referencia DISCORD_COMMANDS.md', () => {
    const readme = fs.readFileSync(readmePath, 'utf8');
    expect(readme).toContain('DISCORD_COMMANDS.md');
  });
});
