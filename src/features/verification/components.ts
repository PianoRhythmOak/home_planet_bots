import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { BotContext, ComponentHandler } from '../../lib/types.js';
import { finalizeTicket, IDS, isStaff, openTicket } from './service.js';

/** Every staff button goes through this first. */
async function requireStaff(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const member = interaction.member as GuildMember | null;
  if (!member || !isStaff(member, ctx.config.verification.staffRoleIds)) {
    await interaction.reply({
      content: 'Only staff can use these buttons.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  return true;
}

export const components: ComponentHandler[] = [
  {
    customId: IDS.start,
    async execute(interaction, ctx) {
      if (!interaction.isButton()) return;
      await openTicket(interaction, ctx);
    },
  },
  {
    customId: IDS.approve,
    async execute(interaction, ctx) {
      if (!interaction.isButton()) return;
      if (!(await requireStaff(interaction, ctx))) return;
      await finalizeTicket(interaction, ctx, 'approved', null);
    },
  },
  {
    customId: IDS.deny,
    async execute(interaction, ctx) {
      if (!interaction.isButton()) return;
      if (!(await requireStaff(interaction, ctx))) return;

      const modal = new ModalBuilder().setCustomId(IDS.denyModal).setTitle('Deny verification');
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(IDS.denyReason)
            .setLabel('Reason (staff log only)')
            .setPlaceholder("e.g. underage, wouldn't verify, alt account, no response")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(400),
        ),
      );
      await interaction.showModal(modal);
    },
  },
  {
    customId: IDS.denyModal,
    async execute(interaction, ctx) {
      if (!interaction.isModalSubmit()) return;
      if (!(await requireStaff(interaction, ctx))) return;
      const reason = interaction.fields.getTextInputValue(IDS.denyReason).trim();
      await finalizeTicket(interaction, ctx, 'denied', reason || null);
    },
  },
  {
    customId: IDS.close,
    async execute(interaction, ctx) {
      if (!interaction.isButton()) return;
      if (!(await requireStaff(interaction, ctx))) return;
      await finalizeTicket(interaction, ctx, 'closed', null);
    },
  },
];
