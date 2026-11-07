#!/usr/bin/env bash
# Cria um andar (projeto) novo no Orquestra: Boss + um dev residente por repo + QA + GitHub.
#
#   ./novo-andar.sh <pasta-do-projeto> [--id loja] [--titulo "Loja Online"] [--contas 1|2] [--base main]
#
# <pasta-do-projeto> é a pasta que CONTÉM os repos (ex.: ~/Projetos/loja com api/ e web/ dentro).
# Cria <pasta>/.orquestra, registra o projeto em ~/.orquestra/config.json e instala o servidor em ~/.orquestra/server.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
OH="${ORQUESTRA_HOME:-$HOME/.orquestra}"

[ $# -ge 1 ] || { sed -n 2,7p "$0" | sed 's/^# \{0,1\}//'; exit 1; }
PROJ="$(cd "$1" && pwd)"; shift
ID=""; TITULO=""; CONTAS=1; BASE=""; FORCAR=0
while [ $# -gt 0 ]; do case "$1" in
  --id) ID="$2"; shift 2;; --titulo) TITULO="$2"; shift 2;; --contas) CONTAS="$2"; shift 2;; --base) BASE="$2"; shift 2;; --forcar) FORCAR=1; shift;;
  *) echo "opção desconhecida: $1"; exit 1;; esac; done
[ -n "$TITULO" ] || TITULO="$(basename "$PROJ")"
[ -n "$ID" ] || ID="$(basename "$PROJ" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | sed 's/^-*//; s/-*$//' | cut -c1-12)"
[[ "$ID" =~ ^[a-z][a-z0-9-]{0,11}$ ]] || { echo "--id precisa ser curto (até 12), minúsculo, começando por letra: $ID"; exit 1; }

falta=0
for c in hc claude node python3 git; do command -v "$c" >/dev/null || { echo "✗ falta: $c"; falta=1; }; done
[ $falta = 0 ] || { echo "Instale o que falta (Herdr → hc, Claude Code → claude, Node.js, Python 3, git) e rode de novo."; exit 1; }

ORQ="$PROJ/.orquestra"
if [ -e "$ORQ" ] && [ $FORCAR = 0 ]; then echo "Já existe $ORQ (use --forcar para recriar a partir do modelo)."; exit 1; fi

