import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/db/index.js', () => ({ sql: vi.fn(), num: Number, withJobLock: vi.fn(async () => null) }));
import { config } from '../src/config.js';
import { withJobLock } from '../src/db/index.js';
import { runBot } from '../src/jobs/bot.js';
const original = { ...config };
afterEach(() => { Object.assign(config, original); vi.clearAllMocks(); });
describe('bot startup', () => {
  it('fails clearly before polling when no chat is linked', async () => {
    config.TELEGRAM_CHAT_ID = '';
    await expect(runBot()).rejects.toThrow('TELEGRAM_CHAT_ID');
    expect(withJobLock).not.toHaveBeenCalled();
  });
  it('refuses to start a second polling instance', async () => {
    config.TELEGRAM_BOT_TOKEN = 'token'; config.TELEGRAM_CHAT_ID = '1';
    await expect(runBot()).rejects.toThrow('Outra instância');
    expect(withJobLock).toHaveBeenCalledWith('telegram-bot', expect.any(Function));
  });
});
