/** Uma confirmação por início ou recuperação, sem repetir a cada long poll. */
export function connectionNotifier(send: (message: string) => Promise<void>) {
  let pending = true;
  return {
    disconnected() { pending = true; },
    get pending() { return pending; },
    async connected() {
      if (!pending) return;
      await send('✅ <b>Sleeper Personal Assistant conectado.</b> Estou pronto para receber comandos.');
      pending = false;
    },
  };
}
