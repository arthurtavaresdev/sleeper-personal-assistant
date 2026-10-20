#!/usr/bin/env bash
# Instala as units de usuário com o Node atual e migra os nomes legados.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_DIR="$(dirname "$(command -v node)")"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PREFIX=sleeper-personal-assistant
LEGACY_PREFIX=sleeper-trader
JOBS=(waivers trades lineup injuries inbox)
mkdir -p "$DEST"
# Renderiza placeholders sem depender do shell de login do nvm.
for f in "$APP_DIR"/deploy/systemd/*; do
  APP_DIR="$APP_DIR" NODE_DIR="$NODE_DIR" node -e '
    const fs = require("node:fs");
    const text = fs.readFileSync(process.argv[1], "utf8")
      .replaceAll("@APP_DIR@", process.env.APP_DIR)
      .replaceAll("@NODE_DIR@", process.env.NODE_DIR);
    fs.writeFileSync(process.argv[2], text);
  ' "$f" "$DEST/$(basename "$f")"
done
systemd-analyze --user verify "$DEST/$PREFIX-bot.service" "$DEST/$PREFIX-inbox.service" "$DEST/$PREFIX@.service" "$DEST/$PREFIX-"*.timer
# Desabilita apenas units antigas que realmente existem.
LEGACY_UNITS=()
for name in "$LEGACY_PREFIX-bot.service" "$LEGACY_PREFIX-inbox.service"; do
  if [[ -f "$DEST/$name" ]]; then LEGACY_UNITS+=("$name"); fi
done
for job in "${JOBS[@]}"; do
  if [[ -f "$DEST/$LEGACY_PREFIX-$job.timer" ]]; then LEGACY_UNITS+=("$LEGACY_PREFIX-$job.timer"); fi
  if [[ -f "$DEST/$LEGACY_PREFIX@.service" && "$job" != inbox ]]; then LEGACY_UNITS+=("$LEGACY_PREFIX@$job.service"); fi
done
if ((${#LEGACY_UNITS[@]})); then
  systemctl --user stop "${LEGACY_UNITS[@]}"
  for unit in "${LEGACY_UNITS[@]}"; do
    state="$(systemctl --user is-enabled "$unit" 2>/dev/null || true)"
    case "$state" in
      enabled|enabled-runtime|linked|linked-runtime) systemctl --user disable "$unit" ;;
    esac
  done
fi
systemctl --user daemon-reload
TIMERS=()
for job in "${JOBS[@]}"; do TIMERS+=("$PREFIX-$job.timer"); done
systemctl --user enable --now "${TIMERS[@]}"
systemctl --user enable "$PREFIX-bot.service"
# Reinicia também em reinstalações para carregar configurações e código novos.
systemctl --user restart "$PREFIX-bot.service"
# Sem sessão aberta e após reboot.
systemctl --user enable podman-restart.service
loginctl enable-linger "$USER"
systemctl --user list-timers "$PREFIX-*"
