const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const MAX_TARGETS_DISPLAYED = 4;
const MAX_CONTEXT_LENGTH = 60;
const DISCORD_CONTENT_LIMIT = 2000;

// Allowlist explícita: somente estas chaves podem representar um alvo humano.
// Nenhuma varredura genérica do JSON é feita, para não expor Kick ID, IDs internos,
// interaction ID, channel ID ou qualquer outro identificador não humano.
const TARGET_CONTRACT_BY_COMMAND = {
  'lobby-remove': [
    {
      role: 'target',
      label: 'Alvo',
      idKeys: ['targetDiscordId', 'usuario', 'usuarioDiscordId', 'lobbyDiscordId'],
    },
  ],
  'sub-grant-extend': [
    {
      role: 'target',
      label: 'Alvo',
      idKeys: ['targetDiscordId', 'usuario', 'usuarioDiscordId'],
    },
  ],
  'kick-status': [
    {
      role: 'target',
      label: 'Alvo',
      idKeys: ['targetDiscordId', 'usuario', 'usuarioDiscordId'],
    },
  ],
  'lobby-swap': [
    {
      role: 'user_a',
      label: 'Usuário A',
      idKeys: ['usuarioADiscordId', 'usuario_a', 'usuario_lobby', 'lobbyDiscordId'],
      originKeys: ['origemADetalhe', 'origemA'],
      destinationKeys: ['destinoADetalhe', 'destinoA'],
    },
    {
      role: 'user_b',
      label: 'Usuário B',
      idKeys: ['usuarioBDiscordId', 'usuario_b', 'usuario_fila', 'queueDiscordId'],
      originKeys: ['origemBDetalhe', 'origemB'],
      destinationKeys: ['destinoBDetalhe', 'destinoB'],
    },
  ],
};

function isDiscordSnowflake(value) {
  return typeof value === 'string' && DISCORD_SNOWFLAKE_PATTERN.test(value.trim());
}

function readSnowflake(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }

    for (const key of keys) {
      const raw = source[key];
      const normalized = raw === null || raw === undefined ? '' : String(raw).trim();
      if (isDiscordSnowflake(normalized)) {
        return normalized;
      }
    }
  }

  return null;
}

function readContext(sources, keys) {
  if (!Array.isArray(keys) || !keys.length) {
    return null;
  }

  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }

    for (const key of keys) {
      const raw = source[key];
      if (typeof raw !== 'string') {
        continue;
      }

      const normalized = raw
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[<>@]/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (normalized) {
        return normalized.slice(0, MAX_CONTEXT_LENGTH);
      }
    }
  }

  return null;
}

function readLobbyNumbers(sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }

    const raw = source.lobbiesEnvolvidas;
    if (!Array.isArray(raw)) {
      continue;
    }

    const numbers = raw
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
      .slice(0, MAX_TARGETS_DISPLAYED);

    if (numbers.length) {
      return numbers;
    }
  }

  return [];
}

function extractAuditTargets({ commandName, nextState, parameters } = {}) {
  const contract = TARGET_CONTRACT_BY_COMMAND[String(commandName || '').trim()];
  if (!contract) {
    return [];
  }

  // nextState primeiro: representa o resultado final já saneado da operação.
  const sources = [nextState, parameters];

  return contract
    .map((entry) => {
      const discordId = readSnowflake(sources, entry.idKeys);
      if (!discordId) {
        return null;
      }

      return {
        type: 'discord_user',
        role: entry.role,
        label: entry.label,
        discordId,
        origin: readContext(sources, entry.originKeys),
        destination: readContext(sources, entry.destinationKeys),
      };
    })
    .filter(Boolean)
    .slice(0, MAX_TARGETS_DISPLAYED);
}

function buildTargetContextSuffix(target) {
  const parts = [];
  if (target.origin) {
    parts.push(`origem: ${target.origin}`);
  }
  if (target.destination) {
    parts.push(`destino: ${target.destination}`);
  }

  return parts.length ? ` — ${parts.join(' -> ')}` : '';
}

function buildAuditTargetLines({ commandName, nextState, parameters } = {}) {
  const targets = extractAuditTargets({ commandName, nextState, parameters });
  if (!targets.length) {
    return [];
  }

  if (targets.length === 1) {
    const [target] = targets;
    return [`Alvo: <@${target.discordId}>${buildTargetContextSuffix(target)}`, `ID do alvo: ${target.discordId}`];
  }

  const lines = ['Alvos:'];
  for (const target of targets) {
    lines.push(`${target.label}: <@${target.discordId}> — ID: ${target.discordId}${buildTargetContextSuffix(target)}`);
  }

  const lobbyNumbers = readLobbyNumbers([nextState, parameters]);
  if (lobbyNumbers.length) {
    lines.push(`Lobbies envolvidas: ${lobbyNumbers.map((value) => `#${value}`).join(', ')}`);
  }

  return lines;
}

function capDiscordContent(content) {
  const normalized = String(content || '');
  if (normalized.length <= DISCORD_CONTENT_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, DISCORD_CONTENT_LIMIT - 1)}…`;
}

module.exports = {
  DISCORD_CONTENT_LIMIT,
  isDiscordSnowflake,
  extractAuditTargets,
  buildAuditTargetLines,
  capDiscordContent,
};
