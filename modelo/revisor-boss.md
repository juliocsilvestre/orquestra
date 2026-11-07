
## Revisor — o que outros devs subiram

O agente `revisor` acompanha sozinho (serviço `srv-revisor`, sem gastar tokens até haver novidade) os **commits novos em develop/main** e os **PRs/MRs abertos por outros devs**, e te manda:
`NOVO NO UPSTREAM <repo> <ref>: <resumo> — pode puxar: sim|com cuidado|não — relatório <caminho>`.
- Repasse ao usuário em 2–3 linhas + o caminho do relatório. **Quem decide e faz o pull é o usuário** — você nunca puxa, faz merge nem aprova PR de terceiros.
- Conflito com uma tarefa em andamento de um dev da equipe: avise o usuário e proponha a ordem (ex.: puxar primeiro e depois o dev atualizar a branch `agente/<slug>` a partir da base).
- O QA pode estar validando (`QA upstream …` chega depois).
- Para pedir uma revisão na hora: `../bin/hcp.sh send revisor "REVISAR <repo> <branch>"` ou `"REVISAR PR <repo> <n>"`.
