#!/usr/bin/env bash
# Passa a vez para outro agente DESTA equipe, seguindo o fluxo:
#   dev-*  → qa           (entrega para validar)
#   qa     → dev-*        (reprovado: devolve com os passos para reproduzir)
#   gitlab/github → dev-* (pipeline falhou)
# Uso: avisa-agente.sh <agente> "<texto>". Com o agente ocupado, o recado vai para relatorios/<agente>/caixa.md.
set -uo pipefail
ORQ="$(cd "$(dirname "$0")/.." && pwd)"; source "$ORQ/bin/_lib.sh"
alvo="${1:?agente}"; shift; texto="${*:?texto}"
case "$PWD" in */.worktrees/*) eu="$(echo "$PWD" | sed 's#.*/.worktrees/\([^/]*\).*#\1#')"; [[ "$eu" == dev-* ]] || eu="dev-$eu";; "$ORQ"/*) eu="$(echo "${PWD#$ORQ/}" | cut -d/ -f1)";; *) eu="?";; esac
ok=0
case "$eu" in
  dev-*) [ "$alvo" = qa ] && ok=1;;
  qa|gitlab|github) [[ "$alvo" == dev-* ]] && ok=1;;
esac
grep -qE "^$alvo[[:space:]]" "$ORQ/equipe.conf" || ok=0
[ $ok = 1 ] || { echo "RECUSADO: $eu não passa trabalho para $alvo neste fluxo (use avisa-boss.sh)."; exit 2; }
st="$(hc_status "$alvo")"
case "$st" in
  idle|done|-) hc send "$(tn "$alvo")" "[de $eu] $texto" && echo "entregue a $alvo";;
  *) mkdir -p "$ORQ/relatorios/$alvo"; printf '\n- %s · de %s: %s\n' "$(date '+%d/%m %H:%M')" "$eu" "$texto" >> "$ORQ/relatorios/$alvo/caixa.md"; echo "$alvo está $st — recado guardado em relatorios/$alvo/caixa.md (ele lê ao terminar)";;
esac
