import { describe, expect, it, vi } from 'vitest';
import { connectionNotifier } from '../src/notify/connection.js';
describe('connection notifications', () => {
  it('announces startup once and each recovery once', async () => {
    const send = vi.fn(async (_message: string) => {});
    const connection = connectionNotifier(send);
    await connection.connected();
    await connection.connected();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toContain('Sleeper Personal Assistant conectado.');
    connection.disconnected();
    connection.disconnected();
    await connection.connected();
    await connection.connected();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toContain('Sleeper Personal Assistant conectado.');
    expect(connection.pending).toBe(false);
  });
  it('retries the confirmation if sending fails', async () => {
    const send = vi.fn(async (_message: string) => {}).mockRejectedValueOnce(new Error('offline'));
    const connection = connectionNotifier(send);
    await expect(connection.connected()).rejects.toThrow('offline');
    expect(connection.pending).toBe(true);
    await connection.connected();
    expect(connection.pending).toBe(false);
    expect(send.mock.calls[1]![0]).toContain('conectado.');
  });
});
