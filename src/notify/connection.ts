/** Uma confirmação por processo; falhas posteriores voltam ao long poll sem novo anúncio. */
export function connectionNotifier(send: (message: string) => Promise<void>) {
  let pending = true;
  let announced = false;
  return {
    disconnected() { pending = true; },
    get pending() { return pending; },
    async connected() {
      if (!pending) return;
      if (!announced) {
        await send('✅ <b>Sleeper Personal Assistant conectado.</b> Estou pronto para receber comandos.');
        announced = true;
      }
      pending = false;
    },
  };
}
