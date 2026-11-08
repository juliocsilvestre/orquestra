# Funções comuns (source)
conta_dir() { case "$1" in 1) echo "${CONTA1_DIR:-}";; 2) echo "${CONTA2_DIR:-$HOME/.claude-conta2}";; [3-9]) eval "echo \"\${CONTA$1_DIR:-$HOME/.claude-conta$1}\"";; *) echo "";; esac; }

base_branch() {
  local repo="$1" b
  if [ -n "${BASE_BRANCH:-}" ]; then echo "$BASE_BRANCH"; return; fi
  for b in develop main master; do
    if git -C "$PROJ/$repo" rev-parse -q --verify "origin/$b" >/dev/null || git -C "$PROJ/$repo" rev-parse -q --verify "$b" >/dev/null; then echo "$b"; return; fi
  done
  echo main
}
base_ref() { if git -C "$PROJ/$1" rev-parse -q --verify "origin/$2" >/dev/null; then echo "origin/$2"; else echo "$2"; fi; }

# trust_dirs <config_dir|""> <dir>...  — pré-aprova a tela de confiança do Claude Code, numa escrita só
trust_dirs() {
  local cfgdir="$1"; shift
  local cj; if [ -n "$cfgdir" ]; then cj="$cfgdir/.claude.json"; else cj="$HOME/.claude.json"; fi
  [ -f "$cj" ] || return 0
  python3 - "$cj" "$@" <<'PY' || echo "aviso: não consegui pré-aprovar pastas em $cj"
import json, os, sys, tempfile
cj, dirs = sys.argv[1], [os.path.realpath(d) for d in sys.argv[2:]]
with open(cj) as f: d = json.load(f)
ch = False
for wt in dirs:
    p = d.setdefault("projects", {}).setdefault(wt, {})
    if not p.get("hasTrustDialogAccepted"): p["hasTrustDialogAccepted"] = True; ch = True
if ch:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(cj))
    with os.fdopen(fd, "w") as f: json.dump(d, f, indent=2)
    os.replace(tmp, cj)
PY
}

# Nome do terminal no Herdr = <projeto>-<agente> (ex.: loja-qa, blog-qa): os nomes do Herdr sao globais, assim cada andar tem os seus.
# nome do terminal no Herdr (o hc aceita até 32 caracteres): se passar, encurta com um código fixo no fim (igual ao tnHc do servidor)
tn() { local n="${PROJ_ID}-$1" h=0 i c; if [ ${#n} -le 32 ]; then echo "$n"; return; fi; for ((i=0;i<${#n};i++)); do printf -v c %d "'${n:i:1}"; h=$(( (h*31 + c) % 1000003 )); done; printf '%s-%05d\n' "${n:0:26}" $((h % 100000)); }
# hc_status <agente> -> working|blocked|done|idle|-|ausente
hc_status() {
  hc ls --json 2>/dev/null | python3 -c 'import json,sys
n=sys.argv[1]
try: ts=json.load(sys.stdin)["terminals"]
except Exception: print("ausente"); sys.exit()
print(next(((t.get("status") or "-") for t in ts if t.get("name")==n and t.get("state")=="live"),"ausente"))' "$(tn "$1")"
}
hc_vivos() {
  hc ls --json 2>/dev/null | python3 -c 'import json,sys
try: ts=json.load(sys.stdin)["terminals"]
except Exception: ts=[]
p=sys.argv[1]+"-"
print(" ".join(t["name"][len(p):] for t in ts if t.get("state")=="live" and (t.get("name") or "").startswith(p)))' "$PROJ_ID"
}

# id do projeto (usado como etiqueta dos terminais: orq.projeto=<id>) — isola a equipe de cada projeto
PROJ_ID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("project_id","proj"))' "$ORQ/estudio/config.json" 2>/dev/null || echo proj)"

# hc_antigos <pasta-do-projeto> <agente>... -> terminais vivos com o nome ANTIGO (sem prefixo) que sao deste projeto
hc_antigos() {
  local raiz="$1"; shift
  hc ls --json 2>/dev/null | python3 -c 'import json,sys
raiz=sys.argv[1]; nomes=set(sys.argv[2:])
try: ts=json.load(sys.stdin)["terminals"]
except Exception: ts=[]
for t in ts:
    if t.get("state")=="live" and t.get("name") in nomes and (t.get("cwd") or "").startswith(raiz): print(t["address"], t["name"])' "$raiz" "$@"
}

# ---------- sessões (Estúdio → Configurações): modo ao subir (nova|continuar) e memória em .md ----------
sessao_cfg() { python3 -c 'import json,sys
try: s=json.load(open(sys.argv[1])).get("sessoes",{})
except Exception: s={}
v=s.get(sys.argv[2], sys.argv[3]); print(str(v).lower() if isinstance(v,bool) else v)' "$ORQ/estudio/config.json" "$1" "$2"; }
tem_sessao() { local cd="${1:-$HOME/.claude}" slug; slug="$(printf '%s' "$2" | sed 's/[^a-zA-Z0-9]/-/g')"; ls "$cd/projects/$slug/"*.jsonl >/dev/null 2>&1; }
# sessao_args <boss|equipe> <agente> <config_dir> <pasta>  → SESS_ARGS (--continue/--resume) e MEM_TXT (ler memoria.md)
sessao_args() {
  SESS_ARGS=(); MEM_TXT=""
  local f="$ORQ/relatorios/$2/memoria.md"
  if [ -n "${ORQ_RESUME:-}" ]; then SESS_ARGS=(--resume "$ORQ_RESUME"); return 0; fi
  if [ "$(sessao_cfg "$1" nova)" = continuar ] && tem_sessao "$3" "$4"; then SESS_ARGS=(--continue); return 0; fi
  if [ "$(sessao_cfg memoria true)" != false ] && [ -s "$f" ]; then MEM_TXT="MEMÓRIA: antes de qualquer coisa, leia $f — é o resumo do seu trabalho anterior (estado, decisões, pendências). Depois aguarde instruções."; fi
  return 0
}
