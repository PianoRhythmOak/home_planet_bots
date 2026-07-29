import { Bot } from './lib/bot.js';
import { features } from './features/index.js';
import { logger } from './lib/logger.js';

const bot = new Bot(features);

bot.start().catch((err: unknown) => {
  logger.error('Failed to start:', err);
  process.exit(1);
});
