#!/usr/bin/env python3
"""Sincroniza as skills de um agente para os outros motores de IA (Codex, Gemini, Cursor, Copilot).

Todos seguem o padrão aberto Agent Skills (pasta com SKILL.md) e leem `.agents/skills/` da pasta
de trabalho. Este script copia para lá as MESMAS skills que o agente teria no Claude Code:
  1. só deste agente      (.orquestra/skills/<nome>/.claude/skills)
  2. da equipe do andar   (.orquestra/skills/_equipe/.claude/skills)
  3. do projeto/repo      (.claude/skills da pasta de trabalho e das pastas acima)
  4. pessoais             (~/.claude/skills)
…menos as bloqueadas por `Skill(...)` nas permissões do agente. Na dúvida de nome repetido, vale a
primeira fonte (a mais específica).

Regras:
- só mexe no que ele mesmo criou (lista em .agents/skills/.orquestra-sync.json); skills que o repo
  já tem em .agents/skills ficam intactas;
- coloca `.agents/skills/` no .git/info/exclude (nunca entra em commit);
- é cópia, não link: funciona em qualquer motor e dentro de sandbox.

Uso: skills_sync.py <ORQ> <nome> <pasta-de-trabalho> <settings.json> [--listar | --gerar-settings <saida.json>]
Liberadas: .orquestra/skills/<nome>/liberadas.json (lista de nomes) — vão mesmo estando bloqueadas.
Saída: JSON {pasta, skills:[{nome, descricao, fonte, arquivo}], removidas, conflitos}
"""
import json, os, re, shutil, subprocess, sys, time

HOME = os.path.expanduser('~')
MARCA = '.orquestra-sync.json'
IGNORA = shutil.ignore_patterns('.git', 'node_modules', '__pycache__', '.DS_Store')


def ler(f, limite=20000):
    try:
        with open(f, encoding='utf-8') as h: return h.read()[:limite]
    except Exception: return ''


def frontmatter(t):
    m = re.match(r'^---\n(.*?)\n---', t, re.S)
    fm = m.group(1) if m else ''
    g = lambda k: (re.search(rf'^{k}:\s*(.*)$', fm, re.M) or [None, ''])[1].strip().strip('"\'')
    return g('name'), g('description')


def regra_skill(r):
    """Regex da regra de bloqueio `Skill(...)` (ou None se não for de skill)."""
    if r == 'Skill': return re.compile('.*')
    if r.startswith('Skill(') and r.endswith(')'):
        alvo = re.sub(r' \*$', '', r[6:-1])
        return re.compile('^' + re.escape(alvo).replace(r'\*', '.*') + '$')
    return None


def liberadas(orq, nome):
    """Skills que o usuário liberou para este agente mesmo estando bloqueadas (Orquestra → Skills → liberar)."""
    try: return set(json.load(open(os.path.join(orq, 'skills', nome, 'liberadas.json'))))
    except Exception: return set()


def bloqueadas(settings, libs=()):
    try: deny = json.load(open(settings)).get('permissions', {}).get('deny', [])
    except Exception: deny = []
    pats = [p for p in map(regra_skill, deny) if p]
    return lambda n: (n or '') not in libs and any(p.match(n or '') for p in pats)


def gerar_settings(orq, nome, cwd, base, saida):
    """Copia o settings do agente tirando o bloqueio das skills liberadas. Se uma regra com * pegava
    outras skills também, elas continuam bloqueadas uma a uma."""
    libs = liberadas(orq, nome)
    try: s = json.load(open(base))
    except Exception: s = {}
    perm = s.setdefault('permissions', {}); deny = perm.get('deny', [])
    conhecidas = {x['nome'] for x in listar(orq, nome, cwd, '/dev/null')}
    novo, extra = [], []
    for r in deny:
        p = regra_skill(r)
        if p and any(p.match(n) for n in libs):
            extra += [f'Skill({n})' for n in sorted(conhecidas) if p.match(n) and n not in libs]
        else: novo.append(r)
    perm['deny'] = list(dict.fromkeys(novo + extra))
    s['_orquestra'] = f'gerado de {base} com as skills liberadas para {nome}: {", ".join(sorted(libs))} — não edite; mude pelo Orquestra'
    with open(saida, 'w') as h: json.dump(s, h, indent=2, ensure_ascii=False)


