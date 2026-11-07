#!/usr/bin/env bash
# Revisor do upstream: vê o que OUTROS devs subiram no remoto — commits novos em develop/main e PRs/MRs abertos —
# e chama o agente "revisor" só quando há novidade. A checagem em si não gasta tokens.
#
#   upstream.sh                          uma checagem
#   upstream.sh --loop                   serviço srv-revisor: checa a cada UPSTREAM_MIN minutos (padrão 15)
#   upstream.sh --agora <repo> [branch]  revisa agora o que falta você puxar nesse repo
#
# Configuração opcional em projeto.env: UPSTREAM_MIN=15  UPSTREAM_BRANCHES="develop main master"
set -uo pipefail
ORQ="$(cd "$(dirname "$0")/.." && pwd)"; PROJ="$(cd "$ORQ/.." && pwd)"
source "$ORQ/projeto.env"; source "$ORQ/bin/_lib.sh"
MIN="${UPSTREAM_MIN:-15}"; BRS="${UPSTREAM_BRANCHES:-develop main master}"
D="$ORQ/relatorios/revisor"; EST="$D/estado"; ENT="$D/entrada"; mkdir -p "$EST" "$ENT"
PLAT=""
log() { echo "$(date '+%d/%m %H:%M') $*"; }

repos() {
  awk '!/^[[:space:]]*#/ && $1 ~ /^dev-/ { sub(/^dev-/, "", $1); print $1 }' "$ORQ/equipe.conf" |
    while read -r r; do [ -e "$PROJ/$r/.git" ] && echo "$r"; done
}

# mt <repo> <a> <b> → "sem conflito" | "**CONFLITO** em: arquivos" | "não verificado"
mt() {
  local g="$1" a="$2" b="$3" out rc base
  out="$(git -C "$g" merge-tree --write-tree --name-only --no-messages "$a" "$b" 2>/dev/null)"; rc=$?
  [ $rc = 0 ] && { echo "sem conflito"; return; }
  [ $rc = 1 ] && { echo "**CONFLITO** em: $(echo "$out" | sed 1d | head -15 | tr '\n' ' ')"; return; }
  base="$(git -C "$g" merge-base "$a" "$b" 2>/dev/null)" || { echo "não verificado"; return; }   # git < 2.38
  out="$(git -C "$g" merge-tree "$base" "$a" "$b" 2>/dev/null)" || { echo "não verificado"; return; }
  if echo "$out" | grep -q '^+<<<<<<<'; then
    echo "**CONFLITO** em: $(echo "$out" | awk '/^changed in both/{getline; getline; getline; print $NF}' | sort -u | head -15 | tr '\n' ' ')"
  else echo "sem conflito"; fi
}

# conflitos_md <repo> <ref-novo> <arquivos-mudados>
conflitos_md() {
  local r="$1" ref="$2" files="$3" g="$PROJ/$1" cur atras frente sujos cruz="" f mesas
  cur="$(git -C "$g" symbolic-ref -q --short HEAD || echo '(sem branch)')"
  atras="$(git -C "$g" rev-list --count "HEAD..$ref" 2>/dev/null || echo '?')"
  frente="$(git -C "$g" rev-list --count "$ref..HEAD" 2>/dev/null || echo '?')"
  echo "### Seu repo local \`$r\` (branch \`$cur\`)"
  echo "- commits novos que você ainda não tem: $atras · commits seus que o remoto não tem: $frente"
  echo "- juntar com o seu HEAD: $(mt "$g" HEAD "$ref")"
  sujos="$(git -C "$g" status --porcelain 2>/dev/null | awk '{print $NF}')"
  if [ -n "$sujos" ]; then
    for f in $sujos; do echo "$files" | grep -qxF "$f" && cruz="$cruz \`$f\`"; done
    echo "- alterações não commitadas: $(echo "$sujos" | grep -c .) arquivo(s)${cruz:+ — **nos mesmos arquivos:**$cruz}"
  else echo "- nenhuma alteração não commitada"; fi
  echo "### Mesas dos devs da equipe (branches agente/*)"
  mesas="$(git -C "$g" worktree list --porcelain 2>/dev/null | awk '/^worktree /{w=$2} /^branch refs\/heads\/agente\//{sub("refs/heads/","",$2); print w" "$2}' |
    while read -r w b; do echo "- \`$(basename "$w")\` em \`$b\`: $(mt "$g" "$b" "$ref")"; done)"
  echo "${mesas:-- nenhuma tarefa em andamento neste repo}"
}

