import { afterEach, describe, expect, it, vi } from 'vitest';
import { myTradeInbox } from '../src/sleeper/graphql.js';
import { config } from '../src/config.js';
import { offer } from './fixtures/inbox.js';
const token = config.SLEEPER_TOKEN;
afterEach(() => { config.SLEEPER_TOKEN = token; vi.unstubAllGlobals(); });
describe('inbox GraphQL reads', () => {
  it('sends only a read query restricted to my roster and validates the response', async () => {
    config.SLEEPER_TOKEN = 'test';
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { league_transactions_filtered: [offer(), offer({ consenter_ids: [1, 2] }), offer({ league_id: '222' })] } })));
    vi.stubGlobal('fetch', fetch);
    expect(await myTradeInbox('111', 1, 'u1')).toHaveLength(1);
    const init = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const query = JSON.parse(String(init[1].body)).query;
    expect(query).toContain('roster_id_filters: [1]'); expect(query).toContain('["proposed"]');
    expect(query).not.toContain('mutation');
  });
  it('rejects unsafe identifiers and reports expired authorization clearly', async () => {
    config.SLEEPER_TOKEN = 'test';
    const fetch = vi.fn(async () => new Response('{}', { status: 401 })); vi.stubGlobal('fetch', fetch);
    await expect(myTradeInbox('111"', 1, 'u1')).rejects.toThrow('inválidos'); expect(fetch).not.toHaveBeenCalled();
    await expect(myTradeInbox('111', 1, 'u1')).rejects.toThrow('expirado');
  });
  it('does not interpret missing consents as an incoming proposal', async () => {
    config.SLEEPER_TOKEN = 'test'; const malformed = { ...offer(), consenter_ids: undefined };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { league_transactions_filtered: [malformed] } }))));
    await expect(myTradeInbox('111', 1, 'u1')).rejects.toThrow();
  });
});
