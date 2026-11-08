#!/usr/bin/env bash
# Abre o Orquestra (um prédio, um andar por projeto) direto no andar DESTE projeto.
# Servidor central: $ORQUESTRA_HOME (padrão ~/.orquestra) → server/server.mjs + config.json (lista dos projetos).
set -euo pipefail
ORQ="$(cd "$(dirname "$0")/.." && pwd)"
OH="${ORQUESTRA_HOME:-$HOME/.orquestra}"
SRV="$OH/server/server.mjs"; CFG="$OH/config.json"
[ -f "$SRV" ] || { echo "Servidor do Orquestra não encontrado em $OH/server — rode o novo-andar.sh do repositório."; exit 1; }
PID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("project_id","proj"))' "$ORQ/estudio/config.json")"
PORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("port",4777))' "$CFG")"
mkdir -p "$ORQ/estudio/data" "$OH/data"
rooms="$(curl -s -m 1 "http://localhost:$PORT/rooms" 2>/dev/null || true)"
codigo="$(python3 -c 'import os,sys;print(int(os.stat(sys.argv[1]).st_mtime*1000))' "$SRV")"
rodando="$( { curl -s -m 1 "http://localhost:$PORT/health" 2>/dev/null || true; } | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("code",0))
except Exception: print(0)')"
desatualizado=0; [ "${rodando:-0}" -lt "$((codigo - 2000))" ] && desatualizado=1
if printf '%s' "$rooms" | grep -q "\"id\":\"$PID\"" && [ "${1:-}" != "--restart" ] && [ $desatualizado = 0 ]; then
  echo "Orquestra já está rodando (porta $PORT)."
else
  pids="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] && { kill $pids 2>/dev/null || true; sleep 0.5; }
  (cd "$OH/server" && ORQ_CONFIG="$CFG" env -u HC_TERMINAL_ID nohup node server.mjs > "$OH/data/server.log" 2>&1 < /dev/null &)
  sleep 1
  echo "Orquestra iniciado (porta $PORT)."
fi
[ -n "${NO_OPEN:-}" ] && exit 0
url="http://localhost:$PORT/?p=$PID"
if [ -d /Applications/Orquestra.app ] && [ "$(uname)" = Darwin ]; then open -a Orquestra; else open "$url" 2>/dev/null || xdg-open "$url" 2>/dev/null || echo "Abra $url"; fi
