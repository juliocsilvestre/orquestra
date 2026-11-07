#!/usr/bin/env bash
# Sobe os serviços do projeto (servicos.conf) como terminais do Herdr: srv-*  (só quem não está vivo)
set -uo pipefail
ORQ="$(cd "$(dirname "$0")/.." && pwd)"; PROJ="$(cd "$ORQ/.." && pwd)"
source "$ORQ/projeto.env"; source "$ORQ/bin/_lib.sh"
[ -f "$ORQ/servicos.conf" ] || exit 0
hc_antigos "$PROJ" $(grep -hv '^\s*#' "$ORQ/servicos.conf" | awk 'NF{print $1}') | while read -r addr n; do hc kill "$addr" >/dev/null 2>&1; done
vivos=" $(hc_vivos) "
while read -r nome pasta cmd; do
  case "$nome" in ''|\#*) continue;; esac
  manual=0; case "$cmd" in *"#manual"*) manual=1;; esac
  cmd="${cmd%%#*}"; cmd="$(echo "$cmd" | sed 's/[[:space:]]*$//')"
  [ "$manual" = 1 ] && [ "${1:-}" != "$nome" ] && [ "${1:-}" != "--todos" ] && continue
  case "$vivos" in *" $nome "*) hc label "$(tn "$nome")" "orq.projeto=$PROJ_ID" >/dev/null 2>&1 || true; echo "· $nome já está rodando"; continue;; esac
  hc run --bg --no-notify --label "orq.projeto=$PROJ_ID" --name "$(tn "$nome")" --cwd "$PROJ/$pasta" -- /bin/zsh -lc "$cmd" >/dev/null && echo "+ $nome: $cmd" || echo "x $nome não subiu"
done < "$ORQ/servicos.conf"
