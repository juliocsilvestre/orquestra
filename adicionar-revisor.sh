#!/usr/bin/env bash
# Adiciona o agente REVISOR a um andar (projeto) que já existe — ou atualiza os arquivos dele.
# Ele acompanha o que OUTROS devs sobem (develop/main e PRs/MRs), analisa, chama o QA se precisar,
# avisa o Boss e escreve um relatório .md dizendo o que subiu, o que faz e se dá para puxar sem conflito.
#
#   ./adicionar-revisor.sh <pasta-do-projeto> [--forcar]     (--forcar: sobrescreve o CLAUDE.md do revisor)
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"; M="$REPO/modelo"
[ $# -ge 1 ] || { sed -n 2,6p "$0" | sed 's/^# \{0,1\}//'; exit 1; }
PROJ="$(cd "$1" && pwd)"; ORQ="$PROJ/.orquestra"; FORCAR="${2:-}"
[ -f "$ORQ/equipe.conf" ] || { echo "Não achei $ORQ/equipe.conf — crie o andar antes (novo-andar.sh)."; exit 1; }

mkdir -p "$ORQ/revisor" "$ORQ/relatorios/revisor"
cp "$M/bin/upstream.sh" "$ORQ/bin/upstream.sh"; chmod +x "$ORQ/bin/upstream.sh"
cp "$M/revisor/agente.args" "$ORQ/revisor/agente.args"
{ [ -f "$ORQ/revisor/CLAUDE.md" ] && [ "$FORCAR" != --forcar ]; } || cp "$M/revisor/CLAUDE.md" "$ORQ/revisor/CLAUDE.md"

python3 - "$ORQ" "$PROJ" "$M" <<'PY'
import json, os, re, sys
orq, proj, m = sys.argv[1:]
J = lambda *p: os.path.join(orq, *p)

# 1) permissões do revisor: as do GitHub/GitLab (ou QA) + só leitura no código
base = next((J(a, "agente-settings.json") for a in ("github", "gitlab", "qa") if os.path.exists(J(a, "agente-settings.json"))), J("dev-settings.json"))
s = json.load(open(base))
deny = [d for d in s.get("permissions", {}).get("deny", []) if d not in ("Bash(gh:*)", "Bash(glab:*)", "Bash(*/.agent/scripts*)", "Edit(**)", "Write(**)", "MultiEdit(**)", "NotebookEdit(**)")]
for c in ["merge", "rebase", "pull", "push", "commit", "checkout", "switch", "reset", "stash", "cherry-pick", "revert", "clean", "worktree", "tag", "update-ref"]:
    deny += [f"Bash(git {c}:*)", f"Bash(*git * {c} *)", f"Bash(*git * {c})"]
deny += ["Bash(*git * branch -d*)", "Bash(*git * branch -D*)",
         "Bash(gh pr merge*)", "Bash(gh pr close*)", "Bash(gh pr review*)", "Bash(gh pr comment*)", "Bash(gh pr edit*)", "Bash(gh pr ready*)",
         "Bash(gh pr create*)", "Bash(gh issue create*)", "Bash(gh issue comment*)", "Bash(gh issue close*)", "Bash(gh api*)", "Bash(gh repo*)",
         "Bash(gh release*)", "Bash(gh workflow run*)", "Bash(gh run rerun*)", "Bash(gh secret*)",
         "Bash(glab mr merge*)", "Bash(glab mr approve*)", "Bash(glab mr close*)", "Bash(glab mr note*)", "Bash(glab mr update*)", "Bash(glab mr create*)",
         "Bash(glab api*)", "Bash(glab ci run*)", "Bash(glab ci retry*)", "Bash(glab ci cancel*)", "Bash(glab release*)",
         "Bash(*docker compose up*)", "Bash(*docker-compose up*)", "Bash(*make up*)", "Bash(*npm run dev*)", "Bash(*ok.sh*)", "Bash(*tarefa.sh*)", "Bash(*dev.sh*)"]
alvos = [os.path.join(proj, d) for d in sorted(os.listdir(proj)) if os.path.exists(os.path.join(proj, d, ".git"))] + [os.path.join(proj, ".worktrees")]
for a in alvos:
    for t in ("Edit", "Write", "NotebookEdit"): deny.append(f"{t}(//{a.lstrip('/')}/**)")
s.setdefault("permissions", {})["deny"] = list(dict.fromkeys(deny))
s["permissions"].pop("allow", None)
json.dump(s, open(J("revisor", "agente-settings.json"), "w"), indent=2, ensure_ascii=False)

# 2) equipe.conf: o revisor na mesma conta do QA
eq = open(J("equipe.conf")).read()
if not re.search(r"^revisor\s", eq, re.M):
    conta = (re.search(r"^qa\s+\S+\s+(\d)", eq, re.M) or re.search(r"^dev-\S+\s+\S+\s+(\d)", eq, re.M))
    eq = eq.rstrip("\n") + f"\n{'revisor':<20} {'.orquestra/revisor':<33} {conta.group(1) if conta else '2'}      sonnet\n"
    open(J("equipe.conf"), "w").write(eq)

# 3) servicos.conf: o vigia do upstream (não gasta tokens)
sv = J("servicos.conf"); txt = open(sv).read() if os.path.exists(sv) else ""
if "upstream.sh" not in txt:
    open(sv, "w").write(txt.rstrip("\n") + "\nsrv-revisor     .orquestra                    ./bin/upstream.sh --loop\n")

# 4) aparece no escritório
cf = J("estudio", "config.json"); c = json.load(open(cf))
c.setdefault("ui", {}).setdefault("special", {})["revisor"] = {"title": "Revisor", "sub": "o que outros devs subiram", "color": "#38bdf8", "decor": "revisor"}
json.dump(c, open(cf, "w"), indent=2, ensure_ascii=False)

# 5) Boss e QA sabem do revisor
for alvo, trecho, marca in ((J("boss", "CLAUDE.md"), "revisor-boss.md", "## Revisor"), (J("qa", "CLAUDE.md"), "revisor-qa.md", "VALIDAR UPSTREAM")):
    if os.path.exists(alvo) and marca not in open(alvo).read():
        open(alvo, "a").write(open(os.path.join(m, trecho)).read())

# 6) avisa-agente.sh: o revisor pode passar para o QA
aa = J("bin", "avisa-agente.sh"); t = open(aa).read()
if "revisor)" not in t:
    t = t.replace('  dev-*) [ "$alvo" = qa ] && ok=1;;', '  dev-*|revisor) [ "$alvo" = qa ] && ok=1;;', 1)
    t = t.replace("#   dev-*  → qa ", "#   dev-*, revisor → qa ", 1)
    open(aa, "w").write(t)
print("ok")
PY

grep -q '^UPSTREAM_MIN=' "$ORQ/projeto.env" || cat >> "$ORQ/projeto.env" <<'E'

# Revisor do upstream (srv-revisor): de quanto em quanto tempo olha o remoto e quais branches acompanha
UPSTREAM_MIN=15
UPSTREAM_BRANCHES="develop main master"
E

echo "✓ revisor adicionado em $ORQ"
echo "  Para subir agora: no Orquestra, chame o Revisor e suba o serviço srv-revisor — ou reinicie o Boss (/exit e o atalho do projeto)."
echo "  Revisão na hora:  $ORQ/bin/upstream.sh --agora <repo> [branch]"
