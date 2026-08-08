function parseTimeLabel(rawValue, label) {
  if (typeof rawValue !== 'string') {
    throw new Error(`${label} inválido: formato esperado HH:MM.`);
  }

  const normalized = rawValue.trim();
  const match = normalized.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error(`${label} inválido: formato esperado HH:MM.`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`${label} inválido: hora fora do intervalo 00-23.`);
  }

  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`${label} inválido: minuto fora do intervalo 00-59.`);
  }

  return {
    raw: normalized,
    hour,
    minute,
    totalMinutes: hour * 60 + minute,
  };
}

function assertValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) {
    throw new Error('QUEUE_TIMEZONE inválido: valor ausente.');
  }

  try {
    Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch (_error) {
    throw new Error(`QUEUE_TIMEZONE inválido: ${timeZone}.`);
  }
}

function createPartsFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

function formatToLocalParts(formatter, dateMs) {
  const sourceDate = new Date(dateMs);
  const parts = formatter.formatToParts(sourceDate);
  const bag = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      bag[part.type] = part.value;
    }
  }

  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function localKeyFromParts(parts) {
  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localTimeMinutes(parts) {
  return parts.hour * 60 + parts.minute;
}

function parseLocalDateKey(localDateKey) {
  const match = String(localDateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Chave de data local inválida: ${localDateKey}.`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function addDaysToLocalDateKey(localDateKey, deltaDays) {
  const parsed = parseLocalDateKey(localDateKey);
  const utcMs = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  const shifted = new Date(utcMs + deltaDays * 24 * 60 * 60 * 1000);
  const year = String(shifted.getUTCFullYear()).padStart(4, '0');
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toUtcFromLocal({ year, month, day, hour, minute, second = 0 }, formatter) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = formatToLocalParts(formatter, guess);
    const desiredUtcShape = Date.UTC(year, month - 1, day, hour, minute, second);
    const currentUtcShape = Date.UTC(
      current.year,
      current.month - 1,
      current.day,
      current.hour,
      current.minute,
      current.second,
    );

    const diff = desiredUtcShape - currentUtcShape;
    if (diff === 0) {
      return guess;
    }

    guess += diff;
  }

  return guess;
}

function toUtcFromLocalKeyAndTime(localDateKey, timeValue, formatter) {
  const baseDate = parseLocalDateKey(localDateKey);
  return toUtcFromLocal(
    {
      year: baseDate.year,
      month: baseDate.month,
      day: baseDate.day,
      hour: timeValue.hour,
      minute: timeValue.minute,
      second: 0,
    },
    formatter,
  );
}

function formatInTimeZone(dateMs, timeZone) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'medium',
    hourCycle: 'h23',
  }).format(new Date(dateMs));
}

function computeScheduleSnapshot(options) {
  const nowMs = Number(options?.nowMs);
  const safeNowMs = Number.isFinite(nowMs) ? Math.trunc(nowMs) : Date.now();

  const timeZone = options?.timeZone;
  const openTime = parseTimeLabel(options?.openTime, 'QUEUE_OPEN_TIME');
  const closeTime = parseTimeLabel(options?.closeTime, 'QUEUE_CLOSE_TIME');

  if (openTime.totalMinutes === closeTime.totalMinutes) {
    throw new Error('QUEUE_OPEN_TIME e QUEUE_CLOSE_TIME não podem ser iguais.');
  }

  assertValidTimeZone(timeZone);

  const formatter = createPartsFormatter(timeZone);
  const localNowParts = formatToLocalParts(formatter, safeNowMs);
  const localNowKey = localKeyFromParts(localNowParts);
  const nowMinutes = localTimeMinutes(localNowParts);

  const crossesMidnight = openTime.totalMinutes > closeTime.totalMinutes;
  let isOpenScheduled = false;
  let currentCycleKey = null;
  let currentOpenAtMs = null;
  let currentCloseAtMs = null;

  if (crossesMidnight) {
    if (nowMinutes >= openTime.totalMinutes) {
      isOpenScheduled = true;
      currentCycleKey = localNowKey;
      currentOpenAtMs = toUtcFromLocalKeyAndTime(localNowKey, openTime, formatter);
      currentCloseAtMs = toUtcFromLocalKeyAndTime(
        addDaysToLocalDateKey(localNowKey, 1),
        closeTime,
        formatter,
      );
    } else if (nowMinutes < closeTime.totalMinutes) {
      isOpenScheduled = true;
      currentCycleKey = addDaysToLocalDateKey(localNowKey, -1);
      currentOpenAtMs = toUtcFromLocalKeyAndTime(currentCycleKey, openTime, formatter);
      currentCloseAtMs = toUtcFromLocalKeyAndTime(localNowKey, closeTime, formatter);
    }
  } else if (nowMinutes >= openTime.totalMinutes && nowMinutes < closeTime.totalMinutes) {
    isOpenScheduled = true;
    currentCycleKey = localNowKey;
    currentOpenAtMs = toUtcFromLocalKeyAndTime(localNowKey, openTime, formatter);
    currentCloseAtMs = toUtcFromLocalKeyAndTime(localNowKey, closeTime, formatter);
  }

  let nextOpenAtMs;
  let nextCloseAtMs;
  let nextTransitionAtMs;

  if (isOpenScheduled) {
    nextTransitionAtMs = currentCloseAtMs;
    nextCloseAtMs = currentCloseAtMs;
    const nextCycleKey = addDaysToLocalDateKey(currentCycleKey, 1);
    nextOpenAtMs = toUtcFromLocalKeyAndTime(nextCycleKey, openTime, formatter);
  } else if (crossesMidnight) {
    const nextOpenKey = nowMinutes >= closeTime.totalMinutes ? localNowKey : addDaysToLocalDateKey(localNowKey, -1);
    const adjustedNextOpenKey = nowMinutes >= openTime.totalMinutes ? addDaysToLocalDateKey(localNowKey, 1) : localNowKey;
    const openKey = nowMinutes >= openTime.totalMinutes ? adjustedNextOpenKey : nextOpenKey;
    nextOpenAtMs = toUtcFromLocalKeyAndTime(openKey, openTime, formatter);
    const closeKey = addDaysToLocalDateKey(openKey, 1);
    nextCloseAtMs = toUtcFromLocalKeyAndTime(closeKey, closeTime, formatter);
    nextTransitionAtMs = nextOpenAtMs;
  } else {
    const openKey = nowMinutes < openTime.totalMinutes ? localNowKey : addDaysToLocalDateKey(localNowKey, 1);
    nextOpenAtMs = toUtcFromLocalKeyAndTime(openKey, openTime, formatter);
    nextCloseAtMs = toUtcFromLocalKeyAndTime(openKey, closeTime, formatter);
    nextTransitionAtMs = nextOpenAtMs;
  }

  return {
    nowMs: safeNowMs,
    timeZone,
    openTime: openTime.raw,
    closeTime: closeTime.raw,
    crossesMidnight,
    isOpenScheduled,
    expectedState: isOpenScheduled ? 'open' : 'closed',
    currentCycleKey,
    currentOpenAtMs,
    currentCloseAtMs,
    nextOpenAtMs,
    nextCloseAtMs,
    nextTransitionAtMs,
    localNowKey,
    localNowParts,
  };
}

module.exports = {
  parseTimeLabel,
  assertValidTimeZone,
  computeScheduleSnapshot,
  formatInTimeZone,
  addDaysToLocalDateKey,
};
