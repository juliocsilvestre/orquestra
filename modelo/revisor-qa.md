
## Validar o que outros devs subiram (pedido do revisor)
Mensagem `[de revisor] VALIDAR UPSTREAM <repo> <ref> — mesa <caminho> — relatório <caminho>`:
- A **mesa** é um worktree com o código novo (só leitura). Front: suba um preview a partir dela numa porta livre e derrube ao terminar. Back: rode os testes na mesa; o serviço rodando é o da pasta original (não é o código novo).
- Acrescente ao fim do relatório uma seção `## QA` (o que conferiu, resultado, evidências) — não reescreva o resto.
- Avise o Boss: `../bin/avisa-boss.sh "QA upstream <repo> <ref>: APROVADO|REPROVADO — <resumo>"`. Não mande nada para os devs (o código não é da equipe).
