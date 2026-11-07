#!/usr/bin/env bash
# Manda uma TAREFA para o dev residente de um repo.  Uso (Boss):  ../bin/tarefa.sh <repo> <slug> "<tarefa>"
set -euo pipefail
ORQ="$(cd "$(dirname "$0")/.." && pwd)"; PROJ="$(cd "$ORQ/.." && pwd)"
source "$ORQ/projeto.env"; source "$ORQ/bin/_lib.sh"
repo="${1:?repo}"; slug="${2:?slug}"; texto="${3:?tarefa}"
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || { echo "slug inválido (a-z0-9-)"; exit 1; }
[ -d "$PROJ/$repo/.git" ] || [ -f "$PROJ/$repo/.git" ] || { echo "repo inválido: $repo"; exit 1; }
nome="dev-$repo"; BOSS="${HC_TERMINAL_ID:-boss}"
st="$(hc_status "$nome")"
case "$st" in
  ausente) echo "$nome não está rodando. Rode ../bin/equipe.sh"; exit 1;;
  working|blocked) echo "$nome está ocupado ($st). Espere, ou use ../bin/dev.sh $repo $slug \"...\" para um dev extra."; exit 1;;
esac
git -C "$PROJ/$repo" fetch -q origin 2>/dev/null || echo "aviso: fetch falhou (VPN?) — base pode estar defasada"
b="$(base_branch "$repo")"; ref="$(base_ref "$repo" "$b")"
hc send "$(tn "$nome")" "/clear" >/dev/null 2>&1 && sleep 2   # cada tarefa começa com contexto limpo (mais barato e sem mistura)
mkdir -p "$ORQ/relatorios/$nome"; report="$ORQ/relatorios/$nome/$slug.md"
hc send "$(tn "$nome")" "TAREFA $slug ($repo)
$texto

Preparar antes de começar (na sua mesa): git status (tem que estar limpo) e depois git switch --no-track -c agente/$slug $ref   — se a branch já existir: git switch agente/$slug
Relatório: $report
Ao terminar: passe para o QA → $ORQ/bin/avisa-agente.sh qa \"VALIDAR $repo $slug: <o que mudou e como testar> — relatório em $report\"
Travou ou ficou em dúvida: $ORQ/bin/avisa-boss.sh \"$nome: $slug — <dúvida>\""
echo "tarefa $slug enviada para $nome (base $ref)"
