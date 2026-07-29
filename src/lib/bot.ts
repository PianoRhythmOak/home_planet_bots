/**
 * The runtime: wires features into a client, registers slash commands,
 * dispatches interactions, and shuts down cleanly.
 *
 * Nothing in here knows anything about verification — add a feature to
 * src/features/index.ts and it gets all of this for free.
 */

import {
  Client,
  Collection,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  ActivityType,
  DiscordAPIError,
  Events,
  Partials,
  type Interaction,
} from 'discord.js';
import { loadConfig, type BotConfig } from './config.js';
import { openDatabase, type DB } from './db.js';
import { createLogger, logger } from './logger.js';
import type { BotContext, Command, ComponentHandler, Feature } from './types.js';

const log = createLogger('runtime');

export class Bot {
  readonly client: Client;
  readonly config: BotConfig;
  readonly db: DB;

  private readonly commands = new Collection<string, Command>();
  private readonly components = new Collection<string, ComponentHandler>();
  private readonly features: Feature[] = [];
  private shuttingDown = false;

  constructor(features: Feature[]) {
    this.config = loadConfig();
    this.db = openDatabase(this.config.databasePath);
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers, // roles + detecting leaves (privileged)
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // readable transcripts (privileged)
      ],
      // Without this, discord.js DROPS guildMemberRemove entirely for any member
      // that isn't in the cache — which after a restart is most offline members,
      // since large_threshold defaults to 50.
      partials: [Partials.GuildMember],
    });

    for (const feature of features) this.register(feature);
  }

  private get context(): BotContext {
    return {
      client: this.client as Client<true>,
      config: this.config,
      db: this.db,
      log: logger,
    };
  }

  private register(feature: Feature): void {
    this.features.push(feature);

    for (const command of feature.commands ?? []) {
      if (this.commands.has(command.data.name)) {
        throw new Error(`Duplicate command name "${command.data.name}" in feature "${feature.name}"`);
      }
      this.commands.set(command.data.name, command);
    }

    for (const component of feature.components ?? []) {
      if (this.components.has(component.customId)) {
        throw new Error(`Duplicate customId "${component.customId}" in feature "${feature.name}"`);
      }
      this.components.set(component.customId, component);
    }

    for (const handler of feature.events ?? []) {
      const run = (...args: unknown[]): void => {
        // The async IIFE matters: calling execute() inside Promise.resolve(...)
        // would let a synchronous throw escape to uncaughtException instead of
        // landing in this catch.
        void (async () =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (handler.execute as any)(this.context, ...args))().catch((err: unknown) => {
          log.error(`Event "${String(handler.event)}" in feature "${feature.name}" threw:`, err);
        });
      };
      if (handler.once) this.client.once(handler.event, run);
      else this.client.on(handler.event, run);
    }

    log.debug(
      `Registered feature "${feature.name}": ${feature.commands?.length ?? 0} command(s), ` +
        `${feature.components?.length ?? 0} component(s), ${feature.events?.length ?? 0} event(s)`,
    );
  }

  /** Longest-prefix match, so `verify:approve` wins over a hypothetical `verify`. */
  private findComponent(customId: string): { handler: ComponentHandler; params: string[] } | null {
    const exact = this.components.get(customId);
    if (exact) return { handler: exact, params: [] };

    let best: ComponentHandler | null = null;
    for (const handler of this.components.values()) {
      if (!customId.startsWith(`${handler.customId}:`)) continue;
      if (!best || handler.customId.length > best.customId.length) best = handler;
    }
    if (!best) return null;
    return { handler: best, params: customId.slice(best.customId.length + 1).split(':') };
  }

  private async dispatch(interaction: Interaction): Promise<void> {
    const ctx = this.context;

    if (interaction.isChatInputCommand()) {
      const command = this.commands.get(interaction.commandName);
      if (!command) {
        // Usually a stale global command from an older deploy. Ack it, or the
        // user just sees "This interaction failed".
        log.warn(`No handler for command /${interaction.commandName}`);
        await interaction.reply({
          content: 'That command no longer exists. It should disappear shortly.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await command.execute(interaction, ctx);
      return;
    }

    if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
      const match = this.findComponent(interaction.customId);
      if (!match) {
        log.warn(`No handler for component "${interaction.customId}"`);
        return;
      }
      await match.handler.execute(interaction, ctx, match.params);
    }
  }

  /**
   * One place where every interaction error lands. Without this a thrown error
   * leaves the user staring at "This interaction failed" with nothing in the logs.
   */
  private async safeDispatch(interaction: Interaction): Promise<void> {
    try {
      await this.dispatch(interaction);
    } catch (err) {
      log.error('Interaction handler threw:', err);
      if (!interaction.isRepliable()) return;
      const body = {
        content: 'Something went wrong handling that. It has been logged.',
        flags: MessageFlags.Ephemeral as const,
      };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(body);
        else await interaction.reply(body);
      } catch {
        /* interaction already expired — nothing useful left to do */
      }
    }
  }

  private async publishCommands(): Promise<void> {
    const body = this.commands.map((c) => c.data);
    if (body.length === 0) return;

    const rest = new REST().setToken(this.config.token);
    const appId = this.client.application?.id ?? this.client.user?.id;
    if (!appId) {
      log.error('Client has no application id — cannot register slash commands.');
      return;
    }

    try {
      if (this.config.guildId) {
        await rest.put(Routes.applicationGuildCommands(appId, this.config.guildId), { body });
        log.info(`Registered ${body.length} slash command(s) to guild ${this.config.guildId}`);
      } else {
        await rest.put(Routes.applicationCommands(appId), { body });
        log.info(`Registered ${body.length} global slash command(s) — may take up to an hour to appear.`);
      }
    } catch (err) {
      if (err instanceof DiscordAPIError && (err.code === 50001 || err.status === 403)) {
        log.error(
          'Discord refused to register slash commands. The bot was almost certainly invited without ' +
            "the 'applications.commands' scope — re-invite it with both 'bot' and 'applications.commands' " +
            'ticked. (Also double-check guildId.)',
        );
      } else {
        log.error('Slash command registration failed. The bot will keep running.', err);
      }
    }
  }

  async start(): Promise<void> {
    this.client.on(Events.InteractionCreate, (interaction) => void this.safeDispatch(interaction));

    this.client.once(Events.ClientReady, async (client) => {
      log.info(`Logged in as ${client.user.tag} (${client.user.id})`);
      client.user.setPresence({
        status: 'online',
        activities: [
          // Custom activities show `state`, not `name` — both are set so it renders everywhere.
          { name: this.config.statusText, state: this.config.statusText, type: ActivityType.Custom },
        ],
      });

      // Features start BEFORE commands are published: publishCommands is a REST
      // call that can take seconds under a 429, and any button clicked in that
      // window would hit a feature whose state isn't initialised yet.
      for (const feature of this.features) {
        try {
          await feature.setup?.(this.context);
        } catch (err) {
          log.error(`Feature "${feature.name}" failed to start:`, err);
        }
      }

      await this.publishCommands();
      log.info('Ready.');
    });

    process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection:', reason));
    process.on('uncaughtException', (err) => log.error('Uncaught exception:', err));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => void this.stop(signal));
    }

    await this.client.login(this.config.token);
  }

  async stop(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log.info(`Shutting down (${reason})…`);

    for (const feature of this.features) {
      try {
        await feature.teardown?.(this.context);
      } catch (err) {
        log.error(`Feature "${feature.name}" failed to stop cleanly:`, err);
      }
    }
    await this.client.destroy();
    this.db.close();
    process.exit(0);
  }
}
