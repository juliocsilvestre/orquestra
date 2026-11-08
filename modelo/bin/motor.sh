#!/usr/bin/env bash
# Sobe um agente da equipe com OUTRO motor de IA (Codex, Gemini, Cursor, GitHub Copilot) — chamado pelo equipe.sh.
#   motor.sh <motor> <modelo|-> <arquivo-com-as-instruções>
# As regras de bloqueio do Claude Code (settings.json) NÃO valem para esses motores: eles rodam no modo em que
# pedem aprovação antes de executar comandos/editar arquivos — aprove na aba Terminal/Tela do agente.
set -uo pipefail
m="${1:?motor}"; mdl="${2:--}"; [ "$mdl" = - ] && mdl=""; inst="${3:?instruções}"
p="$(cat "$inst")

---
Siga as instruções acima durante toda a sessão. Agora só responda \"pronto\" e aguarde a próxima mensagem."
# pasta já confiável para o motor (sem a pergunta "confiar nesta pasta?" na 1ª vez — o andar é seu)
python3 - "$m" "$PWD" <<'PYC' 2>/dev/null || true
import json, os, sys
m, d = sys.argv[1], os.path.realpath(sys.argv[2]); h = os.path.expanduser('~')
def lj(f):
    try: return json.load(open(f))
    except Exception: return {}
def wj(f, j): os.makedirs(os.path.dirname(f), exist_ok=True); json.dump(j, open(f, 'w'), indent=2)
if m == 'codex':
    f = os.path.join(h, '.codex', 'config.toml'); t = open(f).read() if os.path.exists(f) else ''
    if f'[projects."{d}"]' not in t: os.makedirs(os.path.dirname(f), exist_ok=True); open(f, 'a').write(f'\n[projects."{d}"]\ntrust_level = "trusted"\n')
elif m == 'gemini':
    f = os.path.join(h, '.gemini', 'trustedFolders.json'); j = lj(f)
    if j.get(d) != 'TRUST_FOLDER': j[d] = 'TRUST_FOLDER'; wj(f, j)
elif m == 'copilot':
    f = os.path.join(h, '.copilot', 'config.json'); j = lj(f); tf = j.get('trusted_folders') or []
    if d not in tf: j['trusted_folders'] = tf + [d]; wj(f, j)
PYC
case "$m" in
  codex)   exec codex ${mdl:+-m "$mdl"} --sandbox workspace-write --ask-for-approval on-request "$p" ;;
  gemini)  exec gemini ${mdl:+-m "$mdl"} -i "$p" ;;
  cursor)  exec agent ${mdl:+--model "$mdl"} "$p" ;;
  copilot) exec copilot ${mdl:+--model "$mdl"} -i "$p" ;;
  *) echo "motor desconhecido: $m"; exit 2 ;;
esac
