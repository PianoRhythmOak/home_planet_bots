/**
 * The contracts every feature module implements. Adding a feature to a bot
 * means writing one of these and adding it to src/features/index.ts — no
 * plumbing, no filesystem scanning, and the compiler checks your wiring.
 */

import type {
  ChatInputCommandInteraction,
  Client,
  ClientEvents,
  MessageComponentInteraction,
  ModalSubmitInteraction,
  RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';
import type { BotConfig } from './config.js';
import type { DB } from './db.js';
import type { Logger } from './logger.js';

/** Passed to everything. Keeps features from reaching for module-level globals. */
export interface BotContext {
  client: Client<true>;
  config: BotConfig;
  db: DB;
  log: Logger;
}

export interface Command {
  /** Built with SlashCommandBuilder, then .toJSON() */
  data: RESTPostAPIApplicationCommandsJSONBody;
  execute(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void>;
}

/**
 * Handles a button, select menu or modal.
 *
 * `customId` matches exactly, or as a prefix when the incoming id is
 * `${customId}:something` — so you can encode state in the id, e.g.
 * `verify:approve:123456789`. Anything after the colon arrives in `params`.
 */
export interface ComponentHandler {
  customId: string;
  execute(
    interaction: MessageComponentInteraction | ModalSubmitInteraction,
    ctx: BotContext,
    params: string[],
  ): Promise<void>;
}

export interface EventHandler<K extends keyof ClientEvents = keyof ClientEvents> {
  event: K;
  once?: boolean;
  execute(ctx: BotContext, ...args: ClientEvents[K]): Promise<void> | void;
}

/** Type-preserving helper so `...args` stays correctly typed per event name. */
export function defineEvent<K extends keyof ClientEvents>(handler: EventHandler<K>): EventHandler {
  return handler as EventHandler;
}

export interface Feature {
  name: string;
  commands?: Command[];
  components?: ComponentHandler[];
  events?: EventHandler[];
  /** Run once at startup, after login: migrations, background jobs, caches. */
  setup?(ctx: BotContext): Promise<void> | void;
  /** Run on shutdown: clear intervals, flush state. */
  teardown?(ctx: BotContext): Promise<void> | void;
}
