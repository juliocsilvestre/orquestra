#!/usr/bin/env bash
# Boss aprova uma entrega depois de revisar.  Uso: ../bin/ok.sh <agente> "<resumo do que foi aprovado>"
# (não faz nada no git — só registra a aprovação, que aparece no Estúdio e encerra a tarefa no fluxo)
agente="${1:?agente}"; resumo="${2:-aprovado}"
echo "✔ aprovado: $agente — $resumo"