# mesa <repo> <nome> <ref> → worktree só de leitura/testes com o código novo
mesa() {
  local r="$1" w="$PROJ/.worktrees/rev-$1-$2" sha; sha="$(git -C "$PROJ/$1" rev-parse "$3")"
  if [ -e "$w/.git" ]; then git -C "$w" checkout -q -f --detach "$sha" 2>/dev/null
  else git -C "$PROJ/$r" worktree add -q --detach "$w" "$sha" 2>/dev/null; fi
  if [ -d "$PROJ/$r/node_modules" ] && [ -d "$w" ] && [ ! -e "$w/node_modules" ]; then ln -s "$PROJ/$r/node_modules" "$w/node_modules"; fi
  echo "$w"
}

avisa_revisor() {
  local msg="$1" st; st="$(hc_status revisor)"
  case "$st" in
    idle|done|-)
      hc send "$(tn revisor)" "/clear" >/dev/null 2>&1; sleep 2
      hc send "$(tn revisor)" "[de upstream] $msg" >/dev/null 2>&1 && { log "→ revisor: $msg"; return; } ;;
  esac
  printf '\n- %s · de upstream: %s\n' "$(date '+%d/%m %H:%M')" "$msg" >> "$D/caixa.md"
  log "revisor $st — guardado em relatorios/revisor/caixa.md: $msg"
}

# revisa_branch <repo> <branch> <de> <para> <motivo>
revisa_branch() {
  local r="$1" b="$2" de="$3" para="$4" motivo="$5" g="$PROJ/$1" n files f w
  n="$(git -C "$g" rev-list --count "$de..$para" 2>/dev/null || echo 0)"; [ "$n" = 0 ] && return
  files="$(git -C "$g" diff --name-only "$de" "$para")"
  f="$ENT/$(date '+%Y-%m-%d_%H%M%S')-$r-$b.md"; w="$(mesa "$r" "$b" "$para")"
  { echo "# Entrada · $r · origin/$b · $(date '+%d/%m/%Y %H:%M')"; echo
    echo "- motivo: $motivo"
    echo "- intervalo: \`${de:0:9}..${para:0:9}\` — $n commit(s)"
    echo "- diff: \`git -C $g diff $de $para\`"
    echo "- mesa de revisão (código novo; só leitura e testes): \`$w\`"
    echo; echo "## Commits"
    git -C "$g" log --format='- `%h` %an · %ad · %s' --date=format:'%d/%m %H:%M' "$de..$para" | head -60
    echo; echo "## Arquivos ($(echo "$files" | grep -c .))"; echo '```'
    git -C "$g" diff --stat=110 "$de" "$para" | tail -40; echo '```'
    echo; echo "## Conflitos com o nosso trabalho"; conflitos_md "$r" "$para" "$files"
  } > "$f"
  avisa_revisor "REVISAR UPSTREAM $r origin/$b ($n commit(s)) — entrada: $f"
}

