import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Guild,
  type GuildBasedChannel,
  type TextChannel,
} from 'discord.js';
import type { Command } from '../../lib/types.js';
import { COLOURS, getStore, panelComponents } from './service.js';

const verifypanel: Command = {
  data: new SlashCommandBuilder()
    .setName('verifypanel')
    .setDescription('Post the verification panel in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  async execute(interaction, ctx) {
    const cfg = ctx.config.verification;
    if (!interaction.inGuild() || interaction.channel?.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: "Run this in a normal text channel — private threads can't be made anywhere else.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(cfg.panelTitle)
      .setDescription(cfg.panelDescription)
      .setColor(COLOURS.brand)
      .setFooter({ text: 'Home Planet • 21+ only' });

    await (interaction.channel as TextChannel).send({
      embeds: [embed],
      components: [panelComponents(cfg.panelButtonLabel)],
    });
    await interaction.reply({ content: 'Panel posted. ✨', flags: MessageFlags.Ephemeral });
  },
};

const verifyopen: Command = {
  data: new SlashCommandBuilder()
    .setName('verifyopen')
    .setDescription('List verification threads still waiting on staff.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({
        content: 'This only works inside the server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const rows = getStore().open(interaction.guildId);
    if (rows.length === 0) {
      await interaction.reply({
        content: 'Nothing pending. Clean slate. 🪐',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const lines = rows.slice(0, 20).map((row) => {
      const ms = Date.now() - Date.parse(row.created_at);
      const hrs = Math.floor(ms / 3_600_000);
      const mins = Math.floor((ms % 3_600_000) / 60_000);
      return `• <#${row.thread_id}> — <@${row.user_id}> — waiting ${hrs}h ${mins}m`;
    });

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Open verifications (${rows.length})`)
          .setDescription(lines.join('\n'))
          .setColor(COLOURS.brand),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

const verifycheck: Command = {
  data: new SlashCommandBuilder()
    .setName('verifycheck')
    .setDescription("Check the bot's config and permissions are correct.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  async execute(interaction, ctx) {
    const guild = interaction.guild as Guild | null;
    if (!guild) {
      await interaction.reply({
        content: 'This only works inside the server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const cfg = ctx.config.verification;
    const me = await guild.members.fetchMe();
    const out: string[] = [];
    const mark = (ok: boolean, text: string): string => `${ok ? '✅' : '❌'} ${text}`;

    const verifyChannel: GuildBasedChannel | null = cfg.channelId
      ? await guild.channels.fetch(cfg.channelId).catch(() => null)
      : ((interaction.channel as GuildBasedChannel | null) ?? null);

    if (verifyChannel?.type === ChannelType.GuildText) {
      const perms = verifyChannel.permissionsFor(me);
      out.push(mark(true, `Verification channel: ${verifyChannel.toString()}`));
      const needed = [
        [PermissionFlagsBits.ViewChannel, 'View Channel'],
        [PermissionFlagsBits.SendMessages, 'Send Messages'],
        [PermissionFlagsBits.CreatePrivateThreads, 'Create Private Threads'],
        [PermissionFlagsBits.SendMessagesInThreads, 'Send Messages in Threads'],
        [PermissionFlagsBits.ManageThreads, 'Manage Threads (needed to delete)'],
        [PermissionFlagsBits.ReadMessageHistory, 'Read Message History (transcripts)'],
        [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
      ] as const;
      for (const [flag, label] of needed) out.push(mark(perms.has(flag), `  ${label}`));
    } else {
      out.push(mark(false, 'Verification channel is not set to a text channel.'));
    }

    const logChannel = cfg.logChannelId
      ? await guild.channels.fetch(cfg.logChannelId).catch(() => null)
      : null;
    if (!logChannel) {
      out.push(mark(false, 'Log channel not set or not found.'));
    } else {
      const lperms = logChannel.permissionsFor(me);
      out.push(
        mark(
          Boolean(
            lperms?.has(PermissionFlagsBits.SendMessages) &&
              lperms.has(PermissionFlagsBits.AttachFiles),
          ),
          `Log channel: ${logChannel.toString()} (send + attach files)`,
        ),
      );
    }

    if (cfg.staffRoleIds.length > 0) {
      const missing = cfg.staffRoleIds.filter((id) => !guild.roles.cache.has(id));
      out.push(
        mark(
          missing.length === 0,
          `Staff roles: ${cfg.staffRoleIds.length} configured` +
            (missing.length > 0 ? ` — missing IDs: ${missing.join(', ')}` : ''),
        ),
      );
      // Private threads are invisible unless you're in them or hold Manage Threads.
      if (verifyChannel?.type === ChannelType.GuildText) {
        for (const id of cfg.staffRoleIds) {
          const role = guild.roles.cache.get(id);
          if (!role) continue;
          const canSee = verifyChannel.permissionsFor(role).has(PermissionFlagsBits.ManageThreads);
          if (canSee) out.push(mark(true, `  ${role.name}: can see all private threads`));
          else if (cfg.addStaffToThread)
            out.push(`➖ ${role.name}: no Manage Threads — added to each thread individually`);
          else
            out.push(
              mark(
                false,
                `  ${role.name}: can't see private threads — give the role **Manage Threads** here, ` +
                  'or set addStaffToThread to true',
              ),
            );
        }
      }
    } else {
      out.push(mark(false, 'No staff roles configured — staff buttons fall back to Manage Server.'));
    }

    for (const [id, label] of [
      [cfg.verifiedRoleId, 'Verified role'],
      [cfg.unverifiedRoleId, 'Unverified role'],
    ] as const) {
      if (!id) {
        out.push(`➖ ${label}: not set (skipped)`);
        continue;
      }
      const role = guild.roles.cache.get(id);
      if (!role) out.push(mark(false, `${label}: ID ${id} not found`));
      else
        out.push(
          mark(
            me.roles.highest.comparePositionTo(role) > 0,
            `${label}: ${role.toString()} — my top role must be above it`,
          ),
        );
    }

    out.push(mark(me.permissions.has(PermissionFlagsBits.ManageRoles), 'Manage Roles'));
    if (cfg.kickOnDeny) {
      out.push(
        mark(me.permissions.has(PermissionFlagsBits.KickMembers), 'Kick Members (kickOnDeny is on)'),
      );
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Verification setup check')
          .setDescription(out.join('\n').slice(0, 4000))
          .setColor(COLOURS.brand)
          .setFooter({
            text: `Delete delay: ${cfg.deleteDelaySeconds}s • Auto-expire: ${cfg.staleThreadHours}h`,
          }),
      ],
    });
  },
};

export const commands: Command[] = [verifypanel, verifyopen, verifycheck];
