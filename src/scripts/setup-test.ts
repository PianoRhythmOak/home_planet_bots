/**
 * Creates a hidden testing area inside a real server and writes the IDs into
 * config.dev.json, so `npm run dev` points at test channels and test roles
 * instead of the live ones.
 *
 *   npm run setup:test                      -- uses guildId from config.json
 *   npm run setup:test -- --guild 123…      -- explicit server
 *   npm run setup:test -- --admin 456…      -- also grant yourself access
 *   npm run setup:test -- --prefix qa       -- name things qa-* instead of test-*
 *
 * Safe to re-run: anything that already exists by name is reused, permissions are
 * merged rather than replaced, and nothing is ever deleted.
 *
 * Logs in as the DEV bot when DEV_DISCORD_TOKEN is set — the test area has to be
 * visible to whichever bot `npm run dev` runs as, which is not the hosted one.
 */

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  OverwriteType,
  PermissionFlagsBits,
  type CategoryChannel,
  type GuildChannel,
  type Guild,
  type PermissionOverwriteOptions,
  type Role,
  type TextChannel,
} from 'discord.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, ROOT_DIR } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('setup:test');
const REASON = 'Verification bot test setup';

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  const next = process.argv[i + 1];
  if (i !== -1 && next && !next.startsWith('--')) return next;
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  // `|| undefined`, not `??` — `--prefix=` must fall back to the default rather
  // than creating channels literally named "-verification".
  return inline?.slice(flag.length + 1) || undefined;
}

const config = loadConfig();
const guildId = arg('guild') ?? config.guildId;
const adminId = arg('admin');
const rawPrefix = arg('prefix') ?? 'test';

// Discord lowercases text channel names and turns spaces into hyphens. Comparing
// against the un-normalised string would miss on re-runs and pile up duplicates.
const prefix = rawPrefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'test';
if (prefix !== rawPrefix) log.info(`Prefix normalised to "${prefix}" (Discord lowercases channel names).`);

const FLAG_NAMES = new Map<bigint, string>(
  Object.entries(PermissionFlagsBits).map(([name, bit]) => [bit, name]),
);

interface Owned {
  id: string;
  type: OverwriteType;
  allow: bigint[];
  deny: bigint[];
}

/** Boolean map form, for permissionOverwrites.edit() — merges instead of replacing. */
function asEditOptions(o: Owned): PermissionOverwriteOptions {
  const out: Record<string, boolean> = {};
  for (const bit of o.allow) out[FLAG_NAMES.get(bit)!] = true;
  for (const bit of o.deny) out[FLAG_NAMES.get(bit)!] = false;
  return out as PermissionOverwriteOptions;
}

/**
 * Apply only the overwrites this script owns, leaving any that a human added by
 * hand alone. permissionOverwrites.set() would delete those.
 */
async function mergeOverwrites(channel: GuildChannel, owned: Owned[]): Promise<void> {
  for (const o of owned) {
    await channel.permissionOverwrites.edit(o.id, asEditOptions(o), { type: o.type, reason: REASON });
  }
}

async function findOrCreateRole(guild: Guild, name: string): Promise<Role> {
  const existing = guild.roles.cache.find((r) => r.name === name);
  if (existing) {
    log.info(`Role "${name}" already exists — reusing (${existing.id})`);
    return existing;
  }
  const role = await guild.roles.create({
    name,
    // Deliberately no permissions and no colour: markers for testing, not roles
    // that should be able to do anything server-wide.
    permissions: [],
    mentionable: false,
    reason: REASON,
  });
  log.info(`Created role "${name}" (${role.id})`);
  return role;
}