# revisa_pr <repo> <num> <base> <head> <autor> <url> <titulo> <motivo>
revisa_pr() {
  local r="$1" num="$2" base="$3" head="$4" autor="$5" url="$6" titulo="$7" motivo="$8" g="$PROJ/$1"
  local ref="refs/orquestra/pr-$num" src mb files f w n
  if [ "$PLAT" = gh ]; then src="refs/pull/$num/head"; else src="refs/merge-requests/$num/head"; fi
  git -C "$g" fetch -q origin "+$src:$ref" 2>/dev/null || { log "x $r #$num: não consegui baixar o PR"; return; }
  mb="$(git -C "$g" merge-base "refs/remotes/origin/$base" "$ref" 2>/dev/null)" || return
  n="$(git -C "$g" rev-list --count "$mb..$ref")"; files="$(git -C "$g" diff --name-only "$mb" "$ref")"
  f="$ENT/$(date '+%Y-%m-%d_%H%M%S')-$r-pr-$num.md"; w="$(mesa "$r" "pr-$num" "$ref")"
  { echo "# Entrada · $r · PR/MR #$num · $(date '+%d/%m/%Y %H:%M')"; echo
    echo "- motivo: $motivo"
    echo "- título: $titulo"; echo "- autor: $autor · \`$head\` → \`$base\`"; echo "- link: $url"
    echo "- diff: \`git -C $g diff $mb $ref\` ($n commit(s))"
    echo "- mesa de revisão (código do PR; só leitura e testes): \`$w\`"
    echo "- juntar o PR em origin/$base: $(mt "$g" "refs/remotes/origin/$base" "$ref")"
    echo; echo "## Commits"
    git -C "$g" log --format='- `%h` %an · %ad · %s' --date=format:'%d/%m %H:%M' "$mb..$ref" | head -60
    echo; echo "## Arquivos ($(echo "$files" | grep -c .))"; echo '```'
    git -C "$g" diff --stat=110 "$mb" "$ref" | tail -40; echo '```'
    echo; echo "## Conflitos com o nosso trabalho"; conflitos_md "$r" "$ref" "$files"
  } > "$f"
  avisa_revisor "REVISAR PR $r #$num ($titulo) — entrada: $f"
}

checa_prs() {
  local r="$1" g="$PROJ/$1" url json linhas sf primeira=0
  url="$(git -C "$g" config --get remote.origin.url 2>/dev/null)"
  case "$url" in *github.com*) PLAT=gh;; *gitlab*) PLAT=glab;; *) return;; esac
  command -v "$PLAT" >/dev/null || return
  if [ "$PLAT" = gh ]; then json="$(cd "$g" && gh pr list --state open --limit 30 --json number,title,author,headRefName,baseRefName,url,headRefOid 2>/dev/null)"
  else json="$(cd "$g" && { glab mr list --per-page 30 -F json 2>/dev/null || glab mr list --per-page 30 --output json 2>/dev/null; })"; fi
  [ -n "$json" ] || return
  linhas="$(printf '%s' "$json" | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: sys.exit()
