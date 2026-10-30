import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadFile } from '../src/notify/telegram.js';

const getFile = () => new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/a.jpg', file_size: 3 } }));
const netError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });

describe('downloadFile', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('repete falhas de rede transitórias', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(netError())
      .mockResolvedValueOnce(getFile())
      .mockRejectedValueOnce(netError())
      .mockResolvedValueOnce(getFile())
      .mockResolvedValueOnce(new Response('abc'));
    vi.stubGlobal('fetch', fetch);
    const file = await downloadFile('id', 'tok', () => 0);
    expect(file.data.toString()).toBe('abc');
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('desiste após 4 tentativas sem expor o token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(netError()));
    const err = await downloadFile('id', 'segredo', () => 0).then(() => null, (e: Error) => e.message);
    expect(err).toBe('Falha de rede ao baixar a imagem do Telegram (ETIMEDOUT). Tente reenviar.');
    expect(err).not.toContain('segredo');
  });

  it('não repete erros HTTP 4xx', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(getFile()).mockResolvedValueOnce(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    await expect(downloadFile('id', 'tok', () => 0)).rejects.toThrow('HTTP 404');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
