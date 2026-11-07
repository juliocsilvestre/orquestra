#!/usr/bin/env bash
# Único jeito da equipe falar com o Boss DESTE projeto (boss-<projeto>).
# Acha o terminal com as etiquetas orq.projeto=<id> + orq.papel=boss que esteja rodando o Claude.
# Se não houver Boss deste projeto no ar, guarda o recado na caixa de entrada (relatorios/caixa-boss.md) — nunca manda para outro terminal.
# Uso: <orquestra>/bin/avisa-boss.sh "<texto>"
set -uo pipefail
ORQ="$(cd "$(dirname "$0")/.." && pwd)"; source "$ORQ/bin/_lib.sh"
texto="${*:?texto}"
quem="${HC_TERMINAL_NAME:-$(basename "$PWD")}"
addr="$(hc ls --label "orq.projeto=$PROJ_ID" --label "orq.papel=boss" --json 2>/dev/null | python3 -c '
import json,sys
try: ts=json.load(sys.stdin)["terminals"]
except Exception: ts=[]
ok=[t for t in ts if t.get("state")=="live" and t.get("agent")=="claude-code"]
print(ok[0]["address"] if ok else "")')"
if [ -n "$addr" ]; then
  hc send "$addr" "$texto" && { echo "entregue ao boss-$PROJ_ID ($addr)"; exit 0; }
fi
mkdir -p "$ORQ/relatorios"
printf '\n- %s · %s\n  %s\n' "$(date '+%d/%m %H:%M')" "$quem" "$texto" >> "$ORQ/relatorios/caixa-boss.md"
echo "boss-$PROJ_ID não está no ar — recado guardado em relatorios/caixa-boss.md"
