#!/usr/bin/env bash
# Sobe a equipe residente (equipe.conf) como filhos do terminal atual (o do Boss).
# Pode rodar de novo a qualquer momento: só sobe quem não está vivo.
# --so <agente>: sobe só esse agente (usado pelo Estúdio no botão "chamar"; funciona mesmo sem o Boss no ar).
set -uo pipefail
ORQ="$(cd "$(dirname "$0")/.." && pwd)"; PROJ="$(cd "$ORQ/.." && pwd)"
source "$ORQ/projeto.env"; source "$ORQ/bin/_lib.sh"
command -v hc >/dev/null || { echo "hc não encontrado (instale o Herdr app)"; exit 1; }
SO=""; [ "${1:-}" = "--so" ] && { SO="${2:?agente}"; set -- ; grep -qE "^$SO[[:space:]]" "$ORQ/equipe.conf" || { echo "$SO não está em equipe.conf"; exit 2; }; }
BOSS="${HC_TERMINAL_ID:-}"
[ -n "$BOSS" ] || [ -n "$SO" ] || { echo "Rode dentro de um terminal do Herdr (sem HC_TERMINAL_ID)."; exit 1; }
# versão das instruções da equipe: mudou → atualiza sozinho quem estiver parado
VERSAO="$( (cat "$ORQ/dev-protocolo.md" "$ORQ/dev-settings.json" "$ORQ/equipe.conf" "$ORQ"/taiga/CLAUDE.md "$ORQ"/logs/CLAUDE.md 2>/dev/null || true) | shasum | cut -c1-12)"
VFILE="$ORQ/relatorios/.equipe-versao"; mkdir -p "$ORQ/relatorios"
if [ -z "$SO" ] && [ "${1:-}" != "--reiniciar" ] && [ -f "$VFILE" ] && [ "$(cat "$VFILE")" != "$VERSAO" ]; then
  echo "instruções da equipe mudaram — atualizando quem está parado…"
  pend=0
  while read -r n _; do case "$n" in ''|\#*) continue;; esac
    st="$(hc_status "$n")"
    case "$st" in idle|done|-) hc kill "$(tn "$n")" >/dev/null 2>&1 && echo "↻ $n";; ausente) ;; *) echo "… $n está $st — atualiza na próxima vez"; pend=1;; esac
  done < "$ORQ/equipe.conf"
  sleep 2
  [ $pend = 0 ] || VERSAO="pendente"
fi
if [ "${1:-}" = "--reiniciar" ]; then
  # encerra a equipe deste projeto para subir de novo com as instruções atuais
  while read -r n _; do case "$n" in ''|\#*) continue;; esac; hc kill "$(tn "$n")" >/dev/null 2>&1 && echo "- $n encerrado"; done < "$ORQ/equipe.conf"
  sleep 2
fi
# migracao: agentes ainda com o nome antigo (sem o prefixo do projeto) sao encerrados e sobem com o nome novo
todos="$(grep -hv '^\s*#' "$ORQ/equipe.conf" | awk 'NF{print $1}' | tr '\n' ' ')"
[ -n "$SO" ] && todos="$SO"
hc_antigos "$PROJ" $todos | while read -r addr n; do hc kill "$addr" >/dev/null 2>&1 && echo "↻ $n (nome antigo → $(tn "$n"))"; done
sleep 1
vivos=" $(hc_vivos) "

nomes=(); pastas=(); contas=(); modelos=()
while read -r nome pasta conta modelo _; do
  case "$nome" in ''|\#*) continue;; esac
  [ -n "$SO" ] && [ "$nome" != "$SO" ] && continue
  case "$vivos" in *" $nome "*) hc label "$(tn "$nome")" "orq.projeto=$PROJ_ID" >/dev/null 2>&1 || true; echo "· $nome já está rodando"; continue;; esac
  nomes+=("$nome"); pastas+=("$PROJ/$pasta"); contas+=("${conta:-2}"); modelos+=("${modelo:-}")
done < "$ORQ/equipe.conf"
[ ${#nomes[@]} -gt 0 ] || { echo "Equipe completa."; [ -n "$SO" ] || echo "$VERSAO" > "$VFILE"; exit 0; }

# 1) prepara as mesas (worktrees dos devs, pastas dos especialistas)
fetched=" "
for i in "${!nomes[@]}"; do
  nome="${nomes[$i]}"; dir="${pastas[$i]}"
  if [[ "$nome" == dev-* ]]; then
    repo="${nome#dev-}"
    if [ ! -d "$dir" ]; then
      case "$fetched" in *" $repo "*) ;; *) git -C "$PROJ/$repo" fetch -q origin 2>/dev/null || echo "aviso: fetch de $repo falhou (VPN?)"; fetched="$fetched$repo ";; esac
      b="$(base_branch "$repo")"
      git -C "$PROJ/$repo" worktree add -q --detach "$dir" "$(base_ref "$repo" "$b")" || echo "x $nome: não criei o worktree"
    fi
    # front: reaproveita o node_modules da pasta original (lint/test sem npm install)
    if [ -d "$PROJ/$repo/node_modules" ] && [ -d "$dir" ] && [ ! -e "$dir/node_modules" ]; then ln -s "$PROJ/$repo/node_modules" "$dir/node_modules"; fi
  else
    mkdir -p "$dir"
  fi
done