for p in d:
    a = p.get("author") or {}
    n = p.get("number") or p.get("iid"); sha = p.get("headRefOid") or p.get("sha") or ""
    base = p.get("baseRefName") or p.get("target_branch") or ""; head = p.get("headRefName") or p.get("source_branch") or ""
    autor = a.get("login") or a.get("username") or a.get("name") or "?"; url = p.get("url") or p.get("web_url") or ""
    t = (p.get("title") or "").replace("\t", " ").replace("\n", " ")
    print("\t".join(map(str, [n, sha, base, head, autor, url, t])))')"
  sf="$EST/$r.prs"; [ -f "$sf" ] || { primeira=1; : > "$sf"; }
  local abertos="" num sha base head autor link titulo antigo
  while IFS=$'\t' read -r num sha base head autor link titulo; do
    [ -n "$num" ] || continue
    abertos="$abertos $num "
    case "$head" in agente/*) continue;; esac          # PR da nossa própria equipe
    antigo="$(awk -v n="$num" '$1==n{print $2}' "$sf")"
    [ "$antigo" = "$sha" ] && continue
    { grep -v "^$num " "$sf"; echo "$num $sha"; } > "$sf.tmp"; mv "$sf.tmp" "$sf"
    if [ $primeira = 1 ]; then
      printf -- '- #%s %s — %s (`%s` → `%s`) %s\n' "$num" "$titulo" "$autor" "$head" "$base" "$link" >> "$D/prs-abertos-$r.md"
      continue
    fi
    revisa_pr "$r" "$num" "$base" "$head" "$autor" "$link" "$titulo" "$([ -z "$antigo" ] && echo 'PR/MR novo' || echo 'PR/MR recebeu commits novos')"
  done <<< "$linhas"
  # PRs fechados: some a mesa de revisão deles
  while read -r num _; do
    [ -n "$num" ] || continue
    case "$abertos" in *" $num "*) continue;; esac
    git -C "$g" worktree remove --force "$PROJ/.worktrees/rev-$r-pr-$num" 2>/dev/null
    git -C "$g" update-ref -d "refs/orquestra/pr-$num" 2>/dev/null
    { grep -v "^$num " "$sf"; } > "$sf.tmp"; mv "$sf.tmp" "$sf"
  done < "$sf"
}

checa_repo() {
  local r="$1" g="$PROJ/$1" cur b sha sf last motivo n
  git -C "$g" fetch -q --prune origin 2>/dev/null || { log "x $r: fetch falhou (VPN/rede?)"; return; }
  cur="$(git -C "$g" symbolic-ref -q --short HEAD || true)"
  for b in $BRS; do
    sha="$(git -C "$g" rev-parse -q --verify "refs/remotes/origin/$b" 2>/dev/null)" || continue
    sf="$EST/$r.$b"; last=""; [ -f "$sf" ] && last="$(cat "$sf")"
    if [ -z "$last" ]; then
      # 1ª vez: só anota a linha de base (sem chamar o agente = sem gastar tokens) e lista o que falta você puxar
      if [ "$b" = "$cur" ]; then
        n="$(git -C "$g" rev-list --count "HEAD..$sha" 2>/dev/null || echo 0)"
        [ "$n" != 0 ] && printf -- '- %s · `%s` está %s commit(s) atrás de origin/%s — para revisar: `bin/upstream.sh --agora %s`\n' "$(date '+%d/%m %H:%M')" "$r" "$n" "$b" "$r" >> "$D/pendente-puxar.md"
      fi
      echo "$sha" > "$sf"; continue
    else motivo="commits novos no remoto"; fi
    if [ "$last" != "$sha" ] && git -C "$g" cat-file -e "$last^{commit}" 2>/dev/null; then revisa_branch "$r" "$b" "$last" "$sha" "$motivo"; fi
    echo "$sha" > "$sf"
  done
  checa_prs "$r"
}

case "${1:-}" in
  --loop)
    log "revisor do upstream: a cada $MIN min — repos: $(repos | tr '\n' ' ')· branches: $BRS"
    while true; do for r in $(repos); do checa_repo "$r"; done; sleep $((MIN * 60)); done ;;
  --agora)
    r="${2:?repo}"; g="$PROJ/$r"; [ -e "$g/.git" ] || { echo "repo inválido: $r"; exit 1; }
    git -C "$g" fetch -q --prune origin || { echo "fetch falhou (VPN/rede?)"; exit 1; }
    b="${3:-$(git -C "$g" symbolic-ref -q --short HEAD)}"
    sha="$(git -C "$g" rev-parse -q --verify "refs/remotes/origin/$b")" || { echo "origin/$b não existe"; exit 1; }
    de="$(git -C "$g" merge-base HEAD "$sha")"
    [ "$de" = "$sha" ] && { echo "$r: nada novo em origin/$b para puxar."; exit 0; }
    revisa_branch "$r" "$b" "$de" "$sha" "pedido manual — o que falta você puxar"; echo "$sha" > "$EST/$r.$b" ;;
  "") for r in $(repos); do checa_repo "$r"; done ;;
  *) sed -n 2,10p "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