# repos = subpastas com .git
repos=(); for d in "$PROJ"/*/; do d="${d%/}"; [ -e "$d/.git" ] && repos+=("$(basename "$d")"); done
[ ${#repos[@]} -gt 0 ] || { echo "Nenhum repo git dentro de $PROJ (a pasta deve conter os repos)."; exit 1; }
if [ -z "$BASE" ]; then BASE=main; git -C "$PROJ/${repos[0]}" rev-parse -q --verify origin/develop >/dev/null 2>&1 && BASE=develop; fi
echo "› projeto: $TITULO ($ID)  repos: ${repos[*]}  base: $BASE  contas: $CONTAS"

# 1) .orquestra a partir do modelo
mkdir -p "$ORQ"
cp -R "$REPO/modelo/bin" "$REPO/modelo/boss" "$REPO/modelo/qa" "$REPO/modelo/github" "$REPO/modelo/dev-protocolo.md" "$REPO/modelo/dev-settings.json" "$ORQ/"
[ -f "$ORQ/projeto.env" ] || cp "$REPO/modelo/projeto.env" "$ORQ/"
mkdir -p "$ORQ/estudio/data" "$ORQ/relatorios"
mkdir -p "$ORQ/boss/.claude" && mv "$ORQ/boss/claude-settings.json" "$ORQ/boss/.claude/settings.json"
cp "$REPO/modelo/hook.mjs" "$ORQ/estudio/hook.mjs"
chmod +x "$ORQ"/bin/*.sh

conta_eq=$([ "$CONTAS" = 2 ] && echo 2 || echo 1)
{ echo "# Equipe residente de $TITULO. Sobe junto com o Boss."
  echo "# nome   pasta (relativa ao projeto)   conta (1|2)   modelo (opus|sonnet|haiku)"
  for r in "${repos[@]}"; do printf '%-22s %-34s %s  sonnet\n' "dev-$r" ".worktrees/dev-$r" "$conta_eq"; done
  printf '%-22s %-34s %s  sonnet\n' qa .orquestra/qa "$conta_eq"
  printf '%-22s %-34s %s  sonnet\n' github .orquestra/github "$conta_eq"; } > "$ORQ/equipe.conf"
[ -f "$ORQ/servicos.conf" ] || { echo "# Serviços do projeto (terminais srv-* no Herdr). Subir/parar também pelo Orquestra."
  echo "# nome        pasta     comando   [#parar: comando para derrubar]   [#manual = não sobe sozinho]"
  for r in "${repos[@]}"; do
    if [ -f "$PROJ/$r/package.json" ]; then echo "# srv-$r   $r   npm run dev   #manual"
    elif [ -f "$PROJ/$r/docker-compose.yml" ] || [ -f "$PROJ/$r/compose.yaml" ]; then echo "# srv-$r   $r   docker compose up   #parar: docker compose down   #manual"
    else echo "# srv-$r   $r   <comando>   #manual"; fi
  done; } > "$ORQ/servicos.conf"

python3 - "$ORQ" "$ID" "$TITULO" "$BASE" "$REPO" "${repos[@]}" <<'PY'
import json, os, sys
orq, pid, titulo, base, repo, *repos = sys.argv[1:]
cores = ["#e8875a", "#5aa9ff", "#b98cff", "#4fd1c5", "#f2c14e", "#ff9ecd", "#8bd450", "#c4a484", "#a0a8b8"]
sub = {"__TITULO__": titulo, "__BASE__": base,
       "__MAPA__": "\n".join(f"| `{r}` | (descreva) | (comandos) |" for r in repos),
       "__EQUIPE__": "\n".join(f"| `dev-{r}` | dev residente de `{r}`; mesa = `../../.worktrees/dev-{r}` |" for r in repos),
       "__ORQ__": orq}
for root, _, files in os.walk(orq):
    if "/relatorios" in root or "/estudio/data" in root: continue
    for f in files:
        if not f.endswith((".md", ".json")): continue
        p = os.path.join(root, f); s = open(p, encoding="utf-8").read(); t = s
        for k, v in sub.items(): t = t.replace(k, v)
        if t != s: open(p, "w", encoding="utf-8").write(t)
cfg = os.path.join(orq, "estudio", "config.json")
old = {}
try: old = json.load(open(cfg))
except Exception: pass
ui = old.get("ui", {})
ui.update({"title": titulo, "brand": titulo if len(titulo) <= 14 else titulo.split()[0], "subtitle": "ORQUESTRA DE AGENTES", "repos": repos,
           "colors": {r: cores[i % len(cores)] for i, r in enumerate(repos)}, "labels": ui.get("labels", {}),
           "special": {"qa": {"title": "QA", "sub": "valida no navegador (Playwright)", "color": "#e9ff70", "decor": "qa"},
                       "github": {"title": "GitHub", "sub": "PRs e checks", "color": "#ff6b35", "decor": "gitlab"}},
           "about": ui.get("about", f"{titulo}: " + ", ".join(repos))})
json.dump({**old, "project_id": pid, "ui": ui, "sessoes": old.get("sessoes", {"boss": "nova", "equipe": "nova", "memoria": True})}, open(cfg, "w"), indent=2, ensure_ascii=False)
PY

# 2) servidor central em ~/.orquestra
mkdir -p "$OH/server" "$OH/data"
cp "$REPO/server/server.mjs" "$OH/server/"; rm -rf "$OH/server/public"; cp -R "$REPO/server/public" "$OH/server/public"
python3 - "$OH/config.json" "$ID" "$ORQ" "$CONTAS" <<'PY'
import json, os, sys
f, pid, orq, contas = sys.argv[1:]
try: c = json.load(open(f))
except Exception:
    c = {"port": 4777, "projects": [], "accounts": [{"id": "conta1", "dir": "~/.claude"}],
         "prices": {"opus": {"input": 5, "output": 25}, "sonnet": {"input": 3, "output": 15}, "haiku": {"input": 1, "output": 5}, "default": {"input": 3, "output": 15}},
         "cacheWriteMult": 1.25, "cacheReadMult": 0.1}
if contas == "2" and not any(a["id"] == "conta2" for a in c["accounts"]): c["accounts"].append({"id": "conta2", "dir": "~/.claude-conta2"})
c["projects"] = [p for p in c["projects"] if p["id"] != pid] + [{"id": pid, "orq": orq.replace(os.path.expanduser("~"), "~", 1)}]
json.dump(c, open(f, "w"), indent=2, ensure_ascii=False)
PY

# 3) atalho no terminal
AT="$OH/atalhos.zsh"
[ -f "$AT" ] || cat > "$AT" <<'E'
# Atalhos do Orquestra — rode num terminal do Herdr (os agentes viram filhos desse terminal).
_orq() {
  local proj="$1"; shift
  [ -n "$HC_TERMINAL_ID" ] || { echo "Abra um terminal do Herdr para usar este atalho."; return 1; }
  [ -x "$proj/.orquestra/bin/boss.sh" ] || { echo "Orquestra não encontrada em $proj"; return 1; }
  cd "$proj/.orquestra/boss" && ../bin/boss.sh "$@"
}
E
grep -v "^$ID() " "$AT" > "$AT.tmp" || true; mv "$AT.tmp" "$AT"
echo "$ID() { _orq \"$PROJ\" \"\$@\"; }" >> "$AT"

echo
echo "✓ andar \"$TITULO\" criado em $ORQ"
echo
echo "Próximos passos:"
echo "  1. Uma vez só, carregue os atalhos no shell:   echo 'source $AT' >> ~/.zshrc   (ou ~/.bashrc) e abra outro terminal"
[ "$CONTAS" = 2 ] && echo "     2ª conta do Claude:   $ORQ/bin/setup-conta2.sh   (e faça /login nela)"
echo "  2. Complete o mapa dos repos em $ORQ/boss/CLAUDE.md e os serviços em $ORQ/servicos.conf"
echo "  3. Num terminal do Herdr, rode:   $ID"
echo "     (sobe o Orquestra, os serviços, a equipe e o Boss — converse com ele ali ou pela interface)"
