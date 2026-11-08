#!/usr/bin/env bash
# Sobe o projeto: Estúdio, serviços, equipe e o Boss (este terminal = boss-<projeto>). Rode num terminal do Herdr.
# Tudo o que acontece na subida fica em relatorios/.inicio.log
set -uo pipefail
ORQ="$(cd "$(dirname "$0")/.." && pwd)"; PROJ="$(cd "$ORQ/.." && pwd)"
source "$ORQ/projeto.env"; source "$ORQ/bin/_lib.sh"
command -v hc >/dev/null || { echo "hc (herdr-core) não encontrado. Instale o Herdr app primeiro."; exit 1; }
mkdir -p "$ORQ/relatorios"; LOG="$ORQ/relatorios/.inicio.log"
{ echo; echo "=== $(date '+%d/%m %H:%M:%S') boss.sh  HC_TERMINAL_ID=${HC_TERMINAL_ID:-<vazio>}  hc=$(hc --version 2>&1 | head -1)"; } >> "$LOG"
# sem pipe: se a etapa deixar algo rodando em segundo plano (ex.: o servidor do Orquestra), o pipe ficaria preso e o Boss nunca subiria
etapa() { local nome="$1" out rc; shift; echo "› $nome"; out="$(mktemp)"; "$@" >"$out" 2>&1 </dev/null; rc=$?; { echo "--- $nome"; cat "$out"; echo "(saída: $rc)"; } >>"$LOG"; cat "$out"; [ $rc = 0 ] || echo "(saída: $rc)"; rm -f "$out"; }
if [ -n "${HC_TERMINAL_ID:-}" ]; then
  hc label "$HC_TERMINAL_ID" "orq.projeto=$PROJ_ID" >>"$LOG" 2>&1 || echo "aviso: não consegui etiquetar este terminal" | tee -a "$LOG"
  hc label "$HC_TERMINAL_ID" "orq.papel=boss" >>"$LOG" 2>&1 || true
fi
etapa "estúdio" "$ORQ/bin/estudio.sh"
[ "${SEM_SERVICOS:-}" = 1 ] || etapa "serviços" "$ORQ/bin/servicos.sh"
[ "${SEM_EQUIPE:-}" = 1 ] || etapa "equipe" "$ORQ/bin/equipe.sh"
cd "$ORQ/boss"
cfg="$(conta_dir "${BOSS_CONTA:-1}")"
[ -n "$cfg" ] && export CLAUDE_CONFIG_DIR="$cfg"
# pasta do Boss já confiável: sem a tela "Do you trust this folder?" travando a subida (o andar foi criado por você no Orquestra)
trust_dirs "$cfg" "$ORQ/boss" >/dev/null 2>&1 || true
echo "› boss-$PROJ_ID" | tee -a "$LOG"
sessao_args boss boss "$cfg" "$ORQ/boss"
[ ${#SESS_ARGS[@]} -gt 0 ] && echo "› sessão: ${SESS_ARGS[*]}" | tee -a "$LOG"
mkdir -p "$ORQ/skills/boss/.claude/skills" "$ORQ/skills/_equipe/.claude/skills"
exec claude ${BOSS_MODELO:+--model "$BOSS_MODELO"} --add-dir "$PROJ" --add-dir "$ORQ/skills/boss" --add-dir "$ORQ/skills/_equipe" ${SESS_ARGS[@]+"${SESS_ARGS[@]}"} ${MEM_TXT:+--append-system-prompt "$MEM_TXT"} "$@"
