#!/usr/bin/env bash
# hc SÓ para a equipe DESTE projeto. Uso (Boss):
#   ../bin/hcp.sh send <agente> "<texto>"   |  ../bin/hcp.sh read <agente> [--lines N]
#   ../bin/hcp.sh keys <agente> <teclas>     |  ../bin/hcp.sh interrupt <agente>   |  ../bin/hcp.sh ls
# Recusa qualquer alvo que não seja desta equipe (equipe.conf, servicos.conf, devs extras dev-<repo>-<slug> deste projeto).
set -euo pipefail
ORQ="$(cd "$(dirname "$0")/.." && pwd)"; PROJ="$(cd "$ORQ/.." && pwd)"
source "$ORQ/projeto.env"; source "$ORQ/bin/_lib.sh"
acao="${1:?acao}"; shift || true
if [ "$acao" = ls ]; then exec "$ORQ/bin/time.sh" "$@"; fi
alvo="${1:?alvo}"; shift
permitidos=" $(grep -hv '^\s*#' "$ORQ/equipe.conf" "$ORQ/servicos.conf" 2>/dev/null | awk 'NF{print $1}' | tr '\n' ' ') "
real="$(tn "$alvo")"; nome="$alvo"
if [[ "$alvo" =~ ^t[0-9]+[a-z]?$ ]]; then
  real="$alvo"
  nome="$(hc ls --json 2>/dev/null | python3 -c 'import json,sys;a=sys.argv[1];p=sys.argv[2]+"-";n=next((t.get("name") or "" for t in json.load(sys.stdin)["terminals"] if t.get("address")==a),"");print(n[len(p):] if n.startswith(p) else "")' "$alvo" "$PROJ_ID")"
fi
ok=0
[ -n "$nome" ] || { echo "RECUSADO: '$alvo' não é da equipe deste projeto ($PROJ_ID)." >&2; exit 2; }
case "$permitidos" in *" $nome "*) ok=1;; esac
if [ $ok = 0 ] && [[ "$nome" == dev-* ]]; then
  for r in "$PROJ"/*/; do r="$(basename "$r")"; [[ "$nome" == "dev-$r-"* ]] && [ -e "$PROJ/$r/.git" ] && ok=1; done
fi
if [ $ok = 0 ]; then
  echo "RECUSADO: '$alvo' não é da equipe deste projeto ($PROJ_ID). Use ../bin/time.sh para ver a sua equipe." >&2; exit 2
fi
case "$acao" in
  send) exec hc send "$real" "$@";;
  read) exec hc read "$real" "$@";;
  keys) exec hc keys "$real" "$@";;
  interrupt) exec hc interrupt "$real";;
  *) echo "ação inválida: $acao" >&2; exit 1;;
esac
