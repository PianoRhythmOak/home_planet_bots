/**
 * All the verification behaviour lives here. Commands and components are thin
 * wrappers that call into this.
 */

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  DiscordAPIError,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  TimestampStyles,
  time,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type TextChannel,
  type ThreadChannel,
  type User,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import type { BotContext } from '../../lib/types.js';
import type { TicketDecision, TicketRow, TicketStore } from './store.js';

const log = createLogger('verification');

export const IDS = {
  start: 'verify:start',
  approve: 'verify:approve',
  deny: 'verify:deny',
  close: 'verify:close',
  denyModal: 'verify:deny-modal',
  denyReason: 'verify:deny-reason',
} as const;

export const COLOURS = {
  brand: 0x9b59b6,
  ok: 0x2ecc71,
  bad: 0xe74c3c,
  muted: 0x95a5a6,
} as const;

/** Single source of truth for the store instance, set during feature setup. */
let store: TicketStore;
export function bindStore(s: TicketStore): void {
  store = s;
}
export function getStore(): TicketStore {
  return store;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function isStaff(member: GuildMember, staffRoleIds: string[]): boolean {
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  return staffRoleIds.some((id) => member.roles.cache.has(id));
}

/**
 * Fetch a thread even when it's archived.
 *
 * Discord evicts archived threads from the cache, so `cache.get()` returns
 * undefined for threads that still exist. Always confirm with the API before
 * concluding a thread is gone — otherwise we orphan real threads and open duplicates.
 *
 * The three-way result matters: "gone" and "couldn't check" must not be treated
 * the same. A 500 or a rate-limit abort is not proof the thread was deleted, and
 * acting as if it were would drop the DB row while the thread lives on forever.
 */
export type ThreadLookup =
  | { state: 'found'; thread: ThreadChannel }
  | { state: 'gone' }
  | { state: 'unknown' };

export async function lookupThread(guild: Guild, threadId: string): Promise<ThreadLookup> {
  const cached = guild.channels.cache.get(threadId);
  if (cached?.isThread()) return { state: 'found', thread: cached };
  try {
    const fetched = await guild.channels.fetch(threadId);
    if (fetched?.isThread()) return { state: 'found', thread: fetched };
    return { state: 'gone' }; // fetch resolved, but there's nothing there
  } catch (err) {
    if (err instanceof DiscordAPIError && (err.code === 10003 || err.code === 50001)) {
      return { state: 'gone' }; // Unknown Channel / lost access — treat as gone
    }
    log.warn(`Could not check thread ${threadId} (will retry later):`, err);
    return { state: 'unknown' };
  }
}

/** Convenience wrapper for callers that only care about the happy path. */
export async function resolveThread(guild: Guild, threadId: string): Promise<ThreadChannel | null> {
  const result = await lookupThread(guild, threadId);
  return result.state === 'found' ? result.thread : null;
}

export function panelComponents(label: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.start)
      .setLabel(label)
      .setEmoji('🪐')
      .setStyle(ButtonStyle.Success),
  );
}

export function staffControls(disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.approve)
      .setLabel('Approve')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(IDS.deny)
      .setLabel('Deny')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(IDS.close)
      .setLabel('Close (no decision)')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

/**
 * Plain-text transcript. Attachments are described rather than linked unless
 * transcriptIncludeAttachments is on — see the privacy note in the README.
 */
export async function buildTranscript(
  thread: ThreadChannel,
  ctx: BotContext,
): Promise<AttachmentBuilder | null> {
  const cfg = ctx.config.verification;
  if (!cfg.logTranscripts) return null;

  const messages: Message[] = [];
  try {
    let before: string | undefined;
    // Discord caps a fetch at 100; page backwards until we run out.
    for (let page = 0; page < 20; page++) {
      const batch = await thread.messages.fetch(before ? { limit: 100, before } : { limit: 100 });
      if (batch.size === 0) break;
      messages.push(...batch.values());
      const last = batch.last();
      if (!last || batch.size < 100) break;
      before = last.id;
    }
  } catch (err) {
    log.warn(`Transcript fetch failed for ${thread.id}:`, err);
  }

  messages.reverse(); // oldest first

  const lines = [
    `Transcript — ${thread.name}`,
    `Thread ID: ${thread.id}`,
    `Generated: ${new Date().toISOString()}`,
    '-'.repeat(60),
    '',
  ];

  for (const msg of messages) {
    const stamp = msg.createdAt.toISOString().replace('T', ' ').slice(0, 19);
    lines.push(`[${stamp}] ${msg.author.tag} (${msg.author.id}): ${msg.content}`.trimEnd());
    for (const embed of msg.embeds) {
      if (embed.title || embed.description) {
        lines.push(`    (embed) ${embed.title ?? ''} — ${(embed.description ?? '').slice(0, 300)}`);
      }
    }
    for (const att of msg.attachments.values()) {
      lines.push(
        cfg.transcriptIncludeAttachments
          ? `    (attachment) ${att.name} -> ${att.url}`
          : `    (attachment omitted: ${att.name}, ${att.size} bytes)`,
      );
    }
  }

  return new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), {
    name: `transcript-${thread.id}.txt`,
  });
}

