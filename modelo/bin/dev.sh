#!/usr/bin/env bash
# Dispara um dev (sub-agente) num worktree isolado de um repo do projeto.
# Uso (pelo Boss):  ../bin/dev.sh <repo> <slug> "<tarefa detalhada>"
#   repo: nome da pasta do repo no projeto
#   slug: curto, a-z0-9-  (ex: fix-logout)
set -euo pipefail
ORQ="$(cd "$(dirname "$0")/.." && pwd)"; PROJ="$(cd "$ORQ/.." && pwd)"
source "$ORQ/projeto.env"; source "$ORQ/bin/_lib.sh"
repo="${1:?repo}"; slug="${2:?slug}"; tarefa="${3:?tarefa}"
[ -e "$PROJ/$repo/.git" ] || { echo "repo inválido: $repo"; exit 1; }
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]{0,17}$ ]] || { echo "slug inválido (a-z0-9-, máx 18)"; exit 1; }

name="dev-$repo-$slug"
[ $(( ${#PROJ_ID} + 1 + ${#name} )) -le 32 ] || { echo "nome longo demais para o Herdr (max. 32): $PROJ_ID-$name — use um slug menor"; exit 1; }
wt="$PROJ/.worktrees/$repo-$slug"
branch="agente/$slug"
report="$ORQ/relatorios/$name.md"
G=(git -C "$PROJ/$repo")
"${G[@]}" fetch -q origin 2>/dev/null || echo "aviso: fetch falhou (VPN?), usando refs locais"
base="${BASE_BRANCH:-}"
if [ -z "$base" ]; then
  for b in develop main master; do
    if "${G[@]}" rev-parse -q --verify "origin/$b" >/dev/null || "${G[@]}" rev-parse -q --verify "$b" >/dev/null; then base="$b"; break; fi
  done
fi
[ -n "$base" ] || { echo "não achei branch base em $repo"; exit 1; }

if [ ! -d "$wt" ]; then
  if "${G[@]}" show-ref -q --verify "refs/heads/$branch"; then
    "${G[@]}" worktree add "$wt" "$branch"
  else
    ref="origin/$base"; "${G[@]}" rev-parse -q --verify "$ref" >/dev/null || ref="$base"
    "${G[@]}" worktree add --no-track -b "$branch" "$wt" "$ref"
  fi
fi

# Pré-aprova a "confiança na pasta" do Claude Code só para este worktree, na conta do dev
conf_dir="${DEV_CLAUDE_CONFIG_DIR:-}"
if [ -n "$conf_dir" ]; then cj="$conf_dir/.claude.json"; else cj="$HOME/.claude.json"; fi
if [ -f "$cj" ] && command -v python3 >/dev/null; then
  python3 - "$cj" "$wt" <<'PYT' || echo "aviso: não consegui pré-aprovar a pasta; aprove a tela de confiança manualmente"
import json, os, sys, tempfile
cj, wt = sys.argv[1], os.path.realpath(sys.argv[2])
with open(cj) as f: d = json.load(f)
proj = d.setdefault("projects", {}).setdefault(wt, {})
if not proj.get("hasTrustDialogAccepted"):
    proj["hasTrustDialogAccepted"] = True
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(cj))
    with os.fdopen(fd, "w") as f: json.dump(d, f, indent=2)
    os.replace(tmp, cj)
PYT
fi

aviso="Ao terminar (ou se travar), rode: $ORQ/bin/avisa-boss.sh \"$name: relatório em $report\""

prompt="TAREFA ($repo):
$tarefa

Worktree: $wt  (branch $branch, base $base)
Relatório final: $report
$aviso"

protocolo="$(cat "$ORQ/dev-protocolo.md")"
if [ -n "${DEV_CLAUDE_CONFIG_DIR:-}" ]; then
  hc run --bg --no-notify --label "orq.projeto=$PROJ_ID" --name "$(tn "$name")" --cwd "$wt" -- \
    env "CLAUDE_CONFIG_DIR=$DEV_CLAUDE_CONFIG_DIR" claude --settings "$ORQ/dev-settings.json" --append-system-prompt "$protocolo" "$prompt"
else
  hc run --bg --no-notify --label "orq.projeto=$PROJ_ID" --name "$(tn "$name")" --cwd "$wt" -- claude --settings "$ORQ/dev-settings.json" --append-system-prompt "$protocolo" "$prompt"
fi
echo "$name iniciado em $wt"