# 2) pré-aprova a confiança das pastas, uma escrita por conta (antes de subir qualquer sessão)
for c in $(printf '%s\n' "${contas[@]}" | grep -E '^[0-9]+$' | sort -u); do
  ds=(); for i in "${!nomes[@]}"; do [ "${contas[$i]}" = "$c" ] && ds+=("${pastas[$i]}"); done
  if [ ${#ds[@]} -gt 0 ]; then trust_dirs "$(conta_dir "$c")" "${ds[@]}"; fi
done

# 3) sobe cada um
proto="$(cat "$ORQ/dev-protocolo.md")"
for i in "${!nomes[@]}"; do
  nome="${nomes[$i]}"; dir="${pastas[$i]}"; cfg="$(conta_dir "${contas[$i]}")"; mdl="${modelos[$i]}"
  [ -d "$dir" ] || continue
  if [[ "$nome" == dev-* ]]; then
    extra="$proto

Você é o dev RESIDENTE do repo ${nome#dev-} no projeto $PROJ_ID. Sua mesa (worktree) é $dir.
Aguarde mensagens do Boss que começam com TAREFA. Perguntas sobre o repo também podem chegar.
Para falar com o Boss use SEMPRE: $ORQ/bin/avisa-boss.sh \"<texto>\" (nunca hc send direto)."
  else
    extra="Você faz parte da equipe deste projeto ($PROJ_ID). Para falar com o Boss use SEMPRE: $ORQ/bin/avisa-boss.sh \"<resumo>\" (nunca hc send direto). Se for longo, escreva em $ORQ/relatorios/$nome/<assunto>.md e mande o caminho."
  fi
  # agente pode ter regras próprias (<pasta>/agente-settings.json) e argumentos extras (<pasta>/agente.args, aceita {PROJ} e {ORQ})
  sett="$ORQ/dev-settings.json"; [ -f "$dir/agente-settings.json" ] && sett="$dir/agente-settings.json"
  # skills que você liberou para este agente (Orquestra → Skills → liberar): settings próprio sem esse bloqueio
  if [ -s "$ORQ/skills/$nome/liberadas.json" ] && python3 "$ORQ/bin/skills_sync.py" "$ORQ" "$nome" "$dir" "$sett" --gerar-settings "$ORQ/skills/$nome/settings.gerado.json" 2>/dev/null; then sett="$ORQ/skills/$nome/settings.gerado.json"; fi
  xargs_=(); if [ -f "$dir/agente.args" ]; then while IFS= read -r a; do [ -n "$a" ] && xargs_+=("$(printf '%s' "$a" | sed "s#{PROJ}#$PROJ#g; s#{ORQ}#$ORQ#g")"); done < "$dir/agente.args"; fi
  # skills só deste agente + skills da equipe toda (pastas carregadas com --add-dir; editáveis pelo Orquestra)
  mkdir -p "$ORQ/skills/$nome/.claude/skills" "$ORQ/skills/_equipe/.claude/skills"
  # instruções extras definidas pelo usuário no Orquestra (agentes/<nome>.md)
  if [ -s "$ORQ/agentes/$nome.md" ]; then extra="$extra

INSTRUÇÕES ESPECÍFICAS DESTE AGENTE (definidas pelo usuário — têm prioridade):
$(cat "$ORQ/agentes/$nome.md")"; fi
  sessao_args equipe "$nome" "$cfg" "$dir"; [ -n "$MEM_TXT" ] && extra="$extra

$MEM_TXT"
  if [[ "${contas[$i]}" =~ ^[0-9]+$ ]]; then
  hc run --bg --no-notify --label "orq.projeto=$PROJ_ID" --name "$(tn "$nome")" --cwd "$dir" -- env ${cfg:+"CLAUDE_CONFIG_DIR=$cfg"} claude ${SESS_ARGS[@]+"${SESS_ARGS[@]}"} ${mdl:+--model "$mdl"} --settings "$sett" --add-dir "$ORQ/skills/$nome" --add-dir "$ORQ/skills/_equipe" ${xargs_[@]+"${xargs_[@]}"} --append-system-prompt "$extra" >/dev/null \
    && echo "+ $nome (conta ${contas[$i]})" || echo "x $nome não subiu"
  else
    # outro motor de IA (Codex, Gemini, Cursor, Copilot): as instruções vão como 1ª mensagem
    inst="$ORQ/relatorios/$nome/.instrucoes.md"; mkdir -p "$(dirname "$inst")"
    papel="$inst.papel"; { printf '%s\n' "$extra"; [ -f "$dir/CLAUDE.md" ] && { echo; cat "$dir/CLAUDE.md"; }; } > "$papel"
    # as mesmas regras, proibições e skills da equipe, por escrito (esses motores não leem as do Claude Code)
    python3 "$ORQ/bin/instrucoes-motor.py" "$ORQ" "$nome" "$dir" "$sett" "$papel" > "$inst" 2>/dev/null || cp "$papel" "$inst"
    hc run --bg --no-notify --label "orq.projeto=$PROJ_ID" --name "$(tn "$nome")" --cwd "$dir" -- "$ORQ/bin/motor.sh" "${contas[$i]}" "${mdl:--}" "$inst" >/dev/null \
      && echo "+ $nome (${contas[$i]})" || echo "x $nome não subiu"
  fi
  sleep 0.8
done
[ -n "$SO" ] || echo "$VERSAO" > "$VFILE"
