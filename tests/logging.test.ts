import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError, networkFailure } from '../src/errors.js';
import { scrubSecrets } from '../src/log.js';

const fetchFailed = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

describe('scrubSecrets', () => {
  it('masks configured secrets and Telegram bot tokens in URLs', () => {
    const line = 'auth=supersecret123 url=https://api.telegram.org/bot123456:AAH-x_y/getFile';
    const out = scrubSecrets(line, ['supersecret123']);
    expect(out).not.toContain('supersecret123');
    expect(out).not.toContain('AAH-x_y');
    expect(out).toContain('/bot[REDACTED]/getFile');
  });
});

describe('network failures', () => {
  it('names the resource and the root cause instead of "fetch failed"', () => {
    const err = networkFailure('Sleeper /league/1/rosters', fetchFailed('ECONNRESET'), 4);
    expect(err.message).toBe('Sleeper /league/1/rosters: falha de rede (ECONNRESET) após 4 tentativas');
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it('adds the cause code to a bare fetch failed', () => {
    expect(describeError(fetchFailed('ENOTFOUND'))).toBe('fetch failed (ENOTFOUND)');
  });
});

describe('sleeper client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries transient network failures before giving up with context', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValue(fetchFailed('UND_ERR_CONNECT_TIMEOUT'));
    vi.stubGlobal('fetch', fetch);
    const { sleeper } = await import('../src/sleeper/client.js');
    const result = sleeper.state().catch((e: Error) => e);
    await vi.runAllTimersAsync();
    const err = await result;
    vi.useRealTimers();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect((err as Error).message).toMatch(/^Sleeper \/state\/nfl: falha de rede \(UND_ERR_CONNECT_TIMEOUT\) após 4 tentativas$/);
  });
});
