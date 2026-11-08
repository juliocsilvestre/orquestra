#!/usr/bin/env python3
"""Monta as instruções de um agente que roda em OUTRO motor de IA (Codex, Gemini, Cursor, Copilot).

Esses motores não leem as regras do Claude Code (settings.json, CLAUDE.md das pastas acima, skills),
então tudo vira texto: o papel do agente, as regras do projeto, o que é proibido e as skills disponíveis.

Uso: instrucoes-motor.py <ORQ> <nome> <pasta-de-trabalho> <settings.json> <arquivo-com-o-papel>
"""
import json, os, re, sys

orq, nome, cwd, settings, papel_f = sys.argv[1:6]
home = os.path.expanduser('~')
proj = os.path.dirname(orq)
out = []

def ler(f, limite=20000):
    try:
        with open(f, encoding='utf-8') as h: return h.read()[:limite]
    except Exception: return ''

# 1) papel do agente (protocolo do dev / instruções do especialista)
out.append(ler(papel_f).strip())

# 2) regras do projeto: CLAUDE.md da pasta de trabalho e das pastas acima (o Claude lê sozinho; aqui vai por escrito)
regras, d, vistos = [], os.path.realpath(cwd), set()
while d and d != home and d != '/' and len(regras) < 6:
    for f in ('CLAUDE.md', 'AGENTS.md'):
        p = os.path.join(d, f)
        if os.path.isfile(p) and os.path.realpath(p) not in vistos and not p.startswith(os.path.join(orq, nome)):
            vistos.add(os.path.realpath(p)); regras.append((p, ler(p, 12000)))
    d = os.path.dirname(d)
if regras:
    out.append('## REGRAS DO PROJETO (obrigatórias — valem para você do mesmo jeito que para os agentes Claude)')
    for p, t in regras: out.append(f'### {p.replace(home, "~")}\n{t.strip()}')

# 3) o que é proibido (as mesmas regras de bloqueio que o Claude Code aplica à equipe)
try: libs = set(json.load(open(os.path.join(orq, 'skills', nome, 'liberadas.json'))))
except Exception: libs = set()
try: deny = json.load(open(settings)).get('permissions', {}).get('deny', [])
except Exception: deny = []
proib = []
for r in deny:
    m = re.match(r'^(\w+)\((.*)\)$', r)
    if not m: continue
    ferr, alvo = m.groups(); alvo = alvo.replace(':*', ' …').replace('//', '/')
    if ferr == 'Bash': proib.append(f'rodar comando que combine com: `{alvo}`')
    elif ferr in ('Read', 'Glob', 'Grep'): proib.append(f'ler/buscar: `{alvo}`')
    elif ferr in ('Edit', 'Write', 'MultiEdit', 'NotebookEdit'): proib.append(f'alterar/criar arquivos em: `{alvo}`')
    elif ferr == 'Skill' and not any(re.fullmatch(re.escape(alvo.replace(' …', '')).replace(r'\*', '.*'), n) for n in libs): proib.append(f'usar a skill: `{alvo}`')
proib.append('fazer push, merge, deploy ou mexer em develop/main sem o Boss dizer que o usuário autorizou')
out.append('## PROIBIDO (nunca faça, mesmo que pareça necessário — se precisar, peça ao Boss)\n' + '\n'.join(f'- {x}' for x in dict.fromkeys(proib)))

# 4) skills: as mesmas do Claude, copiadas para .agents/skills (padrão Agent Skills, que o motor carrega sozinho)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import skills_sync
    r = skills_sync.sincronizar(orq, nome, cwd, settings)
    sk = [f"- **{s['nome']}** ({s['fonte']}): {s['descricao']}" for s in r['skills']]
    if sk:
        out.append('## SKILLS (as mesmas da equipe Claude — já instaladas em `.agents/skills/`, seu motor carrega sozinho)\n'
                   'Se o seu motor não listar alguma, leia o `.agents/skills/<nome>/SKILL.md` e siga. Não edite essas cópias: quem mantém é o Orquestra.\n' + '\n'.join(sk))
except Exception as e:
    out.append(f'## SKILLS\n(não consegui sincronizar: {e})')

print('\n\n'.join(x for x in out if x))
