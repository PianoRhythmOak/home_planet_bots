import { Events, type GuildMember } from 'discord.js';
import { defineEvent, type Feature } from '../../lib/types.js';
import { commands } from './commands.js';
import { components } from './components.js';
import { startJanitor, stopJanitor } from './janitor.js';
import { abandonTicket, bindStore, handleMemberJoin, warmMemberCache } from './service.js';
import { TicketStore } from './store.js';

export const verificationFeature: Feature = {
  name: 'verification',
  commands,
  components,
  events: [
    defineEvent({
      event: Events.GuildMemberAdd,
      async execute(ctx, member) {
        await handleMemberJoin(ctx, member);
      },
    }),
    defineEvent({
      event: Events.GuildMemberRemove,
      async execute(ctx, member) {
        // Partials.GuildMember is enabled in lib/bot.ts, so this fires even for
        // members that weren't cached. A partial still carries id, guild and user,
        // which is everything abandonTicket touches.
        await abandonTicket(ctx, member as GuildMember);
      },
    }),
  ],
  async setup(ctx) {
    bindStore(new TicketStore(ctx.db));

    // Pull the member list up front so role.members (cache-only) is actually
    // populated before the first verification comes in.
    if (ctx.config.guildId) {
      const guild = await ctx.client.guilds.fetch(ctx.config.guildId).catch(() => null);
      if (guild) await warmMemberCache(guild);
    }

    startJanitor(ctx);
  },
  teardown() {
    stopJanitor();
  },
};
