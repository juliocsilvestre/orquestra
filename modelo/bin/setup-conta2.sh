#!/usr/bin/env bash
# Cria a pasta de config da 2ª conta do Claude, reaproveitando skills/comandos/agentes da 1ª.
set -euo pipefail
SRC="$HOME/.claude"; DST="${1:-$HOME/.claude-conta2}"
mkdir -p "$DST"
for item in skills commands agents plugins CLAUDE.md settings.json; do
  if [ -e "$SRC/$item" ] && [ ! -e "$DST/$item" ]; then ln -s "$SRC/$item" "$DST/$item"; echo "link: $item"; fi
done
echo
echo "Pronto. Agora faça o login da 2ª conta (uma vez só):"
echo "  CLAUDE_CONFIG_DIR=\"$DST\" claude"
echo "  > /login   (entre com a OUTRA conta)   > /exit"
