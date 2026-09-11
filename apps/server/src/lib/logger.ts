import { env, isTest } from '../env.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const threshold = isTest
  ? LEVEL_ORDER.warn
  : env.NODE_ENV === 'production'
    ? LEVEL_ORDER.info
    : LEVEL_ORDER.debug;

// Built from a char code so the source file stays free of raw control bytes.
const CSI = String.fromCharCode(27) + '[';
const COLOUR: Record<Level, string> = {
  debug: `${CSI}90m`,
  info: `${CSI}36m`,
  warn: `${CSI}33m`,
  error: `${CSI}31m`,
};
const DIM = `${CSI}90m`;
const RESET = `${CSI}0m`;

const useColour =
  env.NODE_ENV !== 'production' && process.stdout.isTTY === true;

function consoleFor(level: Level) {
  return level === 'debug' ? console.log : console[level];
}

function serialise(meta: unknown): unknown {
  if (meta instanceof Error) {
    return { name: meta.name, message: meta.message, stack: meta.stack };
  }
  return meta;
}

function emit(level: Level, scope: string, message: string, meta?: unknown) {
  if (LEVEL_ORDER[level] < threshold) return;
  const write = consoleFor(level);

  if (env.NODE_ENV === 'production') {
    // Structured single-line JSON so log shippers can parse it.
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg: message,
    };
    if (meta !== undefined) record.meta = serialise(meta);
    write(JSON.stringify(record));
    return;
  }

  const time = new Date().toTimeString().slice(0, 8);
  const label = level.toUpperCase().padEnd(5);
  const prefix = useColour
    ? `${COLOUR[level]}${label}${RESET} ${time} ${DIM}[${scope}]${RESET}`
    : `${label} ${time} [${scope}]`;

  if (meta !== undefined) write(prefix, message, serialise(meta));
  else write(prefix, message);
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit('debug', scope, m, meta),
    info: (m, meta) => emit('info', scope, m, meta),
    warn: (m, meta) => emit('warn', scope, m, meta),
    error: (m, meta) => emit('error', scope, m, meta),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('sonder');