def fontes(orq, nome, cwd):
    proj = os.path.dirname(orq)
    fs = [(os.path.join(orq, 'skills', nome, '.claude', 'skills'), 'só deste agente'),
          (os.path.join(orq, 'skills', '_equipe', '.claude', 'skills'), 'da equipe')]
    d, n = os.path.realpath(cwd), 0
    while d and d not in (HOME, '/') and n < 8:
        fs.append((os.path.join(d, '.claude', 'skills'), 'do projeto'))
        if os.path.exists(os.path.join(d, '.git')) or d == proj: break
        d, n = os.path.dirname(d), n + 1
    fs.append((os.path.join(proj, '.claude', 'skills'), 'do projeto'))
    fs.append((os.path.join(HOME, '.claude', 'skills'), 'pessoais'))
    vistos, out = set(), []
    for base, rot in fs:
        r = os.path.realpath(base)
        if r in vistos or not os.path.isdir(r): continue
        vistos.add(r); out.append((base, rot))
    return out


def listar(orq, nome, cwd, settings):
    """As skills que este agente pode usar, na ordem de prioridade, sem repetidas e sem as bloqueadas."""
    bl, sk, nomes = bloqueadas(settings, liberadas(orq, nome)), [], set()
    for base, rot in fontes(orq, nome, cwd):
        try: ds = sorted(os.listdir(base))
        except Exception: continue
        for p in ds:
            f = os.path.join(base, p, 'SKILL.md')
            if not os.path.isfile(f): continue
            n, desc = frontmatter(ler(f, 4000)); n = n or p
            if n in nomes or bl(n): continue
            nomes.add(n); sk.append({'nome': n, 'pasta': p, 'descricao': desc, 'fonte': rot, 'origem': os.path.dirname(f)})
    return sk


def exclui_do_git(cwd):
    try:
        top = subprocess.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], capture_output=True, text=True, timeout=10).stdout.strip()
        exc = subprocess.run(['git', '-C', cwd, 'rev-parse', '--git-path', 'info/exclude'], capture_output=True, text=True, timeout=10).stdout.strip()
        if not top or not exc: return
        if not os.path.isabs(exc): exc = os.path.join(cwd, exc)
        rel = os.path.relpath(os.path.realpath(cwd), os.path.realpath(top))
        linha = '/' + ('' if rel == '.' else rel.replace(os.sep, '/') + '/') + '.agents/skills/'
        atual = ler(exc, 10**6)
        if linha not in atual.split('\n'):
            os.makedirs(os.path.dirname(exc), exist_ok=True)
            with open(exc, 'a') as h: h.write(('' if atual.endswith('\n') or not atual else '\n') + '# Orquestra: skills sincronizadas para outros motores\n' + linha + '\n')
    except Exception: pass


def sincronizar(orq, nome, cwd, settings):
    destino = os.path.join(cwd, '.agents', 'skills')
    sk = listar(orq, nome, cwd, settings)
    try: antes = set(json.load(open(os.path.join(destino, MARCA))).get('skills', []))
    except Exception: antes = set()
    os.makedirs(destino, exist_ok=True); exclui_do_git(cwd)
    feitas, conflitos = [], []
    for s in sk:
        alvo = os.path.join(destino, s['pasta'])
        if os.path.realpath(s['origem']) == os.path.realpath(alvo): continue
        if os.path.exists(alvo) and s['pasta'] not in antes: conflitos.append(s['nome']); continue  # é do repo: não mexe
        if os.path.islink(alvo) or os.path.isfile(alvo): os.unlink(alvo)
        elif os.path.isdir(alvo): shutil.rmtree(alvo)
        shutil.copytree(s['origem'], alvo, ignore=IGNORA, symlinks=False)
        feitas.append(s['pasta']); s['arquivo'] = os.path.join(alvo, 'SKILL.md')
    removidas = []
    for p in antes - set(feitas):
        alvo = os.path.join(destino, p)
        if os.path.isdir(alvo) and not os.path.islink(alvo): shutil.rmtree(alvo, ignore_errors=True); removidas.append(p)
    with open(os.path.join(destino, MARCA), 'w') as h:
        json.dump({'skills': feitas, 'quando': int(time.time()), 'agente': nome}, h)
    return {'pasta': destino, 'skills': [{k: s.get(k) for k in ('nome', 'descricao', 'fonte', 'arquivo')} for s in sk if s['pasta'] in feitas],
            'removidas': removidas, 'conflitos': conflitos}


if __name__ == '__main__':
    orq, nome, cwd, settings = sys.argv[1:5]
    if '--gerar-settings' in sys.argv: gerar_settings(orq, nome, cwd, settings, sys.argv[sys.argv.index('--gerar-settings') + 1])
    elif '--listar' in sys.argv: print(json.dumps(listar(orq, nome, cwd, settings), ensure_ascii=False))
    else: print(json.dumps(sincronizar(orq, nome, cwd, settings), ensure_ascii=False))
