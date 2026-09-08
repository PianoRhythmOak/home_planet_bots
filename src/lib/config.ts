/**
 * Config loading: defaults <- config.json <- config.dev.json (dev only) <- env.
 *
 * Env wins so you can keep the token out of the JSON file. IDs are strings
 * throughout — Discord snowflakes exceed Number.MAX_SAFE_INTEGER, and reading
 * them as numbers silently corrupts them.
 *
 * Dev mode is `--dev` on the command line (what `npm run dev` passes) or
 * BOT_ENV=dev. A CLI flag rather than an inline env var because `FOO=bar cmd`
 * doesn't work in PowerShell or cmd, and this project lives on Windows.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';

const log = createLogger('config');

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const IS_DEV =
  process.argv.includes('--dev') || process.env['BOT_ENV']?.toLowerCase() === 'dev';

export interface VerificationConfig {
  channelId: string;
  logChannelId: string;
  staffRoleIds: string[];
  verifiedRoleId: string;
  unverifiedRoleId: string;
  assignUnverifiedOnJoin: boolean;
  welcomeDmOnJoin: boolean;
  deleteDelaySeconds: number;
  staleThreadHours: number;
  kickOnDeny: boolean;
  pingStaffOnOpen: boolean;
  addStaffToThread: boolean;
  maxStaffAdded: number;
  logTranscripts: boolean;
  transcriptIncludeAttachments: boolean;
  panelTitle: string;
  panelDescription: string;
  panelButtonLabel: string;
  threadIntro: string;
  approvedMessage: string;
  deniedMessage: string;
  welcomeDmMessage: string;
}

export interface BotConfig {
  token: string;
  guildId: string;
  databasePath: string;
  statusText: string;
  verification: VerificationConfig;
}

const DEFAULTS: BotConfig = {
  token: '',
  guildId: '',
  databasePath: './data/bot.db',
  statusText: 'verifying baddies 🪐',
  verification: {
    channelId: '',
    logChannelId: '',
    staffRoleIds: [],
    verifiedRoleId: '',
    unverifiedRoleId: '',
    assignUnverifiedOnJoin: true,
    // Off by default: a bot DM to every single joiner is the kind of thing that
    // gets an application rate-limited, and most people have DMs from servers
    // switched off anyway. Turn it on if the panel channel is easy to miss.
    welcomeDmOnJoin: false,
    deleteDelaySeconds: 60,
    staleThreadHours: 24,
    kickOnDeny: false,
    pingStaffOnOpen: true,
    addStaffToThread: true,
    maxStaffAdded: 15,
    logTranscripts: true,
    transcriptIncludeAttachments: false,
    panelTitle: 'Welcome to Home Planet 🪐',
    panelDescription:
      "This server is **21+**. Before you get access, a member of staff needs to confirm you're a real, of-age human.\n\n" +
      "Press the button below and we'll open a **private thread** — just you and staff. Nobody else in the server can see it. " +
      'It gets deleted once you\'re done.\n\nIt usually takes a few minutes. Be patient with us. 💅',
    panelButtonLabel: 'Start Verification',
    threadIntro:
      'Hey {user}! 👋 A staff member will be with you shortly.\n\n' +
      '**What happens next:** staff will ask you a couple of quick questions to confirm you\'re a real person and 21 or older.\n\n' +
      'This thread is private and will be **deleted** when we\'re finished.',
    approvedMessage: "✅ You're verified — welcome to Home Planet! This thread will close shortly.",
    deniedMessage: "❌ Your verification wasn't approved. This thread will close shortly.",
    welcomeDmMessage:
      'Welcome to **{server}**! 🪐\n\n' +
      "This server is **21+**, so there's one step before you get in: head to {channel} and press " +
      '**Start Verification**. That opens a private thread with staff — just you and them.',
  },
};

/** Minimal .env reader — avoids a dependency for something this small. */
function loadDotEnv(): void {
  const path = resolve(ROOT_DIR, '.env');
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith('_')) continue; // `_comment` keys in config.json
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

