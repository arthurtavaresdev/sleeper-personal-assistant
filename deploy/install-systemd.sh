#!/usr/bin/env bash
# Instala as units de usuário do systemd apontando para este checkout e para o Node atual.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_DIR="$(dirname "$(command -v node)")"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$DEST"
for f in "$APP_DIR"/deploy/systemd/*; do
  sed -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@NODE_DIR@#$NODE_DIR#g" "$f" > "$DEST/$(basename "$f")"
done
systemctl --user daemon-reload
systemctl --user enable --now sleeper-trader-bot.service \
  sleeper-trader-waivers.timer sleeper-trader-trades.timer \
  sleeper-trader-lineup.timer sleeper-trader-injuries.timer sleeper-trader-inbox.timer
# Mantém o container do Postgres e os timers rodando sem sessão aberta e após reboot
systemctl --user enable podman-restart.service
loginctl enable-linger "$USER"
systemctl --user list-timers 'sleeper-trader-*'