async function main(): Promise<void> {
  if (!guildId) {
    log.error('No server id. Set guildId in config.json or pass --guild <id>.');
    process.exitCode = 1;
    return;
  }

  // The test area must be usable by the bot that `npm run dev` logs in as.
  const devToken = process.env['DEV_DISCORD_TOKEN']?.trim();
  if (devToken) log.info('Using DEV_DISCORD_TOKEN — the test area will belong to your dev bot.');
  else log.warn('No DEV_DISCORD_TOKEN set — setting up as the production bot instead.');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  // The listener must be attached BEFORE login(). discord.js emits ClientReady
  // while login() is still settling, so registering it afterwards misses the
  // event entirely and the await below never resolves — a silent forever-hang.
  const ready = new Promise<void>((done) => client.once(Events.ClientReady, () => done()));
  await client.login(devToken || config.token);
  await ready;

  try {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      log.error(`I'm not in a server with id ${guildId}, or I can't see it.`);
      log.error('Invite this bot to the server first, then re-run.');
      process.exitCode = 1;
      return;
    }
    log.info(`Working in "${guild.name}"`);

    // Populate the caches the find() calls rely on, so re-running reuses what
    // exists instead of creating duplicates.
    await guild.channels.fetch();
    await guild.roles.fetch();

    const me = await guild.members.fetchMe();
    if (
      !me.permissions.has(PermissionFlagsBits.ManageChannels) ||
      !me.permissions.has(PermissionFlagsBits.ManageRoles)
    ) {
      log.error('I need Manage Channels and Manage Roles to build the test area.');
      process.exitCode = 1;
      return;
    }

    // A raw snowflake can't be turned into an overwrite unless discord.js has the
    // user cached — resolve() is cache-only and throws otherwise.
    if (adminId) {
      const user = await client.users.fetch(adminId).catch(() => null);
      if (!user) {
        log.error(`--admin ${adminId} isn't a user I can find. Check the ID (right-click → Copy User ID).`);
        process.exitCode = 1;
        return;
      }
      log.info(`Granting access to ${user.tag}`);
    }

    // --- roles -------------------------------------------------------------
    const verifiedRole = await findOrCreateRole(guild, `${prefix}-verified`);
    const unverifiedRole = await findOrCreateRole(guild, `${prefix}-unverified`);
    const staffRole = await findOrCreateRole(guild, `${prefix}-staff`);

    // --- the overwrites we own ---------------------------------------------
    const owned: Owned[] = [
      {
        id: guild.roles.everyone.id,
        type: OverwriteType.Role,
        allow: [],
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: me.id,
        type: OverwriteType.Member,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageThreads,
          PermissionFlagsBits.CreatePrivateThreads,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
        ],
        deny: [],
      },
      {
        id: staffRole.id,
        type: OverwriteType.Role,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.ReadMessageHistory,
          // So test staff see the private threads without being added to each one.
          PermissionFlagsBits.ManageThreads,
        ],
        deny: [],
      },
      ...(adminId
        ? [
            {
              id: adminId,
              type: OverwriteType.Member,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.SendMessagesInThreads,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageThreads,
              ],
              deny: [],
            } satisfies Owned,
          ]
        : []),
    ];

    const createPayload = owned.map((o) => ({
      id: o.id,
      type: o.type,
      allow: o.allow,
      deny: o.deny,
    }));

    // --- hidden category ---------------------------------------------------
    const categoryName = `🔧 ${prefix}ing`;
    let category = guild.channels.cache.find(
      (c): c is CategoryChannel => c.type === ChannelType.GuildCategory && c.name === categoryName,
    );

    if (category) {
      log.info(`Category "${categoryName}" already exists — reusing (${category.id})`);
      await mergeOverwrites(category, owned);
    } else {
      category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: createPayload,
        reason: REASON,
      });
      log.info(`Created hidden category "${categoryName}" (${category.id})`);
    }

    // --- channels ----------------------------------------------------------
    async function findOrCreateChannel(name: string, topic: string): Promise<TextChannel> {
      const existing = guild!.channels.cache.find(
        (c): c is TextChannel =>
          c.type === ChannelType.GuildText && c.name === name && c.parentId === category!.id,
      );
      if (existing) {
        log.info(`Channel #${name} already exists — reusing (${existing.id})`);
        await mergeOverwrites(existing, owned);
        return existing;
      }
      // Overwrites are set explicitly rather than trusting category inheritance —
      // a channel that silently ends up world-visible would put private
      // verification threads in a public channel.
      const channel = await guild!.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category!.id,
        topic,
        permissionOverwrites: createPayload,
        reason: REASON,
      });
      log.info(`Created #${name} (${channel.id})`);
      return channel;
    }

    const verifyChannel = await findOrCreateChannel(
      `${prefix}-verification`,
      'Testing area for the verification bot. Run /verifypanel here.',
    );
    const logChannel = await findOrCreateChannel(
      `${prefix}-verify-logs`,
      'Test output from the verification bot.',
    );

    // --- write config.dev.json --------------------------------------------
    const devPath = resolve(ROOT_DIR, 'config.dev.json');
    let existing: Record<string, unknown> = {};
    if (existsSync(devPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(devPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        log.warn('Existing config.dev.json is not valid JSON — replacing it.');
      }
    }

    const devConfig = {
      ...existing,
      _comment:
        'Written by `npm run setup:test`. Layered on top of config.json when you run `npm run dev`. ' +
        'Safe to edit, and safe to delete — deleting it just means dev runs against production config.',
      guildId: guild.id,
      databasePath: './data/bot.dev.db',
      statusText: '🔧 testing',
      verification: {
        ...((existing['verification'] as Record<string, unknown>) ?? {}),
        channelId: verifyChannel.id,
        logChannelId: logChannel.id,
        staffRoleIds: [staffRole.id],
        verifiedRoleId: verifiedRole.id,
        unverifiedRoleId: unverifiedRole.id,
        // Fast feedback while testing: threads vanish quickly, nothing lingers overnight.
        deleteDelaySeconds: 15,
        staleThreadHours: 1,
        kickOnDeny: false,
      },
    };

    writeFileSync(devPath, `${JSON.stringify(devConfig, null, 2)}\n`, 'utf8');
    log.info(`Wrote ${devPath}`);

    const hierarchyWarning =
      me.roles.highest.comparePositionTo(verifiedRole) > 0
        ? ''
        : `\n  ⚠️  Drag my role ABOVE "${verifiedRole.name}" in Server Settings → Roles, or I can't grant it.\n`;

    console.log(`
Done. Your test area in "${guild.name}":

  category      ${categoryName}   (hidden from @everyone)
  channels      #${verifyChannel.name}, #${logChannel.name}
  roles         ${verifiedRole.name}, ${unverifiedRole.name}, ${staffRole.name}
${hierarchyWarning}
Next:
  1. Give yourself the "${staffRole.name}" role so you can press Approve/Deny.
  2. npm run dev
  3. In #${verifyChannel.name}: /verifycheck, then /verifypanel
  4. Click the button from an alt account, or ask another admin to.
`);
  } finally {
    // No process.exit() — it would truncate the output above when stdout is piped.
    await client.destroy();
  }
}

main().catch((err: unknown) => {
  log.error('Setup failed:', err);
  process.exitCode = 1;
});
