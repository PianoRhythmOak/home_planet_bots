/**
 * Dependency-free levelled logger. Swap the sinks here if you ever want to ship
 * logs somewhere (a webhook, a file, Sentry) — every bot goes through this.
 */

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LEVELS)[number];

const COLOURS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

function envLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  return (LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : 'info';
}

let threshold: LogLevel = envLevel();

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

function enabled(level: LogLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(threshold);
}

function emit(level: LogLevel, scope: string, args: unknown[]): void {
  if (!enabled(level)) return;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const tag = `${COLOURS[level]}${level.toUpperCase().padEnd(5)}${RESET}`;
  const line = `${stamp} ${tag} [${scope}]`;
  if (level === 'error') console.error(line, ...args);
  else if (level === 'warn') console.warn(line, ...args);
  else console.log(line, ...args);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('bot');