interface LogOptions {
  title: string;
  colour: number;
  applicant: User | GuildMember | null;
  applicantId: string;
  staff: User | null;
  reason?: string | null;
  thread?: ThreadChannel | null;
  notes?: string[];
  transcript?: AttachmentBuilder | null;
}

export async function writeLog(ctx: BotContext, opts: LogOptions): Promise<void> {
  const { logChannelId } = ctx.config.verification;
  if (!logChannelId) return;

  const channel = await ctx.client.channels.fetch(logChannelId).catch(() => null);
  if (!channel?.isTextBased() || !('send' in channel)) {
    log.warn(`logChannelId ${logChannelId} is not a channel I can post in.`);
    return;
  }

  const user = opts.applicant && 'user' in opts.applicant ? opts.applicant.user : opts.applicant;
  const embed = new EmbedBuilder()
    .setTitle(opts.title)
    .setColor(opts.colour)
    .setTimestamp(new Date())
    .addFields({
      name: 'Member',
      value: `<@${opts.applicantId}>${user ? ` — \`${user.tag}\`` : ''}\nID: \`${opts.applicantId}\``,
    });

  embed.addFields({
    name: 'Handled by',
    value: opts.staff ? `${opts.staff.toString()} — \`${opts.staff.tag}\`` : '*system*',
    inline: true,
  });
  if (opts.thread) {
    embed.addFields({
      name: 'Thread',
      value: `\`${opts.thread.name}\`\nID: \`${opts.thread.id}\``,
      inline: true,
    });
  }
  if (opts.reason) embed.addFields({ name: 'Reason / notes', value: opts.reason.slice(0, 1024) });
  if (opts.notes?.length) embed.addFields({ name: 'Notes', value: opts.notes.join('\n').slice(0, 1024) });
  if (user) embed.setThumbnail(user.displayAvatarURL());

  // Embed and transcript go separately: an oversized transcript must not take the
  // audit record down with it.
  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log.warn('Failed to write to log channel:', err);
    return;
  }

  if (opts.transcript) {
    try {
      await channel.send({
        content: `Transcript — <@${opts.applicantId}>`,
        files: [opts.transcript],
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      log.warn('Transcript upload failed (log entry itself was saved):', err);
      await channel
        .send({
          content: `⚠️ Transcript for <@${opts.applicantId}> was too large to upload.`,
          allowedMentions: { parse: [] },
        })
        .catch(() => null);
    }
  }
}

// ---------------------------------------------------------------------------
// opening a ticket
// ---------------------------------------------------------------------------

/** Guilds whose full member list we've pulled at least once this process. */
const memberCacheWarmed = new Set<string>();

/**
 * `role.members` reads the member CACHE only — it never fetches. Discord's
 * large_threshold means offline members aren't cached after a restart, so
 * without this warm-up the bot silently adds nobody and offline staff can't
 * see the thread at all.
 */
export async function warmMemberCache(guild: Guild): Promise<void> {
  if (memberCacheWarmed.has(guild.id)) return;
  try {
    await guild.members.fetch();
    memberCacheWarmed.add(guild.id);
    log.info(`Cached ${guild.members.cache.size} members for ${guild.name}`);
  } catch (err) {
    log.warn(`Could not fetch the member list for ${guild.name}:`, err);
  }
}

async function addStaffToThread(thread: ThreadChannel, guild: Guild, ctx: BotContext): Promise<void> {
  const cfg = ctx.config.verification;
  if (!cfg.addStaffToThread || cfg.staffRoleIds.length === 0) return;

  await warmMemberCache(guild);

  const seen = new Set<string>();
  let added = 0;
  for (const roleId of cfg.staffRoleIds) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    if (role.members.size === 0) {
      log.warn(`Staff role "${role.name}" has no members I can see — nobody will be added to threads.`);
      continue;
    }
    for (const member of role.members.values()) {
      if (member.user.bot || seen.has(member.id)) continue;
      seen.add(member.id);
      if (added >= cfg.maxStaffAdded) {
        log.warn(`Hit maxStaffAdded (${cfg.maxStaffAdded}) for thread ${thread.id}`);
        return;
      }
      try {
        await thread.members.add(member.id);
        added++;
      } catch {
        /* one staff member failing shouldn't block the rest */
      }
    }
  }
}

