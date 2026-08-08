const fs = require('fs');
const path = require('path');

function listJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsFiles(fullPath));
      continue;
    }

    if (entry.isFile() && fullPath.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('production warnings cleanup', () => {
  const workspaceRoot = path.resolve(__dirname, '..');
  const srcRoot = path.join(workspaceRoot, 'src');

  test('src não usa mais opção ephemeral depreciada', () => {
    const source = listJsFiles(srcRoot)
      .map((filePath) => fs.readFileSync(filePath, 'utf8'))
      .join('\n');

    expect(source).not.toMatch(/ephemeral\s*:\s*(true|false)/);
  });

  test('editReply não redefine ephemerality', () => {
    const source = listJsFiles(srcRoot)
      .map((filePath) => fs.readFileSync(filePath, 'utf8'))
      .join('\n');

    expect(source).not.toMatch(/editReply\s*\(\s*\{[\s\S]{0,500}?ephemeral\s*:/);
  });

  test('bootstrap usa Events.ClientReady e não usa ready legado', () => {
    const bootstrapSource = fs.readFileSync(
      path.join(srcRoot, 'services', 'appBootstrapService.js'),
      'utf8',
    );

    expect(bootstrapSource).toContain('Events.ClientReady');
    expect(bootstrapSource).not.toContain("once('ready'");
    expect(bootstrapSource).not.toContain("removeListener('ready'");
  });

  test('mensagem antiga de status kick não permanece e nova descrição está presente', () => {
    const source = listJsFiles(srcRoot)
      .map((filePath) => fs.readFileSync(filePath, 'utf8'))
      .join('\n');

    expect(source).not.toContain('Cargo e prioridade ainda não são sincronizados nesta etapa.');
    expect(source).toContain('Cargo SUB: sincronizado por gatilhos automáticos e reconciliação periódica.');
    expect(source).toContain('Prioridade da fila: definida por snapshot na primeira entrada do usuário em cada ciclo.');
  });

  test('railway inicia runtime com node direto', () => {
    const railway = JSON.parse(
      fs.readFileSync(path.join(workspaceRoot, 'railway.json'), 'utf8'),
    );

    expect(railway.deploy.startCommand).toBe('node src/index.js');
  });
});
