/** Uma confirmação por início ou recuperação, sem repetir a cada long poll. */
export function connectionNotifier(send: (message: string) => Promise<void>) {
  let pending = true;
  let announced = false;
  return {
    disconnected() { pending = true; },
    get pending() { return pending; },
    async connected() {
      if (!pending) return;
      await send(announced
        ? '✅ <b>Sleeper Trader reconectado.</b> Voltei a receber comandos.'
        : '✅ <b>Sleeper Trader conectado.</b> Estou pronto para receber comandos.');
      announced = true;
      pending = false;
    },
  };
}