export async function openTicket(interaction: ButtonInteraction, ctx: BotContext): Promise<void> {
  const cfg = ctx.config.verification;
  const { guild } = interaction;
  const member = interaction.member as GuildMember | null;

  if (!guild || !member) {
    await interaction.reply({
      content: 'This only works inside the server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (cfg.verifiedRoleId && member.roles.cache.has(cfg.verifiedRoleId)) {
    await interaction.reply({
      content: "You're already verified. 🪐",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = store.openForUser(guild.id, member.id);
  if (existing) {
    const lookup = await lookupThread(guild, existing.thread_id);
    if (lookup.state === 'found') {
      await interaction.reply({
        content: `You already have a verification thread open: ${lookup.thread.toString()}\nStaff will get to you as soon as they can.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (lookup.state === 'unknown') {
      // Discord didn't answer. Opening a second thread here would leave the first
      // one live and invisible to us, so wait it out instead.
      await interaction.reply({
        content: "I can't reach Discord to check your existing thread. Try again in a minute.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    store.remove(existing.thread_id); // confirmed gone
  }

  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: 'The panel needs to live in a normal text channel. Ping an admin.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const safeName = (member.user.username.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) || 'member');
  let thread: ThreadChannel;
  try {
    thread = await (channel as TextChannel).threads.create({
      name: `verify-${safeName}`,
      type: ChannelType.PrivateThread,
      invitable: false,
      // 7 days, so Discord doesn't archive the thread out from under us before
      // staleThreadHours (default 24) gets a chance to expire it.
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `Verification for ${member.user.tag} (${member.id})`,
    });
  } catch (err) {
    if (err instanceof DiscordAPIError && (err.code === 50013 || err.code === 50001)) {
      await interaction.editReply(
        "I don't have permission to create private threads here. Please tell an admin to give me " +
          '**Create Private Threads**, **Send Messages in Threads** and **Manage Threads** in this channel.',
      );
      return;
    }
    log.error('Thread creation failed:', err);
    await interaction.editReply('Something broke opening your thread. Staff have been logged an error.');
    return;
  }

  store.create(thread.id, guild.id, channel.id, member.id);

  await thread.members.add(member.id).catch(() => {
    log.warn(`Could not add ${member.user.tag} to thread ${thread.id}`);
  });
  await addStaffToThread(thread, guild, ctx);

  const intro = new EmbedBuilder()
    .setTitle('Verification')
    .setDescription(cfg.threadIntro.replaceAll('{user}', member.toString()).replaceAll('{server}', guild.name))
    .setColor(COLOURS.brand)
    .setThumbnail(member.displayAvatarURL())
    .setFooter({ text: `User ID: ${member.id}` })
    .setTimestamp(new Date())
    .addFields(
      {
        name: 'Account created',
        value: time(member.user.createdAt, TimestampStyles.RelativeTime),
        inline: true,
      },
      {
        name: 'Joined server',
        value: member.joinedAt ? time(member.joinedAt, TimestampStyles.RelativeTime) : 'unknown',
        inline: true,
      },
    );

  const ping = cfg.pingStaffOnOpen ? cfg.staffRoleIds.map((id) => `<@&${id}>`).join(' ') : '';
  await thread
    .send({
      content: `${member.toString()} ${ping}`.trim(),
      embeds: [intro],
      components: [staffControls()],
      allowedMentions: { users: [member.id], roles: cfg.staffRoleIds },
    })
    .catch((err: unknown) => log.warn('Could not post intro in thread:', err));

  await interaction.editReply(
    `Your private verification thread is open: ${thread.toString()} — head over there. 🪐`,
  );

  await writeLog(ctx, {
    title: '🆕 Verification opened',
    colour: COLOURS.muted,
    applicant: member,
    applicantId: member.id,
    staff: null,
    thread,
  });
}

// ---------------------------------------------------------------------------
// closing a ticket
// ---------------------------------------------------------------------------

const TITLES: Record<TicketDecision, string> = {
  approved: '✅ Verification approved',
  denied: '❌ Verification denied',
  closed: '🗑️ Verification closed (no decision)',
  expired: '⏳ Verification expired',
  left: '🚪 Verification abandoned (member left)',
};

export async function finalizeTicket(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  ctx: BotContext,
  decision: Extract<TicketDecision, 'approved' | 'denied' | 'closed'>,
  reason: string | null,
): Promise<void> {
  const cfg = ctx.config.verification;
  const thread = interaction.channel;

  if (!thread?.isThread() || !interaction.guild) {
    await interaction.reply({
      content: 'These buttons only work inside a verification thread.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const row = store.get(thread.id);
  if (!row) {
    await interaction.reply({
      content:
        "I don't have a record for this thread — it may predate a restart. You can delete it manually.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const delay = Math.max(0, cfg.deleteDelaySeconds);

  // Defer BEFORE claiming. If the ack fails (a laggy gateway can push us past the
  // 3-second window into a 10062), a ticket claimed first would be stuck 'closing'
  // with no role granted, no log written and no way for staff to retry.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Claim with no await in between. Two staff hitting Approve at the same time, or
  // Approve and Deny together, would otherwise both pass a plain status check and
  // do everything twice — double roles, double logs, double deletes.
  if (!store.claim(thread.id)) {
    await interaction.editReply("This one's already been handled — it's on its way out.");
    return;
  }

  const guild = interaction.guild;
  const member = await guild.members.fetch(row.user_id).catch(() => null);
  const notes: string[] = [];

  if (decision === 'approved') {
    if (!member) {
      notes.push('⚠️ Member left the server before approval — no roles were given.');
    } else {
      if (cfg.verifiedRoleId) {
        const role = guild.roles.cache.get(cfg.verifiedRoleId);
        if (!role) {
          notes.push('⚠️ Verified role not found (bad ID in config).');
        } else {
          try {
            await member.roles.add(role, `Verified by ${interaction.user.tag}`);
          } catch (err) {
            notes.push(
              err instanceof DiscordAPIError && err.code === 50013
                ? "⚠️ Couldn't add the verified role — my role must sit **above** it in Server Settings → Roles."
                : `⚠️ Adding verified role failed: ${(err as Error).message}`,
            );
          }
        }
      }
      if (cfg.unverifiedRoleId && member.roles.cache.has(cfg.unverifiedRoleId)) {
        await member.roles
          .remove(cfg.unverifiedRoleId, `Verified by ${interaction.user.tag}`)
          .catch(() => notes.push("⚠️ Couldn't remove the unverified role."));
      }
    }
  }

  if (decision === 'denied' && cfg.kickOnDeny && member) {
    // Safe to kick here: the ticket is already claimed, so the guildMemberRemove
    // handler will find nothing to do and won't double-log.
    try {
      await member.kick(`Verification denied by ${interaction.user.tag}: ${reason ?? 'no reason given'}`);
      notes.push('Member was kicked (kickOnDeny is on).');
    } catch (err) {
      notes.push(
        err instanceof DiscordAPIError && err.code === 50013
          ? '⚠️ Couldn\'t kick — I need **Kick Members** and a higher role.'
          : `⚠️ Kick failed: ${(err as Error).message}`,
      );
    }
  }

  const blurb =
    decision === 'approved'
      ? cfg.approvedMessage
      : decision === 'denied'
        ? cfg.deniedMessage
        : 'This thread was closed by staff without a decision.';
  const colour =
    decision === 'approved' ? COLOURS.ok : decision === 'denied' ? COLOURS.bad : COLOURS.muted;

  await thread
    .send({
      embeds: [
        new EmbedBuilder()
          .setDescription(blurb)
          .setColor(colour)
          .setFooter({ text: `Deleting in ${delay}s • handled by ${interaction.user.tag}` }),
      ],
    })
    .catch(() => null);

  const transcript = await buildTranscript(thread, ctx);
  await writeLog(ctx, {
    title: TITLES[decision],
    colour,
    applicant: member,
    applicantId: row.user_id,
    staff: interaction.user,
    reason,
    thread,
    notes,
    transcript,
  });

  // Only now is the real delete time written — everything above (transcript paging
  // especially) had to finish first, or the janitor could have deleted the thread
  // out from under it.
  store.finish(thread.id, decision, interaction.user.id, reason, new Date(Date.now() + delay * 1000));

  await interaction.editReply(
    [`Marked **${decision}**. Thread deletes in ${delay}s.`, ...notes].join('\n'),
  );

  // Grey out the buttons so nobody wonders whether it registered. A modal submit
  // isn't a message component, but it does carry the message it was opened from.
  const sourceMessage = interaction.isMessageComponent()
    ? interaction.message
    : interaction.isFromMessage()
      ? interaction.message
      : null;
  await sourceMessage?.edit({ components: [staffControls(true)] }).catch(() => null);

  setTimeout(() => {
    void deleteThread(ctx, row.thread_id, row.guild_id);
  }, delay * 1000).unref();
}

export async function deleteThread(ctx: BotContext, threadId: string, guildId: string): Promise<void> {
  const guild = ctx.client.guilds.cache.get(guildId) ?? (await ctx.client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;

  const lookup = await lookupThread(guild, threadId);
  if (lookup.state === 'unknown') return; // couldn't check — the janitor will retry
  if (lookup.state === 'gone') {
    store.remove(threadId);
    return;
  }
  const thread = lookup.thread;

  try {
    await thread.delete('Verification finished');
    store.remove(threadId);
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === 10003) {
      store.remove(threadId); // deleted by someone else
      return;
    }
    if (err instanceof DiscordAPIError && (err.code === 50013 || err.code === 50001)) {
      // Never going to succeed on its own — park it rather than retry every 2 minutes forever.
      log.warn(`Missing Manage Threads — cannot delete thread ${threadId}. Parking it.`);
      store.fail(threadId, 'no Manage Threads permission');
      return;
    }
    const tries = store.bumpAttempts(threadId);
    log.warn(`Deleting thread ${threadId} failed (attempt ${tries}):`, err);
    if (tries >= 5) store.fail(threadId, `gave up after ${tries} delete attempts`);
  }
}

// ---------------------------------------------------------------------------
// automatic closes
// ---------------------------------------------------------------------------

export async function expireTicket(ctx: BotContext, row: TicketRow, hours: number): Promise<void> {
  if (!store.claim(row.thread_id)) return; // staff got to it first

  const guild = ctx.client.guilds.cache.get(row.guild_id) ?? null;
  const thread = guild ? await resolveThread(guild, row.thread_id) : null;
  const member = guild ? await guild.members.fetch(row.user_id).catch(() => null) : null;

  let transcript: AttachmentBuilder | null = null;
  if (thread) {
    transcript = await buildTranscript(thread, ctx);
    await thread
      .send({
        embeds: [
          new EmbedBuilder()
            .setDescription(`⏳ No decision in ${hours}h — closing automatically.`)
            .setColor(COLOURS.muted),
        ],
      })
      .catch(() => null);
  }

  await writeLog(ctx, {
    title: TITLES.expired,
    colour: COLOURS.muted,
    applicant: member,
    applicantId: row.user_id,
    staff: null,
    reason: `No staff decision within ${hours} hours.`,
    thread,
    transcript,
  });

  store.finish(row.thread_id, 'expired', null, 'timed out', new Date());
}

export async function abandonTicket(ctx: BotContext, member: GuildMember): Promise<void> {
  const row = store.openForUser(member.guild.id, member.id);
  if (!row) return;
  // If staff just denied-with-kick, finalizeTicket already claimed this ticket and
  // the claim below fails — which is exactly what stops the duplicate log entry.
  if (!store.claim(row.thread_id)) return;

  const thread = await resolveThread(member.guild, row.thread_id);
  let transcript: AttachmentBuilder | null = null;
  if (thread) {
    transcript = await buildTranscript(thread, ctx);
    await thread
      .send({
        embeds: [
          new EmbedBuilder()
            .setDescription('🚪 This member left the server. Closing.')
            .setColor(COLOURS.muted),
        ],
      })
      .catch(() => null);
  }

  await writeLog(ctx, {
    title: TITLES.left,
    colour: COLOURS.muted,
    applicant: member,
    applicantId: member.id,
    staff: null,
    reason: 'Member left the server with a verification thread open.',
    thread,
    transcript,
  });

  store.finish(row.thread_id, 'left', null, 'member left', new Date(Date.now() + 30_000));
}
