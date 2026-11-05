import { afterEach, describe, expect, it, vi } from 'vitest';
const locks: string[] = [];
vi.mock('../src/db/index.js', () => ({
  sql: Object.assign(vi.fn(async () => []), { unsafe: vi.fn(async () => []) }),
  isFresh: vi.fn(),
  markFetched: vi.fn(),
  copyCsvToStaging: vi.fn(async () => 1),
  withAdvisoryLock: vi.fn(async (key: string, fn: () => Promise<unknown>) => {
    locks.push(key);
    return fn();
  }),
}));
import { copyCsvToStaging, isFresh } from '../src/db/index.js';
import { syncNflverse } from '../src/data/nflverse.js';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  locks.length = 0;
});

describe('carga das fontes nflverse', () => {
  it('carrega cada tabela de staging sob um advisory lock próprio', async () => {
    vi.mocked(isFresh).mockResolvedValue(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('a\n1\n')));
    await syncNflverse([2026]);
    expect(locks).toEqual([
      'staging:raw.nfl_player_weeks',
      'staging:raw.nfl_team_weeks',
      'staging:raw.nfl_snaps',
      'staging:raw.nfl_games',
      'staging:raw.dp_ids',
    ]);
  });

  it('não recarrega a fonte se outro processo a carregou enquanto esperava o lock', async () => {
    // Antes do lock: vencida; depois do lock: já atualizada pelo outro processo
    vi.mocked(isFresh).mockImplementation(async () => locks.length > 0);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const changed = await syncNflverse([2026]);
    expect(changed).toBe(false);
    expect(copyCsvToStaging).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
