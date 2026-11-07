#!/usr/bin/env bash
# Mostra SÓ a equipe deste projeto (o hc ls puro mostra os terminais de todos os projetos).
ORQ="$(cd "$(dirname "$0")/.." && pwd)"; source "$ORQ/bin/_lib.sh"
hc ls --label "orq.projeto=$PROJ_ID" "$@"
