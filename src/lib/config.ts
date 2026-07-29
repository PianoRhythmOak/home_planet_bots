/**
 * Config loading: defaults <- config.json <- .env / environment variables.
 *
 * Env wins so you can keep the token out of the JSON file. IDs are strings
 * throughout — Discord snowflakes exceed Number.MAX_SAFE_INTEGER, and reading
 * them as numbers silently corrupts them.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';

const log = createLogger('config');

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface VerificationConfig {
  channelId: string;
  logChannelId: string;
  staffRoleIds: string[];
  verifiedRoleId: string;
  unverifiedRoleId: string;
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

  config.token = str('DISCORD_TOKEN', str('BOT_TOKEN', str('TOKEN', config.token)));
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

export function loadConfig(): BotConfig {
  loadDotEnv();

  const path = resolve(ROOT_DIR, 'config.json');
  let fromFile: unknown = {};
  if (existsSync(path)) {
    try {
      fromFile = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      log.error(`config.json is not valid JSON: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    log.warn('No config.json found — using defaults and environment variables only.');
  }

  const config = envOverrides(deepMerge(DEFAULTS, fromFile));
  validate(config);
  return config;
}