function envOverrides(config: BotConfig): BotConfig {
  const v = config.verification;
  const str = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

  // A dev-only token, so the local instance can run as a SEPARATE bot application
  // while the hosted one stays live. Two processes on one token both receive every
  // interaction and both act on it.
  const devToken = process.env['DEV_DISCORD_TOKEN']?.trim();
  if (IS_DEV && devToken) {
    config.token = devToken;
  } else {
    if (IS_DEV) {
      log.warn(
        'DEV_DISCORD_TOKEN is not set, so dev mode is using the PRODUCTION token. If the hosted ' +
          'bot is also running, both will answer every interaction — two threads, two log entries, ' +
          'two of everything. Make a second bot application for development.',
      );
    }
    config.token = str('DISCORD_TOKEN', str('BOT_TOKEN', str('TOKEN', config.token)));
  }
  config.guildId = str('GUILD_ID', config.guildId);
  config.databasePath = str('DATABASE_PATH', config.databasePath);

  v.channelId = str('VERIFICATION_CHANNEL_ID', v.channelId);
  v.logChannelId = str('LOG_CHANNEL_ID', v.logChannelId);
  v.verifiedRoleId = str('VERIFIED_ROLE_ID', v.verifiedRoleId);
  v.unverifiedRoleId = str('UNVERIFIED_ROLE_ID', v.unverifiedRoleId);

  const staff = process.env['STAFF_ROLE_IDS'];
  if (staff) {
    v.staffRoleIds = staff
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return config;
}

/** Snowflakes must be digit strings. Catches the classic "pasted the role name" mistake. */
function validate(config: BotConfig): void {
  const problems: string[] = [];
  if (!config.token) {
    problems.push(
      'No bot token. Put DISCORD_TOKEN in .env (preferred) or "token" in config.json.',
    );
  }

  const snowflake = /^\d{17,20}$/;
  const check = (label: string, value: string, required = false): void => {
    if (!value) {
      if (required) problems.push(`${label} is not set.`);
      return;
    }
    if (!snowflake.test(value)) problems.push(`${label} is "${value}", which is not a Discord ID.`);
  };

  check('guildId', config.guildId);
  check('verification.channelId', config.verification.channelId);
  check('verification.logChannelId', config.verification.logChannelId);
  check('verification.verifiedRoleId', config.verification.verifiedRoleId);
  check('verification.unverifiedRoleId', config.verification.unverifiedRoleId);
  config.verification.staffRoleIds.forEach((id, i) => check(`verification.staffRoleIds[${i}]`, id));

  if (problems.length > 0) {
    for (const p of problems) log.error(p);
    if (!config.token) process.exit(1);
    log.warn('Continuing with the problems above — expect things to misbehave until they are fixed.');
  }
}

function readJson(name: string, required: boolean): unknown {
  const path = resolve(ROOT_DIR, name);
  if (!existsSync(path)) {
    if (required) log.warn(`No ${name} found — using defaults and environment variables only.`);
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    log.error(`${name} is not valid JSON: ${(err as Error).message}`);
    process.exit(1);
  }
}

export function loadConfig(): BotConfig {
  loadDotEnv();

  let merged = deepMerge(DEFAULTS, readJson('config.json', true));

  if (IS_DEV) {
    const devPath = resolve(ROOT_DIR, 'config.dev.json');
    if (!existsSync(devPath)) {
      log.warn('─'.repeat(70));
      log.warn('DEV MODE but no config.dev.json — this will run against your REAL channels');
      log.warn('and roles. Run `npm run setup:test` to create test ones. Continuing anyway.');
      log.warn('─'.repeat(70));
    }

    // Dev overrides sit on top: test channel, test roles, separate database.
    const dev: unknown = readJson('config.dev.json', false);
    merged = deepMerge(merged, dev);

    // Never share a database with production, even if config.dev.json forgot to
    // say so — a dev run would otherwise delete real pending verification threads.
    // DATABASE_PATH is checked here too: envOverrides() runs after this block and
    // would otherwise put us straight back onto the production file.
    const devSetsPath = isPlainObject(dev) && 'databasePath' in dev;
    if (!devSetsPath && !process.env['DATABASE_PATH']?.trim()) {
      merged.databasePath = merged.databasePath.replace(/(\.[^.\\/]+)?$/, '.dev$1');
    } else if (!devSetsPath) {
      log.warn(
        'DATABASE_PATH is set in the environment, so dev mode would share the production database. ' +
          'Unset it, or set databasePath in config.dev.json.',
      );
    }

    // Testing happens in the live server, so make the destructive option
    // impossible to leave on by accident.
    if (merged.verification.kickOnDeny) {
      log.warn('kickOnDeny is force-disabled in dev mode — a test deny will not kick anyone.');
      merged.verification.kickOnDeny = false;
    }
  }

  const config = envOverrides(merged);
  validate(config);

  if (IS_DEV) {
    log.warn('╔══════════════════════════════════════════════════╗');
    log.warn('║  DEV MODE — config.dev.json overrides are active ║');
    log.warn('╚══════════════════════════════════════════════════╝');
    log.warn(`  database:    ${config.databasePath}`);
    log.warn(`  channel:     ${config.verification.channelId || '(unset)'}`);
    log.warn(`  log channel: ${config.verification.logChannelId || '(unset)'}`);
    log.warn(`  verified:    ${config.verification.verifiedRoleId || '(unset)'}`);
  }

  return config;
}
