import pino from 'pino';
import { config } from './config.js';

export const log = pino({
  level: config.LOG_LEVEL,
  transport: process.stdout.isTTY ? { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } : undefined,
});
