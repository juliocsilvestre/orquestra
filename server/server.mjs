#!/usr/bin/env node
// Estúdio — um prédio, uma sala por projeto. Junta hc + hooks + transcripts e manda pro navegador (SSE).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const exp = (p) => p.replace(/^~(?=\/|$)/, HOME).replace(/^\$HOME/, HOME);
const CFG_FILE = process.env.ORQ_CONFIG || path.join(DIR, 'config.json'); // o app (Orquestra) pode apontar outra configuração
const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const PORT = Number(process.env.PORT || cfg.port || 4777);
const HC = process.env.HC_BIN || 'hc';
const TOKEN = crypto.randomBytes(16).toString('hex');
const perf = { started: Date.now(), firstScanMs: null }; // tempos (ms) de cada rotina — em /health
const tick = () => new Promise((r) => setImmediate(r)); // devolve a vez para o servidor responder enquanto lê arquivos grandes
const timed = (nome, ms) => { perf[nome] = ms; perf[nome + 'Max'] = Math.max(perf[nome + 'Max'] || 0, ms); if (ms > 800) console.log(`[lento] ${nome}: ${ms} ms`); };
const CODE_MTIME = (() => { try { return Math.floor(fs.statSync(fileURLToPath(import.meta.url)).mtimeMs); } catch { return 0; } })();
const ACCOUNTS = cfg.accounts.map((a) => ({ ...a, provedor: a.provedor || 'claude', dir: exp(a.dir) }));
// outros motores de IA que um agente pode usar (além das contas do Claude)
const PROVEDORES = {
  claude: { nome: 'Claude (Anthropic)', cli: 'claude' },
  codex: { nome: 'Codex (OpenAI / ChatGPT)', cli: 'codex', home: '~/.codex', login: 'codex login', instalar: { darwin: 'brew install codex', outro: 'npm install -g @openai/codex' }, logado: (d) => fs.existsSync(path.join(d, 'auth.json')), modelos: ['gpt-5-codex', 'gpt-5', 'gpt-5-mini'] },
  gemini: { nome: 'Gemini (Google)', cli: 'gemini', home: '~/.gemini', login: 'gemini', instalar: { darwin: 'brew install gemini-cli', outro: 'npm install -g @google/gemini-cli' }, logado: (d) => fs.existsSync(path.join(d, 'oauth_creds.json')) || !!process.env.GEMINI_API_KEY, modelos: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  cursor: { nome: 'Cursor', cli: 'agent', home: '~/.cursor', login: 'agent login', instalar: { darwin: 'curl https://cursor.com/install -fsS | bash', outro: 'curl https://cursor.com/install -fsS | bash' }, logado: (d) => { try { return /"(accessToken|authInfo|email)"/.test(fs.readFileSync(path.join(d, 'cli-config.json'), 'utf8')); } catch { return false; } }, modelos: ['auto', 'gpt-5', 'sonnet-4.5'] },
  copilot: { nome: 'GitHub Copilot', cli: 'copilot', home: '~/.copilot', login: 'copilot login', instalar: { darwin: 'npm install -g @github/copilot', outro: 'npm install -g @github/copilot' }, logado: (d) => { try { return /token|logged|user/i.test(fs.readFileSync(path.join(d, 'config.json'), 'utf8')); } catch { return false; } }, modelos: ['auto', 'claude-sonnet-4.5', 'gpt-5'] },
};
// o servidor não pertence a nenhum terminal do Herdr (se foi iniciado de dentro de um, o hc acharia que é aquele terminal)
delete process.env.HC_TERMINAL_ID;
const contaKey = (c) => (/^\d+$/.test(String(c)) ? 'conta' + c : String(c)); // equipe.conf: "2" = conta2 do Claude; "codex" = conta do Codex
const NOT_AGENTS = new Set(['estudio', 'bin', 'relatorios']);

// ---------- projetos (salas) ----------
function mkProject(p) {
  const orq = exp(p.orq);
  let ui = {}, atalho = p.id;
  try { const pc = JSON.parse(fs.readFileSync(path.join(orq, 'estudio', 'config.json'), 'utf8')); ui = pc.ui || {}; atalho = pc.atalho || p.id; } catch {}
  let team = [];
  try { team = fs.readFileSync(path.join(orq, 'equipe.conf'), 'utf8').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((n) => n && !n.startsWith('#')); } catch {}
  let svcDefs = [];
  try {
    svcDefs = fs.readFileSync(path.join(orq, 'servicos.conf'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
      const m = l.match(/^(\S+)\s+(\S+)\s+(.*)$/); if (!m) return null;
      const rest = m[3], cmd = rest.split('#')[0].trim(), stop = (rest.match(/#parar:\s*([^#]+)/) || [])[1]?.trim() || '';
      return { name: m[1], short: m[1].replace(/^srv-/, ''), pasta: m[2], cmd, stop, manual: /#manual/.test(rest) };
    }).filter(Boolean);
  } catch {}
  const servicesConf = svcDefs.map((d) => d.name);
  const data = path.join(orq, 'estudio', 'data');
  fs.mkdirSync(data, { recursive: true });
  return {
    id: p.id, atalho, orq, root: path.dirname(orq), ui: { ...ui, ...(p.ui || {}) }, team: ['boss', ...team], servicesConf, svcDefs, ports: [],
    eventsFile: path.join(data, 'events.jsonl'), evOffset: 0,
    special: new Set(Object.keys(ui.special || {})),
    hcOk: false, agents: {}, services: {}, usage: {}, chat: {}, interactions: [], rework: {}, byAddr: {},
    clients: new Set(), last: '',
  };
}
const projects = cfg.projects.map(mkProject);
const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
function addProjeto(entry) { const p = mkProject(entry); projects.push(p); byId[p.id] = p; readEvents(p, true); return p; }
const inside = (c, dir) => !!c && (c === dir || c.startsWith(dir + '/'));

function agentFromCwd(p, cwd) {
  if (!cwd) return null;
  if (cwd.startsWith(p.orq + '/')) {
    const top = cwd.slice(p.orq.length + 1).split('/')[0];
    return top && !NOT_AGENTS.has(top) ? top : null;
  }
  const m = cwd.match(/\/\.worktrees\/([^/]+)/);
  if (m && inside(cwd, p.root)) return m[1].startsWith('dev-') ? m[1] : 'dev-' + m[1];
  return null;
}

// ---------- SSE ----------
function send(res, type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(p, type, data) { for (const r of p.clients) send(r, type, data); }
function broadcastAll(type, data) { for (const p of projects) broadcast(p, type, data); }
const pub = (p) => ({ floorTerm: !!p.floorTerm, team: p.team, hcOk: p.hcOk, svcDefs: p.svcDefs.map(({ name, short, pasta, cmd, stop, manual }) => ({ name, short, pasta, cmd, stop: !!stop, manual })), ports: p.ports, services: p.services, agents: p.agents, usage: p.usage, rework: p.rework });
function rooms() {
  return projects.map((p) => {
    const a = Object.values(p.agents);
    return {
      id: p.id, title: p.ui.title || p.id, brand: p.ui.brand || p.ui.title || p.id, live: !!p.agents.boss, running: p.ports.length > 0 || Object.values(p.services).some((x) => x.live), ports: p.ports.map((x) => x.port),
      agents: a.length, working: a.filter((x) => x.status === 'working').length, blocked: a.filter((x) => x.status === 'blocked').length,
      today: Object.values(p.usage).reduce((s, u) => s + (u.today?.cost || 0), 0),
      statuses: Object.keys(p.agents).sort((x, y) => (x === 'boss' ? -1 : y === 'boss' ? 1 : x.localeCompare(y))).map((k) => p.agents[k].status),
      services: Object.values(p.services).map((x) => x.live),
      accent: p.ui.accent || null,
      about: p.ui.about || '',
      team: p.team.map((id) => ({ id, status: p.agents[id]?.status || null })),
      expected: p.team.length,
      servicesConf: p.servicesConf.map((n) => n.replace(/^srv-/, '')),
    };
  });
}
let lastRooms = '';
function emit(p) {
  const s = JSON.stringify(pub(p));
  if (s !== p.last) { p.last = s; broadcast(p, 'state', pub(p)); }
  const r = JSON.stringify(rooms());
  if (r !== lastRooms) { lastRooms = r; broadcastAll('rooms', rooms()); }
}

// ---------- hc ----------
function pollHc() {
  let buf = '', done = false; const t0 = Date.now();
  const ch = spawn(HC, ['events', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const fin = (snap) => {
    if (done) return; done = true;
    try { ch.kill(); } catch {}
    for (const p of projects) {
      if (snap) apply(p, snap); else if (p.hcOk) { p.hcOk = false; emit(p); }
    }
  };
  const timer = setTimeout(() => fin(null), 4000);
  ch.on('error', () => { clearTimeout(timer); fin(null); });
  ch.stdout.on('data', (d) => {
    buf += d;
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    clearTimeout(timer);
    let snap = null; try { snap = JSON.parse(buf.slice(0, nl)); } catch {}
    timed('pollHc', Date.now() - t0); perf.snapKB = Math.round(nl / 1024);
    fin(snap);
  });
}
function apply(p, snap) {
  const agents = {}, services = {}, byAddr = {}; let floorTerm = null;
  for (const t of snap.terminals || []) {
    const fg = t.foreground || {};
    const cwd = fg.cwd || t.cwd;
    if (!inside(cwd, p.root) && !inside(t.cwd, p.root)) continue; // só o que é desta sala
    const nm = t.name && t.name.startsWith(p.id + '-') ? t.name.slice(p.id.length + 1) : t.name; // nomes no Herdr: <projeto>-<agente>
    if (nm && nm.startsWith('srv-')) { services[nm.slice(4)] = { live: t.state === 'live', address: t.address }; continue; }
    if (nm === 'terminal' && t.state === 'live') floorTerm = t.address;
    if (t.state !== 'live') continue;
    let id = agentFromCwd(p, cwd) || agentFromCwd(p, t.cwd);
    if (!id && nm && (nm.startsWith('dev-') || p.special.has(nm))) id = nm;
    if (!id || (id === 'boss' && agents.boss)) continue;
    const fgNome = path.basename(String(fg.name || (fg.argv || [])[0] || ''));
    if (id === 'boss' && nm === 'terminal' && /^-?(zsh|bash|sh|fish|dash)$/.test(fgNome) && !/boss\.sh/.test((fg.argv || []).join(' '))) continue; // só o shell do andar parado na pasta do Boss: o Boss não está no ar
    const argv = [...(t.argv || []), ...(fg.argv || [])].join(' ');
    let conta = null;
    for (const a of ACCOUNTS) if (a.dir !== exp('~/.claude') && argv.includes('CLAUDE_CONFIG_DIR=' + a.dir)) conta = a.id;
    const mt = argv.match(/motor\.sh\s+(\S+)(?:\s+(\S+))?/); if (mt) conta = mt[1];
    agents[id] = {
      id, address: t.address, fg: fgNome, status: (t.status && t.status.state) || (id === 'boss' && /boss\.sh/.test((fg.argv || []).join(' ')) ? 'starting' : 'idle'), title: t.title || '', turn: t.turn || 0,
      parent: t.parent, conta: conta || p.usage[id]?.conta || null, ctx: (() => { try { const j = JSON.parse(fs.readFileSync(path.join(SB_DIR, t.address + '.json'), 'utf8')); return (j.meters || []).find((m) => m.label === 'ctx')?.percent ?? null; } catch { return null; } })(), model: (() => { try { return JSON.parse(fs.readFileSync(path.join(SB_DIR, t.address + '.json'), 'utf8')).model || null; } catch { return null; } })(),
    };
    if (agents[id].status === 'done' && p.ack?.[id]) agents[id].status = 'idle'; // você já deu ok
    if (['idle', 'done'].includes(agents[id].status)) { const q = perguntaPendente(p, id); if (q) agents[id].pergunta = q; }
    else if (agents[id].status !== 'done' && p.ack?.[id]) delete p.ack[id];
    byAddr[t.address] = id;
  }
  p.agents = agents; p.services = services; p.byAddr = byAddr; p.hcOk = true; p.floorTerm = floorTerm;
  emit(p);
  herdrSincroniza(p);
}

// ---------- interações (hooks) ----------
function readEvents(p, initial = false) {
  let st; try { st = fs.statSync(p.eventsFile); } catch { return; }
  if (st.size < p.evOffset) p.evOffset = 0;
  if (st.size === p.evOffset) return;
  const fd = fs.openSync(p.eventsFile, 'r');
  const buf = Buffer.alloc(st.size - p.evOffset);
  fs.readSync(fd, buf, 0, buf.length, p.evOffset); fs.closeSync(fd);
  const text = buf.toString('utf8'), lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return;
  p.evOffset += Buffer.byteLength(text.slice(0, lastNl + 1));
  for (const line of text.slice(0, lastNl).split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.to && /^t\d+[a-z]?$/.test(e.to) && p.byAddr[e.to]) e.to = p.byAddr[e.to];
    if (e.to && /^t\d+[a-z]?$/.test(e.to) && e.from !== 'boss') e.to = 'boss';
    if (e.from === 'boss' && e.kind === 'send' && !String(e.to).startsWith('dev-')) e.kind = 'ask';
    if (e.kind === 'report' && /^\s*(ALERTA|ATEN[ÇC][ÃA]O|NOVA|NOVO)\b/i.test(e.text || '')) e.kind = 'alert';
    if (e.kind === 'report' && /^\s*PIPELINE\b/i.test(e.text || '')) e.kind = /falh|erro|fail/i.test(e.text) ? 'pipefail' : 'pipeok';
    if (e.kind === 'report' && /^\s*QA\b/i.test(e.text || '')) e.kind = /REPROVAD/i.test(e.text) ? 'qafail' : /APROVAD/i.test(e.text) ? 'qaok' : 'report';
    if (e.from === 'boss' && e.kind === 'send' && /revis|corrij|ajust|falta|errad/i.test(e.text || '')) p.rework[e.to] = (p.rework[e.to] || 0) + 1;
    p.interactions.push(e);
    if (p.interactions.length > 300) p.interactions.shift();
    if (!initial) broadcast(p, 'interaction', e);
  }
  if (!initial) emit(p);
}

// ---------- tokens / custo ----------
const fileOffsets = new Map(), seenMsg = new Set();
function priceFor(model = '') {
  const m = model.toLowerCase();
  for (const [k, v] of Object.entries(cfg.prices)) if (k !== 'default' && m.includes(k)) return v;
  return cfg.prices.default;
}
const todayStr = () => new Date().toLocaleDateString('sv');
function addUsage(p, id, conta, model, u, ts) {
  { const t = Date.parse(ts); if (t) (acctTs[conta] ||= []).push(t); }
  const pr = priceFor(model);
  const inp = u.input_tokens || 0, out = u.output_tokens || 0, cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
  const cost = (inp * pr.input + out * pr.output + cw * pr.input * cfg.cacheWriteMult + cr * pr.input * cfg.cacheReadMult) / 1e6;
  const o = (p.usage[id] ||= { conta, model, in: 0, out: 0, cw: 0, cr: 0, cost: 0, msgs: 0, today: { in: 0, out: 0, cost: 0, msgs: 0 }, byDay: {} });
  o.conta = conta; o.model = model || o.model;
  o.in += inp; o.out += out; o.cw += cw; o.cr += cr; o.cost += cost; o.msgs++;
  const day = ts ? new Date(ts).toLocaleDateString('sv') : todayStr();
  o.byDay[day] = (o.byDay[day] || 0) + cost;
  if (day === todayStr()) { o.today.in += inp; o.today.out += out; o.today.cost += cost; o.today.msgs++; }
}
// ---------- conversa dos agentes (dos transcripts do Claude Code) ----------
let chatBooted = false;
const short = (s, n = 90) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = (f) => String(f || '').split('/').slice(-2).join('/');
function toolText(name, i = {}) {
  switch (name) {
    case 'Read': return 'lendo ' + base(i.file_path);
    case 'Edit': case 'MultiEdit': return 'editando ' + base(i.file_path);
    case 'Write': return 'escrevendo ' + base(i.file_path);
    case 'Bash': return '$ ' + short(i.command, 110);
    case 'Grep': return 'buscando "' + short(i.pattern, 40) + '"';
    case 'Glob': return 'procurando ' + short(i.pattern, 50);
    case 'Task': case 'Agent': return 'sub-agente: ' + short(i.description || i.prompt, 60);
    case 'WebFetch': return 'abrindo ' + short(i.url, 60);
    case 'WebSearch': return 'pesquisando ' + short(i.query, 60);
    case 'TodoWrite': return 'atualizando a lista de tarefas';
    case 'Skill': return 'usando a skill ' + short(i.skill || i.name, 40);
    default: return name.replace(/^mcp__/, '').replace(/__/g, ' · ');
  }
}
function chatItems(l, full = false) {
  const L1 = full ? Infinity : 4000, L2 = full ? Infinity : 6000;
  const ts = Date.parse(l.timestamp) || Date.now(), out = [], c = l.message.content;
  if (l.isMeta || l.isSidechain) return out;
  if (l.type === 'user') {
    const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
    if (txt && !/^<(command-|local-command|system-reminder)/.test(txt.trim())) {
      const hc = txt.match(/<hc from="[^"]*?([a-z][\w-]*)">/);
      out.push({ ts, role: 'user', kind: 'text', from: hc ? hc[1] : null, text: txt.replace(/<\/?hc[^>]*>/g, '').trim().slice(0, L1) });
    }
  } else if (Array.isArray(c)) {
    for (const x of c) {
      if (x.type === 'text' && x.text?.trim()) out.push({ ts, role: 'agent', kind: 'text', text: x.text.trim().slice(0, L2) });
      else if (x.type === 'tool_use') out.push({ ts, role: 'agent', kind: 'tool', text: toolText(x.name, x.input) });
    }
  }
  return out;
}
// o agente terminou a vez dele perguntando algo para você? (texto, não a tela de aprovação) — vira o "!" no boneco
const PERGUNTA_RE = /((me |você )?autoriza\b|sua autorização|(você )?aprova\?|escolh(a|er)|qual (das|delas|opção)|op(ç|c)(ão|ões|ao|oes)\b|me avisa|confirma\??\s*$|ok\?|\?\s*(\*\*)?\s*$|preciso (de|que) (você|vc|sua|seu)|aguardo (sua|seu|você|o seu|a sua)|me (diga|confirme|avise|passe)|confirm[ae] (se|para|o|a)\b|qual (você )?prefere|você prefere|quer que eu|posso (seguir|continuar|prosseguir|subir|fazer)|devo (seguir|continuar|prosseguir)|precisa da sua|sua (decisão|aprovação|confirmação|resposta))/im;
function perguntaPendente(p, id) {
  const arr = p.chat[id] || []; let ult = null;
  for (let i = arr.length - 1; i >= 0; i--) { const x = arr[i]; if (x.kind !== 'text') continue; ult = x; break; }
  if (!ult || ult.role !== 'agent') return null;
  const fim = ult.text.slice(-1200);
  const opcoes = []; for (const l of fim.split('\n')) { const m = l.match(/^\s*(?:[-*]\s*)?\**\s*(?:op(?:ç|c)(?:ão|ao)\s*)?(\d{1,2}|[A-Da-d])[.):]\**\s+\**(.{2,140}?)\**\s*$/i); if (m) opcoes.push({ n: m[1], texto: m[2].replace(/\*\*/g, '').trim() }); }
  const temOps = opcoes.length >= 2 && /(\?|escolh|prefere|op(ç|c)(ão|ões)|qual)/i.test(fim);
  if (!temOps && !PERGUNTA_RE.test(fim.slice(-600))) return null;
  if ((p.visto?.[id] || 0) >= ult.ts) return null;
  const autoriza = /(autoriz|aprov|posso (seguir|subir|fazer|fazer o|dar o|rodar)|pode(mos)? (seguir|subir)|liberad|seu ok|ok para|confirma)/i.test(fim.slice(-500));
  return { ts: ult.ts, trecho: ult.text.replace(/\s+/g, ' ').slice(-220), opcoes: temOps ? opcoes.slice(0, 8) : [], autoriza };
}
function addChat(p, id, it) {
  const arr = (p.chat[id] ||= []);
  arr.push(it);
  if (arr.length > 1 && arr[arr.length - 2].ts > it.ts) arr.sort((a, b) => a.ts - b.ts);
  if (arr.length > 150) arr.splice(0, arr.length - 150);
  if (chatBooted) broadcast(p, 'activity', { agent: id, ...it, text: it.kind === 'text' ? it.text.slice(0, 1500) : it.text });
}

// ---------- sessões (cada .jsonl do Claude = uma sessão de um agente) ----------
const sessIdx = new Map(); // arquivo -> { p, id, conta, sid, file, start, end, n }
function noteSess(fp, p, id, conta, ts) {
  let s = sessIdx.get(fp);
  if (!s) { s = { p, id, conta, sid: path.basename(fp, '.jsonl'), file: fp, start: ts, end: ts, n: 0 }; sessIdx.set(fp, s); }
  if (ts < s.start) s.start = ts; if (ts > s.end) s.end = ts; s.n++;
}
const sessionsOf = (p, id) => [...sessIdx.values()].filter((s) => s.p === p && s.id === id).sort((a, b) => b.end - a.end);
const pad = (n) => String(n).padStart(2, '0');
const dt = (ms) => { const d = new Date(ms); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const memFile = (p, id) => path.join(p.orq, 'relatorios', id, 'memoria.md');
const sessDir = (p, id) => path.join(p.orq, 'relatorios', id, 'sessoes');
const sessFileName = (s) => { const d = new Date(s.start); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}-${s.sid.slice(0, 8)}.md`; };
function sessionMd(s) {
  const out = [`# ${s.id} — sessão de ${dt(s.start)} até ${dt(s.end)}`, '', `- projeto: ${s.p.id}`, `- conta: ${s.conta || '?'}`, `- sessão: \`${s.sid}\``, `- retomar no terminal: \`claude --resume ${s.sid}\``, ''];
  let txt = ''; try { txt = fs.readFileSync(s.file, 'utf8'); } catch { return out.join('\n') + '\n(arquivo da sessão não encontrado)\n'; }
  for (const line of txt.split('\n')) {
    if (!line.includes('"message"')) continue;
    let l; try { l = JSON.parse(line); } catch { continue; }
    if (!l.message || (l.type !== 'assistant' && l.type !== 'user')) continue;
    for (const it of chatItems(l, true)) {
      const h = new Date(it.ts).toTimeString().slice(0, 5);
      if (it.kind === 'tool') out.push(`- \`${h}\` ${it.text.replace(/\n/g, ' ')}`);
      else out.push('', `### ${it.role === 'user' ? '🧑 ' + (it.from || 'Você / Boss') : '🤖 ' + s.id} · ${h}`, '', it.text, '');
    }
  }
  return out.join('\n') + '\n';
}
function saveSession(s) {
  const dir = sessDir(s.p, s.id); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, sessFileName(s)); fs.writeFileSync(f, sessionMd(s)); return f;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// renovar o contexto: salva a sessão em .md, o agente resume em memoria.md, /clear e ele relê o resumo
const renewing = new Set();
async function renew(p, id) {
  const key = p.id + '/' + id; if (renewing.has(key)) return 'já está renovando';
  const a = p.agents[id]; if (!a) return 'agente não está no ar';
  if (a.status === 'blocked') return 'ele está esperando uma aprovação no Herdr — responda lá primeiro';
  renewing.add(key);
  const note = (text) => { logEvent(p, { from: 'voce', to: id, kind: 'servico', text }); };
  (async () => {
    try {
      const cur = sessionsOf(p, id)[0]; if (cur) { try { saveSession(cur); } catch {} }
      const mf = memFile(p, id); fs.mkdirSync(path.dirname(mf), { recursive: true });
      const antes = (() => { try { return fs.statSync(mf).mtimeMs; } catch { return 0; } })();
      note('renovando o contexto de ' + id);
      await hcRun(['send', a.address, `RENOVAR CONTEXTO (pedido do Estúdio): escreva em ${mf} — substituindo o arquivo — um resumo de no máximo 40 linhas do seu trabalho: o que está em andamento, decisões tomadas, pendências, arquivos/branches importantes e o próximo passo. Não faça mais nada; ao terminar responda só "memória salva".`]);
      const t0 = Date.now(); let ok = false;
      while (Date.now() - t0 < 6 * 60e3) { await sleep(3000); const m = (() => { try { return fs.statSync(mf).mtimeMs; } catch { return 0; } })(); if (m > antes && p.agents[id]?.status !== 'working') { ok = true; break; } }
      if (!ok) { note('renovação de ' + id + ' cancelada: o resumo não chegou'); return; }
      const ad = p.agents[id]?.address || a.address;
      await sleep(1500); await hcRun(['send', ad, '/clear']); await sleep(2500);
      await hcRun(['send', ad, `Contexto renovado. Leia ${mf} (resumo da sessão anterior) e aguarde a próxima instrução.`]);
      note('contexto de ' + id + ' renovado');
    } finally { renewing.delete(key); }
  })();
  return 'renovando: ele vai resumir em memoria.md, limpar o contexto e reler o resumo';
}
// guarda cada sessão em .md sozinho: 15 min depois da última mensagem (sem gastar tokens) — fica o registro mesmo desligando o Mac
const autoSaved = new Map();
setInterval(() => { for (const x of sessIdx.values()) { if (Date.now() - x.end < 15 * 60e3 || autoSaved.get(x.file) === x.end || Date.now() - x.end > 3 * 864e5) continue; try { saveSession(x); autoSaved.set(x.file, x.end); } catch {} } }, 5 * 60e3).unref?.();
function readSettings(p) { try { return { boss: 'nova', equipe: 'nova', memoria: true, ...(JSON.parse(fs.readFileSync(path.join(p.orq, 'estudio', 'config.json'), 'utf8')).sessoes || {}) }; } catch { return { boss: 'nova', equipe: 'nova', memoria: true }; } }
function writeSettings(p, v) {
  const f = path.join(p.orq, 'estudio', 'config.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const ok = (x) => (x === 'continuar' ? 'continuar' : 'nova');
  j.sessoes = { boss: ok(v.boss), equipe: ok(v.equipe), memoria: v.memoria !== false };
  const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n'); fs.renameSync(tmp, f); return j.sessoes;
}

let usageBusy = false;
async function scanUsage() {
  if (usageBusy) return; usageBusy = true; const t0 = Date.now();
  try { await scanUsageCore(); } finally { usageBusy = false; timed('scanUsage', Date.now() - t0); if (perf.firstScanMs == null) perf.firstScanMs = Date.now() - perf.started; }
}
async function scanUsageCore() {
  const changed = new Set();
  for (const acc of ACCOUNTS) {
    const pdir = path.join(acc.dir, 'projects');
    let dirs; try { dirs = fs.readdirSync(pdir); } catch { continue; }
    for (const d of dirs) {
      if (!/orquestra-|worktrees-/.test(d)) continue;
      const full = path.join(pdir, d);
      let files; try { files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        await tick();
        const fp = path.join(full, f);
        let st; try { st = fs.statSync(fp); } catch { continue; }
        const off = fileOffsets.get(fp) || 0;
        if (st.size <= off) continue;
        const fd = fs.openSync(fp, 'r');
        const buf = Buffer.alloc(st.size - off);
        fs.readSync(fd, buf, 0, buf.length, off); fs.closeSync(fd);
        const text = buf.toString('utf8'), lastNl = text.lastIndexOf('\n');
        if (lastNl < 0) continue;
        fileOffsets.set(fp, off + Buffer.byteLength(text.slice(0, lastNl + 1)));
        for (const line of text.slice(0, lastNl).split('\n')) {
          if (!line.includes('"message"')) continue;
          let l; try { l = JSON.parse(line); } catch { continue; }
          const msg = l.message;
          if (!msg || (l.type !== 'assistant' && l.type !== 'user')) continue;
          let p = null, id = null;
          for (const pp of projects) { id = agentFromCwd(pp, l.cwd); if (id) { p = pp; break; } }
          if (!p) continue;
          noteSess(fp, p, id, acc.id, Date.parse(l.timestamp) || Date.now());
          // conversa (o que o agente pensa, faz e responde)
          for (const it of chatItems(l)) addChat(p, id, it);
          if (l.type !== 'assistant' || !msg.usage) continue;
          const key = (msg.id || '') + ':' + (l.requestId || '');
          if (seenMsg.has(key)) continue;
          seenMsg.add(key);
          addUsage(p, id, acc.id, msg.model, msg.usage, l.timestamp);
          changed.add(p);
        }
      }
    }
  }
  chatBooted = true;
  for (const p of changed) {
    for (const [id, a] of Object.entries(p.agents)) if (!a.conta && p.usage[id]) a.conta = p.usage[id].conta;
    emit(p);
  }
}

// ---------- contas do Claude: quem está logado, uso 5h/7d (session-bar) e renovação estimada ----------
const SB_DIR = path.join(HOME, '.local', 'state', 'herdr-session-bar');
const acctInfo = {};           // id -> {email, name, org}
const acctTs = {};             // id -> timestamps (ms) de respostas, últimos 8 dias
function readAccounts() {
  for (const a of ACCOUNTS.filter((x) => x.provedor === 'claude')) {
    const f = a.dir === exp('~/.claude') ? path.join(HOME, '.claude.json') : path.join(a.dir, '.claude.json');
    try { const o = JSON.parse(fs.readFileSync(f, 'utf8')).oauthAccount || {}; acctInfo[a.id] = { email: o.emailAddress || '', name: o.displayName || '', org: o.organizationName || '' }; } catch { acctInfo[a.id] = acctInfo[a.id] || { email: '', name: '', org: '' }; }
  }
}
function windowStart(ts, hours) {
  const span = hours * 3600e3; let start = null;
  for (const t of ts) { if (start === null || t >= start + span) start = Math.floor(t / 3600e3) * 3600e3; }
  return start;
}
let acctSig = '';
// uso real de cada conta: abre o Claude daquela conta num terminal do Herdr, roda /usage, lê a tela e fecha.
// (não lê token nenhum — é a mesma tela que você veria digitando /usage)
const usoReal = {}; let medindo = new Set();
const MEDIDOR = path.join(path.dirname(CFG_FILE), 'medidor');
function confiaPasta(cfgDir, dir) {
  const cj = cfgDir === path.join(HOME, '.claude') ? path.join(HOME, '.claude.json') : path.join(cfgDir, '.claude.json');
  const j = lerJson(cj, null); if (!j) return; j.projects ||= {}; const k = fs.realpathSync(dir);
  if (j.projects[k]?.hasTrustDialogAccepted) return; j.projects[k] = { ...(j.projects[k] || {}), hasTrustDialogAccepted: true };
  const tmp = cj + '.orq.tmp'; fs.writeFileSync(tmp, JSON.stringify(j, null, 2)); fs.renameSync(tmp, cj);
}
// outros motores também perguntam se a pasta é confiável na 1ª vez: registra antes (cada um no seu arquivo de config)
function confiaMotor(motor, dir) {
  const k = fs.realpathSync(dir);
  if (motor === 'codex') { const f = path.join(HOME, '.codex', 'config.toml'); let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch {} if (!t.includes(`[projects."${k}"]`)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, `\n[projects."${k}"]\ntrust_level = "trusted"\n`); } }
  else if (motor === 'gemini') { const f = path.join(HOME, '.gemini', 'trustedFolders.json'); const j = lerJson(f, {}) || {}; if (j[k] !== 'TRUST_FOLDER') { j[k] = 'TRUST_FOLDER'; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(j, null, 2)); } }
  else if (motor === 'copilot') { const f = path.join(HOME, '.copilot', 'config.json'); const j = lerJson(f, {}) || {}; j.trusted_folders = [...new Set([...(j.trusted_folders || []), k])]; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(j, null, 2)); }
}
function parseUsage(t) {
  t = t.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  const bloco = (re) => { const i = t.search(re); if (i < 0) return null; const s = t.slice(i, i + 400); const pc = s.match(/(\d{1,3})\s*%\s*used/i); const rs = s.match(/Resets?\s+([^\n│]+)/i); return { pct: pc ? +pc[1] : null, reset: rs ? rs[1].replace(/\s+/g, ' ').trim() : null }; };
  const h5 = bloco(/Current session/i), d7 = bloco(/Current week \(all models\)|Current week/i);
  return h5 || d7 ? { h5: h5?.pct ?? null, reset5Txt: h5?.reset || null, d7: d7?.pct ?? null, reset7Txt: d7?.reset || null } : null;
}
async function medirUso(acc) {
  if (acc.provedor !== 'claude' || medindo.has(acc.id)) return usoReal[acc.id] || null;
  medindo.add(acc.id); const nome = 'orquestra-uso-' + acc.id;
  try {
    fs.mkdirSync(MEDIDOR, { recursive: true }); try { confiaPasta(acc.dir, MEDIDOR); } catch {}
    const env = acc.dir === path.join(HOME, '.claude') ? '' : `CLAUDE_CONFIG_DIR=${shq(acc.dir)} `;
    const r = await hcRun(['run', '--bg', '--no-notify', '--no-parent', '--name', nome, '--cwd', MEDIDOR, '--', '/bin/sh', '-c', `${env}exec claude`]);
    if (!r.ok) return null;
    let addr = null; for (let i = 0; i < 15 && !addr; i++) { await sleep(400); const l = await hcRun(['ls', '--json']); try { addr = (JSON.parse(l.out).terminals || []).find((x) => x.name === nome && x.state === 'live')?.address; } catch {} }
    if (!addr) return null;
    let pronto = false; for (let i = 0; i < 25 && !pronto; i++) { await sleep(600); const t = (await hcRun(['read', addr, '--lines', '40'])).out; pronto = /for shortcuts|\? for|>\s*$|Try "|context left/m.test(t); if (/Select login method|Welcome to Claude Code|Log in/i.test(t)) break; }
    await hcRun(['send', addr, '/usage']);
    let dados = null; for (let i = 0; i < 12 && !dados?.d7 && dados?.d7 !== 0; i++) { await sleep(700); dados = parseUsage((await hcRun(['read', addr, '--lines', '60'])).out); }
    if (dados) usoReal[acc.id] = { ...dados, at: Date.now() };
    return usoReal[acc.id] || null;
  } finally { await hcRun(['kill', nome]); medindo.delete(acc.id); }
}
async function medirTodas() { for (const a of ACCOUNTS.filter((x) => x.provedor === 'claude')) { try { await medirUso(a); } catch {} } emitAccounts(); }
setTimeout(medirTodas, 20000); setInterval(medirTodas, 15 * 60e3);

function accounts() {
  const now = Date.now();
  return ACCOUNTS.filter((a) => a.provedor === 'claude').map((a) => {
    const users = [], meters = {}; let at = 0;
    for (const p of projects) for (const ag of Object.values(p.agents)) {
      if ((ag.conta || 'conta1') !== a.id) continue;
      users.push({ project: p.id, agent: ag.id });
      try { const j = JSON.parse(fs.readFileSync(path.join(SB_DIR, ag.address + '.json'), 'utf8')); if (j.at > at) { at = j.at; for (const m of j.meters || []) if (m.label !== 'ctx') meters[m.label] = m.percent; } } catch {}
    }
    const ts = (acctTs[a.id] || []).filter((t) => t > now - 8 * 864e5).sort((x, y) => x - y);
    const s5 = windowStart(ts, 5), reset5 = s5 && s5 + 5 * 3600e3 > now ? s5 + 5 * 3600e3 : null;
    const s7 = windowStart(ts, 168), reset7 = s7 && s7 + 168 * 3600e3 > now ? s7 + 168 * 3600e3 : null;
    let tokToday = 0, costToday = 0;
    for (const p of projects) for (const u of Object.values(p.usage)) if (u.conta === a.id) { tokToday += (u.today?.in || 0) + (u.today?.out || 0); costToday += u.today?.cost || 0; }
    const real = usoReal[a.id]; // a medição pelo /usage da própria conta vale mais que a do plugin
    return { id: a.id, nome: a.nome || '', ...(acctInfo[a.id] || {}), users, h5: real ? real.h5 : meters['5h'] ?? null, d7: real ? real.d7 : meters['7d'] ?? null, metersAt: real ? real.at : at || null, fonte: real ? 'usage' : at ? 'plugin' : null, reset5Txt: real?.reset5Txt || null, reset7Txt: real?.reset7Txt || null, reset5, reset7, tokToday, costToday };
  });
}
function emitAccounts() { const a = accounts(); const s = JSON.stringify(a); if (s !== acctSig) { acctSig = s; broadcastAll('accounts', a); } }
let acctBusy = false;
async function scanAcctTimes() {
  if (acctBusy) return; acctBusy = true; const t0 = Date.now();
  try { await scanAcctTimesCore(); } finally { acctBusy = false; timed('scanAcct', Date.now() - t0); }
}
async function scanAcctTimesCore() {
  const cutoff = Date.now() - 8 * 864e5;
  for (const acc of ACCOUNTS) {
    const pdir = path.join(acc.dir, 'projects');
    let dirs; try { dirs = fs.readdirSync(pdir); } catch { continue; }
    const arr = (acctTs[acc.id] ||= []);
    for (const d of dirs) {
      if (/orquestra-|worktrees-/.test(d)) continue; // esses já entram pelo scanUsage
      let files; try { files = fs.readdirSync(path.join(pdir, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        await tick();
        const fp = path.join(pdir, d, f); let st; try { st = fs.statSync(fp); } catch { continue; }
        if (st.mtimeMs < cutoff) continue;
        const off = fileOffsets.get(fp) || 0; if (st.size <= off) continue;
        const fd = fs.openSync(fp, 'r'); const buf = Buffer.alloc(st.size - off); fs.readSync(fd, buf, 0, buf.length, off); fs.closeSync(fd);
        const text = buf.toString('utf8'), lastNl = text.lastIndexOf('\n'); if (lastNl < 0) continue;
        fileOffsets.set(fp, off + Buffer.byteLength(text.slice(0, lastNl + 1)));
        for (const line of text.slice(0, lastNl).split('\n')) {
          if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
          const m = line.match(/"timestamp":"([^"]+)"/); if (!m) continue;
          const t = Date.parse(m[1]); if (t > cutoff) arr.push(t);
        }
      }
    }
    if (arr.length > 20000) arr.splice(0, arr.length - 20000);
  }
}

// ---------- portas em uso por projeto (processos locais + containers Docker) ----------
const run = (cmd, args, timeout = 6000) => new Promise((ok) => execFile(cmd, args, { timeout, maxBuffer: 8e6 }, (err, out) => ok(err ? String(out || '') : out)));
async function scanPorts() {
  const t0 = Date.now(); try { await scanPortsCore(); } finally { timed('scanPorts', Date.now() - t0); }
}
async function scanPortsCore() {
  const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
  const procs = {}; let cur = null;
  for (const l of out.split('\n')) {
    if (l[0] === 'p') { cur = l.slice(1); procs[cur] ||= { pid: cur, cmd: '', ports: new Set() }; }
    else if (l[0] === 'c' && cur) procs[cur].cmd = l.slice(1);
    else if (l[0] === 'n' && cur) { const m = l.match(/:(\d+)$/); if (m) procs[cur].ports.add(+m[1]); }
  }
  const pids = Object.keys(procs);
  const cwds = {};
  if (pids.length) {
    const o2 = await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn']);
    let pp = null; for (const l of o2.split('\n')) { if (l[0] === 'p') pp = l.slice(1); else if (l[0] === 'n' && pp) cwds[pp] = l.slice(1); }
  }
  const dock = [];
  const o3 = await run('docker', ['ps', '--format', '{{json .}}'], 8000);
  for (const l of o3.split('\n')) { if (!l.trim()) continue; try { const c = JSON.parse(l); const wd = (c.Labels || '').match(/com\.docker\.compose\.project\.working_dir=([^,]+)/)?.[1]; const ports = [...String(c.Ports || '').matchAll(/(?:0\.0\.0\.0|\[::\]|127\.0\.0\.1):(\d+)->/g)].map((m) => +m[1]); const proj = (c.Labels || '').match(/com\.docker\.compose\.project=([^,]+)/)?.[1] || ''; dock.push({ id: c.ID, name: c.Names, wd, proj, ports: [...new Set(ports)] }); } catch {} }
  for (const p of projects) {
    const list = [];
    for (const pr of Object.values(procs)) { const cwd = cwds[pr.pid]; if (cwd && inside(cwd, p.root)) for (const port of pr.ports) list.push({ port, kind: 'proc', pid: +pr.pid, name: pr.cmd, where: path.relative(p.root, cwd) || '.' }); }
    for (const c of dock) if (c.wd && inside(c.wd, p.root)) for (const port of c.ports) list.push({ port, kind: 'docker', id: c.id, compose: c.proj, name: c.name, where: path.relative(p.root, c.wd) || '.' });
    const uniq = Object.values(Object.fromEntries(list.map((x) => [x.port, x]))).sort((a, b) => a.port - b.port);
    if (JSON.stringify(uniq) !== JSON.stringify(p.ports)) { p.ports = uniq; emit(p); }
  }
}

// ---------- subir / parar serviços ----------
// nome do terminal no Herdr: "<andar>-<agente>"; o hc aceita até 32 caracteres — se passar, encurta com um código fixo no fim (igual ao tn() do _lib.sh)
function tnHc(p, x) {
  const n = p.id + '-' + x; if (n.length <= 32) return n;
  let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) % 1000003;
  return n.slice(0, 26) + '-' + String(h % 100000).padStart(5, '0');
}
const hcRun = (args, timeout = 20000) => new Promise((ok) => execFile(HC, args, { timeout }, (err, o, se) => ok({ ok: !err, out: String(o || se || (err && err.message) || '') })));
// ---------- Herdr app: cada andar vira um workspace visível (abas "andar" + uma por agente, ligadas com hc attach) ----------
// Os terminais do Orquestra vivem no herdr-core (hc) e não aparecem sozinhos no app; aqui cada um ganha uma aba que o "assiste".
// Na aba dá para usar normalmente; ctrl+\ solta (o terminal continua rodando).
const HERDR = process.env.HERDR_BIN || 'herdr';
let herdrOk = null, herdrVisto = 0;
const herdrRun = (args, timeout = 10000) => new Promise((ok) => execFile(HERDR, args, { timeout }, (err, o, se) => { let j = null; try { j = JSON.parse(o); } catch {} ok({ ok: !err, j, out: String(o || se || (err && err.message) || '') }); }));
const mostrarNoHerdr = () => { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')).mostrarNoHerdr !== false; } catch { return true; } };
async function herdrDisponivel() { if (herdrOk === null || Date.now() - herdrVisto > 300000) { herdrOk = (await herdrRun(['workspace', 'list'])).ok; herdrVisto = Date.now(); } return herdrOk; } // o app pode abrir/fechar: reconfere a cada 5 min
const herdrArq = (p) => path.join(p.orq, 'estudio', 'herdr.json');
function herdrEstado(p) { try { return JSON.parse(fs.readFileSync(herdrArq(p), 'utf8')); } catch { return { tabs: {} }; } }
const pega = (o, ...ks) => ks.reduce((a, k) => (a == null ? a : a[k]), o);
async function herdrMostrar(p, alvo, addr, rotulo, focar = false) {
  if (!(await herdrDisponivel())) return { ok: false, out: 'não achei o app Herdr (comando herdr) neste computador' };
  const st = herdrEstado(p); st.tabs ||= {};
  const ws = await herdrRun(['workspace', 'list']);
  if (!st.workspace || !ws.out.includes(st.workspace)) {
    const r = await herdrRun(['workspace', 'create', '--cwd', p.root, '--label', 'Orquestra · ' + (p.ui?.title || p.id), '--no-focus']);
    const w = pega(r.j, 'result', 'workspace', 'workspace_id'); if (!w) return { ok: false, out: 'o Herdr não criou o workspace: ' + r.out.slice(0, 200) };
    st.workspace = w; st.tabs = {}; st.raiz = { tab: pega(r.j, 'result', 'tab', 'tab_id'), pane: pega(r.j, 'result', 'root_pane', 'pane_id') };
  }
  let tb = st.tabs[alvo];
  if (tb) { const l = await herdrRun(['tab', 'list', '--workspace', st.workspace]); if (!l.out.includes(tb.tab)) tb = null; }
  if (!tb) {
    if (st.raiz?.pane) { tb = st.raiz; delete st.raiz; await herdrRun(['tab', 'rename', tb.tab, rotulo]); } // a 1ª aba do workspace
    else { const r = await herdrRun(['tab', 'create', '--workspace', st.workspace, '--cwd', p.root, '--label', rotulo, '--no-focus']); const tab = pega(r.j, 'result', 'tab', 'tab_id'), pane = pega(r.j, 'result', 'root_pane', 'pane_id'); if (!pane) return { ok: false, out: 'o Herdr não criou a aba: ' + r.out.slice(0, 200) }; tb = { tab, pane }; }
    st.tabs[alvo] = tb;
  }
  if (tb.addr !== addr) { await herdrRun(['pane', 'run', tb.pane, `hc attach ${addr}`]); tb.addr = addr; }
  try { fs.writeFileSync(herdrArq(p), JSON.stringify(st, null, 2)); } catch {}
  if (focar) { await herdrRun(['workspace', 'focus', st.workspace]); await herdrRun(['tab', 'focus', tb.tab]); }
  return { ok: true, out: focar ? `${rotulo} aberto no Herdr (workspace "Orquestra · ${p.ui?.title || p.id}")` : 'ok' };
}
const rotuloHerdr = (p, id) => (id === 'andar' ? 'andar · Boss' : id === 'boss' ? 'Boss' : p.ui?.special?.[id]?.title || id);
function herdrSincroniza(p) { // chamado a cada leitura do hc: garante uma aba para o terminal do andar e para cada agente no ar
  if ((herdrOk === false && Date.now() - herdrVisto < 300000) || (p.herdrPausa || 0) > Date.now() || !mostrarNoHerdr()) return;
  const alvos = {}; if (p.floorTerm) alvos.andar = p.floorTerm;
  for (const [id, a] of Object.entries(p.agents || {})) if (a.address !== p.floorTerm) alvos[id] = a.address;
  const sig = JSON.stringify(alvos); if (sig === p.herdrSig || p.herdrOcupado) return;
  p.herdrOcupado = true;
  (async () => { try { for (const [id, addr] of Object.entries(alvos)) { const r = await herdrMostrar(p, id, addr, rotuloHerdr(p, id)); if (!r.ok) { p.herdrPausa = Date.now() + 300000; if (herdrOk !== false) console.log('[herdr]', r.out); return; } } p.herdrSig = sig; } catch (e) { p.herdrPausa = Date.now() + 300000; } finally { p.herdrOcupado = false; } })();
}
const sh = (cmd, cwd, timeout = 120000) => new Promise((ok) => execFile('/bin/zsh', ['-lc', cmd], { cwd, timeout, maxBuffer: 4e6 }, (err, o, se) => ok({ ok: !err, out: String(o || '') + String(se || '') })));
async function svcStart(p, d) {
  if (p.services[d.short]?.live) return { ok: true, out: d.name + ' já está rodando' };
  const r = await hcRun(['run', '--bg', '--no-notify', '--no-parent', '--label', 'orq.projeto=' + p.id, '--name', tnHc(p, d.name), '--cwd', path.join(p.root, d.pasta), '--', '/bin/zsh', '-lc', d.cmd]);
  return { ok: r.ok, out: r.ok ? d.name + ' subindo' : r.out };
}
async function svcStop(p, d) {
  const outs = [];
  if (d.stop) { const r = await sh(d.stop, path.join(p.root, d.pasta)); outs.push((r.ok ? '' : 'falha ao parar: ') + r.out.slice(-300)); }
  if (p.services[d.short]?.live) { await hcRun(['interrupt', tnHc(p, d.name)]); await new Promise((r) => setTimeout(r, 1500)); await hcRun(['kill', tnHc(p, d.name)]); }
  return { ok: true, out: d.name + ' parado' + (outs.length ? ' · ' + outs.join(' ') : '') };
}
function logEvent(p, e) { try { fs.appendFileSync(p.eventsFile, JSON.stringify({ ts: Date.now(), ...e }) + '\n'); } catch {} }

// ---------- terminal do andar (pty via python3 + WebSocket mínimo, sem dependências) ----------
const PTY_PY = `
import os, pty, sys, select, struct, fcntl, termios, signal
cols, rows = int(sys.argv[1]), int(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[3], sys.argv[3:])
def tam(c, r):
    try: fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0)); os.kill(pid, signal.SIGWINCH)
    except Exception: pass
tam(cols, rows)
fontes, resto = [fd, 0, 3], b""
while True:
    try: r, _, _ = select.select(fontes, [], [])
    except InterruptedError: continue
    if fd in r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        os.write(1, d)
    if 0 in r:
        d = os.read(0, 65536)
        if not d: break
        os.write(fd, d)
    if 3 in r:
        d = os.read(3, 1024)
        if not d: fontes.remove(3); continue
        resto += d
        while b"\\n" in resto:
            l, resto = resto.split(b"\\n", 1)
            try: c, rr = map(int, l.split()); tam(c, rr)
            except Exception: pass
try: os.kill(pid, signal.SIGHUP)
except Exception: pass
`;
const SHELL = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
const shq = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
// terminal para entrar (/login) numa conta do Claude: roda o claude com a pasta de config daquela conta
async function ensureLoginTerm(id) {
  const acc = ACCOUNTS.find((a) => a.id === id); if (!acc) throw new Error('conta não encontrada');
  const n = id.replace(/^conta/, ''), nome = 'orquestra-login-' + id;
  const achar = async () => { const r = await hcRun(['ls', '--json']); try { return (JSON.parse(r.out).terminals || []).find((t) => t.name === nome && t.state === 'live')?.address || null; } catch { return null; } };
  let a = await achar(); if (a) return a;
  let cmd;
  if (acc.provedor === 'claude') {
    const dir = contaDir(null, n), env = n === '1' && dir === path.join(HOME, '.claude') ? '' : `CLAUDE_CONFIG_DIR=${shq(dir)} `;
    cmd = `echo; echo "  Conta ${n} do Claude (${dir.replace(HOME, '~')})"; echo "  Dentro do Claude: /login para entrar (ou trocar de conta), /status para ver qual está logada, /exit para sair."; echo; ${env}exec claude`;
  } else {
    const P = PROVEDORES[acc.provedor];
    cmd = `echo; echo "  ${P.nome}: entrando com '${P.login}'. Siga as instruções (pode abrir o navegador). Quando terminar, feche esta janela."; echo; exec $SHELL -lc ${shq(P.login + '; echo; echo "(pode fechar esta janela)"; exec $SHELL -l')}`;
  }
  const r = await hcRun(['run', '--bg', '--no-notify', '--no-parent', '--name', nome, '--cwd', HOME, '--', '/bin/sh', '-c', cmd]);
  if (!r.ok) throw new Error('não consegui abrir o terminal no Herdr: ' + r.out.slice(0, 200));
  for (let i = 0; i < 15 && !(a = await achar()); i++) await sleep(400);
  if (!a) throw new Error('o terminal de login não apareceu no Herdr'); return a;
}
function salvaContas() { const c = lerJson(CFG_FILE, {}); c.accounts = ACCOUNTS.map((a) => ({ id: a.id, ...(a.nome ? { nome: a.nome } : {}), ...(a.provedor !== 'claude' ? { provedor: a.provedor } : {}), dir: a.dir.startsWith(HOME) ? '~' + a.dir.slice(HOME.length) : a.dir })); fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2) + '\n'); }
function usoDasContas() {
  const uso = {}; for (const a of ACCOUNTS) uso[a.id] = [];
  for (const q of projects) {
    const bc = projEnv(q).BOSS_CONTA || '1'; uso['conta' + bc]?.push({ projeto: q.ui.title || q.id, agente: 'Boss' });
    for (const e of readEquipe(q)) uso[contaKey(e.conta)]?.push({ projeto: q.ui.title || q.id, agente: e.nome });
  }
  return uso;
}
function setEnvVar(f, k, v) { let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch {} const re = new RegExp('^' + k + '=.*$', 'm'); t = re.test(t) ? t.replace(re, `${k}=${v}`) : t.replace(/\s*$/, '\n') + `${k}=${v}\n`; fs.writeFileSync(f, t); }
function contaModeloAgente(p, id, conta, modelo) {
  conta = String(conta).replace(/^conta(\d+)$/, '$1'); const acc = ACCOUNTS.find((a) => a.id === contaKey(conta)); if (!acc) throw new Error('conta inexistente');
  if (modelo && !/^[\w.:-]{1,60}$/.test(modelo)) throw new Error('modelo inválido');
  if (acc.provedor === 'claude' && modelo && !['sonnet', 'opus', 'haiku'].includes(modelo) && !/^claude-/.test(modelo)) throw new Error('para o Claude use sonnet, opus ou haiku');
  if (id === 'boss' && acc.provedor !== 'claude') throw new Error('o Boss usa sempre uma conta do Claude (é ele quem coordena com as regras do Claude Code)');
  if (id === 'boss') { const f = path.join(p.orq, 'projeto.env'); setEnvVar(f, 'BOSS_CONTA', conta); setEnvVar(f, 'BOSS_MODELO', modelo || ''); return; }
  const f = path.join(p.orq, 'equipe.conf'); const linhas = fs.readFileSync(f, 'utf8').split('\n'); let achou = false;
  const novo = linhas.map((l) => { const c = l.trim().split(/\s+/); if (c[0] !== id || l.trim().startsWith('#')) return l; achou = true; return `${c[0].padEnd(20)} ${(c[1] || '').padEnd(33)} ${conta}      ${modelo || ''}`.trimEnd(); });
  if (!achou) throw new Error(id + ' não está no equipe.conf'); fs.writeFileSync(f, novo.join('\n'));
}

async function iniciarBoss(p) {
  if (p.agents.boss) return 'o Boss deste andar já está no ar';
  const addr = await ensureFloorTerm(p);
  await hcRun(['send', addr, `cd ${shq(path.join(p.orq, 'boss'))} && NO_OPEN=1 ../bin/boss.sh`]); // NO_OPEN: não abre aba no navegador (você já está no Orquestra)
  logEvent(p, { from: 'voce', to: 'boss', kind: 'servico', text: 'chamar o Boss (terminal do andar)' });
  return `chamando o Boss — ele sobe no terminal do andar (aba Terminal) junto com a equipe e os serviços. No terminal do Herdr, o atalho é: ${p.atalho}`;
}
// terminal do andar: um terminal do Herdr por projeto, na pasta do projeto (HC_TERMINAL_ID garantido — os atalhos precisam dele)
async function ensureFloorTerm(p) {
  if (p.floorTerm) return p.floorTerm;
  const nome = p.id + '-terminal';
  const acha = `$(hc ls --label orq.projeto=${p.id} --label orq.papel=terminal --json 2>/dev/null | python3 -c "import json,sys;t=[x for x in json.load(sys.stdin).get('terminals',[]) if x.get('state')=='live'];print(t[0]['address'] if t else '')")`;
  const r = await hcRun(['run', '--bg', '--no-notify', '--no-parent', '--label', 'orq.projeto=' + p.id, '--label', 'orq.papel=terminal', '--name', nome, '--cwd', p.root, '--',
    '/bin/sh', '-c', `export HC_TERMINAL_ID="\${HC_TERMINAL_ID:-${acha}}"; exec ${shq(SHELL)} -l`]);
  if (!r.ok) throw new Error('não consegui abrir o terminal no Herdr: ' + r.out.slice(0, 200));
  for (let i = 0; i < 16 && !p.floorTerm; i++) { await sleep(400); pollHc(); }
  if (!p.floorTerm) throw new Error('o terminal do andar não apareceu no Herdr');
  return p.floorTerm;
}
function wsSend(sock, data, op = 2) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = b.length < 126 ? Buffer.from([0x80 | op, b.length]) : b.length < 65536 ? Buffer.from([0x80 | op, 126, b.length >> 8, b.length & 255]) : (() => { const x = Buffer.alloc(10); x[0] = 0x80 | op; x[1] = 127; x.writeBigUInt64BE(BigInt(b.length), 2); return x; })();
  if (!sock.destroyed) sock.write(Buffer.concat([h, b]));
}
function wsAccept(req, sock, onMsg, onClose) {
  const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15, masked = buf[1] & 128; let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mk = masked ? buf.slice(off, off + 4) : null; if (masked) off += 4;
      if (buf.length < off + len) return;
      const pl = Buffer.from(buf.slice(off, off + len)); buf = buf.slice(off + len);
      if (mk) for (let i = 0; i < pl.length; i++) pl[i] ^= mk[i & 3];
      if (op === 8) { try { sock.end(); } catch {} return; }
      if (op === 9) { wsSend(sock, pl, 10); continue; }
      if (op === 1 || op === 2) onMsg(pl.toString('utf8'));
    }
  });
  sock.on('close', onClose); sock.on('error', () => {});
}
const terms = new Set();
function openTerm(req, sock, url) {
  const origin = req.headers.origin || '';
  if (url.searchParams.get('t') !== TOKEN || !/^(http:\/\/(localhost|127\.0\.0\.1)(:\d+)?|file:\/\/|null)$/.test(origin)) { sock.destroy(); return; }
  const login = url.searchParams.get('w') === 'login' ? String(url.searchParams.get('conta') || '') : null;
  const p = byId[url.searchParams.get('p')] || (login ? projects[0] : null); if (!p && !login) { sock.destroy(); return; }
  if (login && !ACCOUNTS.some((a) => a.id === login)) { sock.destroy(); return; }
  const qual = login ? 'login' : url.searchParams.get('w') === 'boss' ? 'boss' : 'andar';
  const cols = Math.max(20, Math.min(400, Number(url.searchParams.get('c')) || 100)), rows = Math.max(5, Math.min(200, Number(url.searchParams.get('r')) || 30));
  let ch = null, fechado = false;
  wsAccept(req, sock, (m) => {
    let j; try { j = JSON.parse(m); } catch { return; }
    if (!ch) return;
    if (j.t === 'i' && typeof j.d === 'string') ch.stdin.write(j.d);
    if (j.t === 'r') ch.stdio[3]?.write(`${Math.max(20, Math.min(400, j.c | 0))} ${Math.max(5, Math.min(200, j.r | 0))}\n`);
  }, () => { fechado = true; terms.delete(sock); if (ch) { try { ch.kill('SIGTERM'); } catch {} } });
  terms.add(sock);
  (async () => {
    let addr = null;
    try { addr = qual === 'login' ? await ensureLoginTerm(login) : qual === 'boss' ? p.agents.boss?.address : await ensureFloorTerm(p); } catch (e) { wsSend(sock, '\r\n\x1b[31m' + e.message + '\x1b[0m\r\n'); }
    if (!addr) { if (qual === 'boss') wsSend(sock, '\r\n\x1b[33mO Boss deste andar não está no ar. Use "Iniciar Boss" ou abra o terminal do andar.\x1b[0m\r\n'); return; }
    if (fechado) return;
    ch = spawn('python3', ['-c', PTY_PY, String(cols), String(rows), HC, 'attach', addr], { cwd: p ? p.root : HOME, env: { ...process.env, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    ch.stdin.on('error', () => {}); ch.stdio[3]?.on('error', () => {});
    ch.stdout.on('data', (d) => wsSend(sock, d));
    ch.stderr.on('data', (d) => wsSend(sock, d));
    ch.on('error', (e) => wsSend(sock, '\r\nerro: ' + e.message + '\r\n'));
    ch.on('exit', () => { wsSend(sock, '\r\n\x1b[2m[desconectado do terminal — ele continua no Herdr]\x1b[0m\r\n'); try { sock.end(); } catch {} });
  })();
}

// ---------- equipe, skills e instruções de cada agente (editáveis pelo Orquestra) ----------
const SLUG = /^[a-z][a-z0-9-]{1,30}$/;
const RESERVADOS = new Set(['boss', 'bin', 'estudio', 'relatorios', 'skills', 'agentes', 'terminal', '_equipe']);
function readEquipe(p) {
  try {
    return fs.readFileSync(path.join(p.orq, 'equipe.conf'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => { const [nome, pasta, conta, modelo] = l.split(/\s+/); return { nome, pasta, conta: conta || '2', modelo: modelo || '' }; });
  } catch { return []; }
}
function reloadTeam(p) {
  p.team = ['boss', ...readEquipe(p).map((x) => x.nome)];
  try { const pc = JSON.parse(fs.readFileSync(path.join(p.orq, 'estudio', 'config.json'), 'utf8')); const ui = pc.ui || {}; p.ui = { ...ui }; p.special = new Set(Object.keys(ui.special || {})); p.atalho = pc.atalho || p.id; } catch {}
}
function projEnv(p) { const o = {}; try { for (const l of fs.readFileSync(path.join(p.orq, 'projeto.env'), 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)=("?)(.*?)\2\s*(#.*)?$/); if (m) o[m[1]] = m[3].replace(/\$HOME/g, HOME); } } catch {} return o; }
function contaDir(p, n) { n = String(n || '1'); const env = p ? projEnv(p) : {}; const acc = ACCOUNTS.find((a) => a.id === 'conta' + n); const d = env['CONTA' + n + '_DIR'] || (acc ? acc.dir : n === '1' ? '' : path.join(HOME, '.claude-conta' + n)); return d ? exp(d) : path.join(HOME, '.claude'); }
function agenteInfo(p, id) {
  if (id === 'boss') { const c = projEnv(p).BOSS_CONTA || '1'; return { id, cwd: path.join(p.orq, 'boss'), conta: c, modelo: projEnv(p).BOSS_MODELO || '', cfg: contaDir(p, c), settings: path.join(p.orq, 'boss', '.claude', 'settings.json'), addDirs: [p.root], instr: path.join(p.orq, 'boss', 'CLAUDE.md'), tipo: 'boss' }; }
  const e = readEquipe(p).find((x) => x.nome === id); if (!e) return null;
  const cwd = path.join(p.root, e.pasta), dev = id.startsWith('dev-');
  let args = ''; try { args = fs.readFileSync(path.join(cwd, 'agente.args'), 'utf8'); } catch {}
  const st = fs.existsSync(path.join(cwd, 'agente-settings.json')) ? path.join(cwd, 'agente-settings.json') : path.join(p.orq, 'dev-settings.json');
  return { id, cwd, conta: e.conta, modelo: e.modelo, cfg: contaDir(p, e.conta), settings: st, addDirs: args.includes('{PROJ}') ? [p.root] : [], tipo: dev ? 'dev' : 'especialista',
    repo: dev ? id.slice(4) : null, instr: dev ? path.join(p.orq, 'agentes', id + '.md') : path.join(cwd, 'CLAUDE.md') };
}
const escopoDir = (p, id, esc) => path.join(p.orq, 'skills', esc === 'equipe' ? '_equipe' : id);
// agentes em outros motores (Codex, Gemini, Cursor, Copilot): as skills vão por cópia para .agents/skills (padrão Agent Skills)
const liberadasDe = (p, id) => { try { return new Set(JSON.parse(fs.readFileSync(path.join(p.orq, 'skills', id, 'liberadas.json'), 'utf8'))); } catch { return new Set(); } };
const motorDe = (a) => (a && !/^\d+$/.test(String(a.conta)) ? String(a.conta) : null);
function syncInfo(cwd) { try { const j = JSON.parse(fs.readFileSync(path.join(cwd, '.agents', 'skills', '.orquestra-sync.json'), 'utf8')); return { n: (j.skills || []).length, quando: j.quando * 1000 }; } catch { return null; } }
function syncMotor(p, id) {
  const a = agenteInfo(p, id); if (!motorDe(a)) return Promise.resolve(null);
  const sc = [path.join(p.orq, 'bin', 'skills_sync.py'), MODELO && path.join(MODELO, 'bin', 'skills_sync.py')].find((f) => f && fs.existsSync(f));
  if (!sc || !fs.existsSync(a.cwd)) return Promise.resolve(null);
  return new Promise((ok) => execFile('python3', [sc, p.orq, id, a.cwd, a.settings], { timeout: 60000, maxBuffer: 4e6 }, (err, o) => { try { ok(err ? { erro: String(err.message).slice(0, 200) } : JSON.parse(o)); } catch { ok({ erro: 'saída inválida' }); } }));
}
const motoresDoAndar = (p) => readEquipe(p).filter((e) => !/^\d+$/.test(e.conta)).map((e) => e.nome);
function lerSkill(f) {
  let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch { return null; }
  const fm = t.startsWith('---') ? t.slice(3, t.indexOf('\n---', 3) > 0 ? t.indexOf('\n---', 3) : 0) : '';
  const campo = (k) => { const m = fm.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')); return m ? m[1].replace(/^["']|["']$/g, '').trim() : ''; };
  return { nome: campo('name') || path.basename(path.dirname(f)), descricao: campo('description').slice(0, 300), arquivo: f };
}
function skillsEm(dir) { const out = []; let ds = []; try { ds = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; } for (const d of ds) { if (!d.isDirectory() && !d.isSymbolicLink()) continue; const sk = lerSkill(path.join(dir, d.name, 'SKILL.md')); if (sk) out.push({ ...sk, pasta: d.name }); } return out.sort((a, b) => a.nome.localeCompare(b.nome)); }
function pluginSkills(cfgDir) {
  const out = [], base = path.join(cfgDir, 'plugins'); let ativos = {}; try { ativos = JSON.parse(fs.readFileSync(path.join(cfgDir, 'settings.json'), 'utf8')).enabledPlugins || {}; } catch {}
  const walk = (d, depth) => { if (depth > 7 || out.length > 300) return; let ds = []; try { ds = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const x of ds) { if (!x.isDirectory() || x.name === 'node_modules' || x.name.startsWith('.')) continue; const f = path.join(d, x.name);
      if (x.name === 'skills') { const plug = path.basename(path.dirname(f)).match(/^\d[\w.-]*$/) ? path.basename(path.dirname(path.dirname(f))) : path.basename(path.dirname(f));
        for (const sk of skillsEm(f)) out.push({ ...sk, plugin: plug, ativo: Object.keys(ativos).some((k) => k.split('@')[0] === plug && ativos[k]) }); }
      else walk(f, depth + 1); } };
  walk(base, 0);
  const vistos = new Set(); return out.filter((x) => { const k = x.plugin + '/' + x.nome; if (vistos.has(k)) return false; vistos.add(k); return true; });
}
function bloqueio(settingsFile) {
  let deny = []; try { deny = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).permissions?.deny || []; } catch {}
  const pats = deny.filter((d) => d === 'Skill' || d.startsWith('Skill(')).map((d) => d === 'Skill' ? /.*/ : new RegExp('^' + d.slice(6, -1).replace(/ \*$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
  return (nome) => pats.some((r) => r.test(nome));
}
function fontesDe(p, id) {
  const a = agenteInfo(p, id); if (!a) return null;
  const bl0 = bloqueio(a.settings), lib = liberadasDe(p, id), F = [];
  const bl = (n) => bl0(n) && !lib.has(n); const libFlag = (n) => bl0(n) && lib.has(n);
  const add = (tipo, rotulo, dir, extra = {}) => { const sk = skillsEm(dir); F.push({ tipo, rotulo, pasta: dir, editavel: !!extra.editavel, skills: sk.map((x) => ({ ...x, bloqueada: bl(x.nome), liberada: libFlag(x.nome) })), ...extra }); };
  for (const esc of ['agente', 'equipe']) {
    const raiz = escopoDir(p, id, esc);
    add(esc, esc === 'agente' ? 'Só deste agente' : 'Da equipe toda (todos os agentes deste andar)', path.join(raiz, '.claude', 'skills'), { editavel: true, escopo: esc,
      desativadas: skillsEm(path.join(raiz, 'skills-desativadas')).map((x) => ({ ...x, desativada: true })) });
  }
  const vistos = new Set();
  let d = a.cwd;
  for (let i = 0; i < 8; i++) { const sd = path.join(d, '.claude', 'skills'); if (!vistos.has(sd) && fs.existsSync(sd)) { vistos.add(sd); add('pasta', d === a.cwd ? 'Da pasta de trabalho dele' : (path.relative(p.root, d) ? 'Da pasta ' + path.relative(p.root, d) : 'Da pasta do projeto'), sd); } if (fs.existsSync(path.join(d, '.git')) || d === p.root || d === HOME) break; d = path.dirname(d); }
  if (a.tipo === 'dev') { const sd = path.join(p.root, a.repo, '.claude', 'skills'); if (!vistos.has(sd) && fs.existsSync(sd) && !fs.existsSync(path.join(a.cwd, '.claude', 'skills'))) { vistos.add(sd); add('pasta', 'Do repositório ' + a.repo, sd); } }
  for (const ad of a.addDirs) { const sd = path.join(ad, '.claude', 'skills'); if (!vistos.has(sd) && fs.existsSync(sd)) { vistos.add(sd); add('pasta', 'Do projeto', sd); } }
  const mt = motorDe(a);
  if (mt) {
    add('pasta', 'Pessoais (~/.claude/skills)', path.join(HOME, '.claude', 'skills'));
    return { agente: { id, tipo: a.tipo, conta: PROVEDORES[mt]?.nome || mt, cwd: a.cwd, motor: { id: mt, nome: PROVEDORES[mt]?.nome || mt, pasta: path.join(a.cwd, '.agents', 'skills').replace(HOME, '~'), sync: syncInfo(a.cwd) } }, fontes: F.filter((f) => f.editavel || f.skills.length) };
  }
  const acc = ACCOUNTS.find((x) => x.dir === a.cfg); const nomeConta = acc ? (acc.nome || acc.id) : 'conta ' + a.conta;
  add('conta', `Da conta ${nomeConta} (todos que usam esta conta, em qualquer projeto)`, path.join(a.cfg, 'skills'));
  add('conta', 'Sincronizadas do claude.ai', path.join(a.cfg, 'skills', 'synced'));
  const pl = pluginSkills(a.cfg); if (pl.length) F.push({ tipo: 'plugin', rotulo: 'De plugins instalados nesta conta', pasta: path.join(a.cfg, 'plugins'), editavel: false, skills: pl.map((x) => ({ ...x, bloqueada: bl(x.plugin + ':' + x.nome) || bl(x.nome), liberada: libFlag(x.plugin + ':' + x.nome) || libFlag(x.nome) })) });
  return { agente: { id, tipo: a.tipo, conta: nomeConta, cwd: a.cwd }, fontes: F.filter((f) => f.editavel || f.skills.length) };
}
function dentroDeFonte(p, id, arq) {
  const f = fontesDe(p, id); if (!f) return false;
  const real = path.resolve(arq);
  return path.basename(real) === 'SKILL.md' && f.fontes.some((x) => real.startsWith(path.resolve(x.pasta) + path.sep) || (x.desativadas || []).some((d) => d.arquivo === real));
}
function corpoSkill(nome, descricao, corpo) {
  corpo = String(corpo || '').replace(/\r/g, '');
  if (corpo.trimStart().startsWith('---')) return corpo; // já veio com frontmatter
  const d = String(descricao || '').replace(/\s+/g, ' ').trim().replace(/"/g, "'");
  return `---\nname: ${nome}\ndescription: "${d}"\n---\n\n${corpo.trim()}\n`;
}
function appendBossLinha(p, linha) {
  const f = path.join(p.orq, 'boss', 'CLAUDE.md'); let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch { return; }
  if (!t.includes('## Agentes criados pelo Orquestra')) t = t.replace(/\s*$/, '\n\n## Agentes criados pelo Orquestra\n\nFale com eles com `../bin/hcp.sh send <agente> "<pedido>"`. Cada um sabe o que fazer (instruções definidas pelo usuário).\n');
  fs.writeFileSync(f, t.replace(/\s*$/, '\n') + linha + '\n');
}
function novoAgente(p, j) {
  const tipo = j.tipo === 'dev' ? 'dev' : 'especialista';
  const conta = ACCOUNTS.some((a) => a.id === contaKey(String(j.conta || ''))) ? String(j.conta) : '2';
  const prov = ACCOUNTS.find((a) => a.id === contaKey(conta))?.provedor || 'claude';
  const modelo = /^[\w.:-]{1,60}$/.test(j.modelo || '') ? j.modelo : prov === 'claude' ? 'sonnet' : '';
  const equipe = readEquipe(p), texto = String(j.instrucoes || '').trim();
  let nome, pasta;
  if (tipo === 'dev') {
    const repo = String(j.repo || ''); if (!/^[\w.-]+$/.test(repo) || !fs.existsSync(path.join(p.root, repo, '.git'))) throw new Error('repositório inválido');
    nome = 'dev-' + repo; pasta = '.worktrees/' + nome;
  } else {
    nome = String(j.nome || '').toLowerCase(); if (!SLUG.test(nome) || RESERVADOS.has(nome) || nome.startsWith('dev-') || nome.startsWith('srv-')) throw new Error('nome inválido: use letras minúsculas, números e hífen (ex.: seguranca, docs-api)');
    if (nome.length > 40) throw new Error('nome longo demais');
    pasta = '.orquestra/' + nome;
    if (fs.existsSync(path.join(p.root, pasta))) throw new Error('já existe a pasta ' + pasta);
  }
  if (equipe.some((x) => x.nome === nome)) throw new Error(nome + ' já está na equipe');
  const titulo = String(j.titulo || '').trim().slice(0, 40) || nome, sub = String(j.descricao || '').trim().slice(0, 80);
  if (tipo === 'especialista') {
    const dir = path.join(p.root, pasta); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# ${titulo}${sub ? ' — ' + sub : ''}\n\n${texto || '(descreva aqui o que este agente faz)'}\n\n## Como trabalhar nesta equipe\n- Você recebe pedidos do Boss (mensagens no seu terminal). Faça o que está descrito acima, com economia.\n- Para falar com o Boss: \`../bin/avisa-boss.sh "<resumo>"\`. Coisa longa: escreva em \`../relatorios/${nome}/<assunto>.md\` e mande o caminho.\n${j.qa ? `- Para pedir validação no navegador: \`../bin/avisa-agente.sh qa "VALIDAR <o quê> — <onde/como testar>"\`.\n` : ''}- Você **não altera** o código dos repositórios, não faz push, merge nem deploy (bloqueado por permissão). Mudança de código é com os devs — sugira ao Boss.\n- Ao terminar, leia \`../relatorios/${nome}/caixa.md\` se existir.\n`);
    fs.writeFileSync(path.join(dir, 'agente.args'), '--add-dir\n{PROJ}\n');
    // permissões: as do QA/GitHub/GitLab + só leitura no código
    const base = ['qa', 'github', 'gitlab', 'revisor'].map((a) => path.join(p.orq, a, 'agente-settings.json')).find((f) => fs.existsSync(f)) || path.join(p.orq, 'dev-settings.json');
    const st = JSON.parse(fs.readFileSync(base, 'utf8')); st.permissions ||= {};
    let deny = (st.permissions.deny || []).filter((d) => !['Edit(**)', 'Write(**)', 'NotebookEdit(**)'].includes(d));
    for (const c of ['merge', 'rebase', 'pull', 'push', 'commit', 'checkout', 'switch', 'reset', 'stash', 'cherry-pick', 'clean', 'worktree', 'tag']) deny.push(`Bash(git ${c}:*)`, `Bash(*git * ${c} *)`);
    deny.push('Bash(gh pr merge*)', 'Bash(gh api*)', 'Bash(glab mr merge*)', 'Bash(glab api*)', 'Bash(*ok.sh*)', 'Bash(*tarefa.sh*)', 'Bash(*dev.sh*)');
    for (const d of fs.readdirSync(p.root)) if (fs.existsSync(path.join(p.root, d, '.git'))) deny.push(`Edit(//${path.join(p.root, d).replace(/^\//, '')}/**)`);
    deny.push(`Edit(//${path.join(p.root, '.worktrees').replace(/^\//, '')}/**)`);
    st.permissions.deny = [...new Set(deny)]; delete st.permissions.allow;
    fs.writeFileSync(path.join(dir, 'agente-settings.json'), JSON.stringify(st, null, 2));
    fs.mkdirSync(path.join(p.orq, 'relatorios', nome), { recursive: true });
  } else if (texto) { fs.mkdirSync(path.join(p.orq, 'agentes'), { recursive: true }); fs.writeFileSync(path.join(p.orq, 'agentes', nome + '.md'), texto + '\n'); }
  fs.mkdirSync(path.join(escopoDir(p, nome, 'agente'), '.claude', 'skills'), { recursive: true });
  // equipe.conf
  const ef = path.join(p.orq, 'equipe.conf'); fs.writeFileSync(ef, fs.readFileSync(ef, 'utf8').replace(/\s*$/, '\n') + `${nome.padEnd(20)} ${pasta.padEnd(33)} ${conta}      ${modelo}\n`);
  // aparece no escritório
  const cf = path.join(p.orq, 'estudio', 'config.json'), c = JSON.parse(fs.readFileSync(cf, 'utf8')); c.ui ||= {};
  if (tipo === 'especialista') { c.ui.special ||= {}; c.ui.special[nome] = { title: titulo, sub: sub || 'agente criado no Orquestra', color: /^#[0-9a-f]{6}$/i.test(j.cor || '') ? j.cor : '#a78bfa' }; }
  else { c.ui.repos ||= []; if (!c.ui.repos.includes(j.repo)) c.ui.repos.push(j.repo); }
  fs.writeFileSync(cf, JSON.stringify(c, null, 2) + '\n');
  // pode pedir validação ao QA
  if (j.qa && tipo === 'especialista') { const aa = path.join(p.orq, 'bin', 'avisa-agente.sh'); try { let t = fs.readFileSync(aa, 'utf8'); t = t.replace(/^(\s*)([^\n)]*)\) \[ "\$alvo" = qa \] && ok=1;;/m, (m0, ind, pat) => pat.split('|').includes(nome) ? m0 : `${ind}${pat}|${nome}) [ "$alvo" = qa ] && ok=1;;`); fs.writeFileSync(aa, t); } catch {} }
  appendBossLinha(p, `- \`${nome}\` — ${titulo}${sub ? ': ' + sub : ''}${tipo === 'dev' ? ` (dev residente de \`${j.repo}\`; delegue com \`../bin/tarefa.sh ${j.repo} <slug> "<tarefa>"\`)` : ''}`);
  reloadTeam(p);
  return nome;
}

// ---------- Git pela interface (add, commit, push, MR/PR) — com as regras do sistema ----------
const gitRun = (cwd, args, timeout = 30000) => new Promise((ok) => execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer: 20e6, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (err, o, se) => ok({ ok: !err, code: err?.code ?? 0, out: String(o || ''), err: String(se || (err && err.message) || '') })));
const cliRun = (cmd, cwd, args, timeout = 60000) => new Promise((ok) => execFile(cmd, args, { cwd, timeout, maxBuffer: 5e6, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', GLAB_NO_PROMPT: '1' } }, (err, o, se) => ok({ ok: !err, out: String(o || ''), err: String(se || (err && err.message) || '') })));
function protegidas(p) { const extra = (projEnv(p).GIT_PROTEGIDAS || '').split(/[\s,]+/).filter(Boolean); return new Set(['develop', 'main', 'master', ...extra]); }
const SENSIVEL = (f) => { const b = path.basename(f).toLowerCase(); if (/^\.env(\..+)?$/.test(b) && !/\.(example|sample|template|dist)$/.test(b)) return true; return /\.(pem|key|p12|pfx|jks|keystore)$/.test(b) || /^id_(rsa|ed25519|ecdsa)/.test(b) || /(^|\/)\.secrets\//.test(f) || /(^|\/)(credentials|secrets?)\.(json|ya?ml)$/i.test(f); };
function gitRepos(p) {
  const out = [];
  let ds = []; try { ds = fs.readdirSync(p.root); } catch {}
  for (const d of ds.sort()) if (fs.existsSync(path.join(p.root, d, '.git'))) out.push({ id: 'repo:' + d, nome: d, tipo: 'repo', dir: path.join(p.root, d) });
  const wt = path.join(p.root, '.worktrees'); let ws = []; try { ws = fs.readdirSync(wt); } catch {}
  for (const d of ws.sort()) if (!d.startsWith('rev-') && fs.existsSync(path.join(wt, d, '.git'))) out.push({ id: 'mesa:' + d, nome: d, tipo: 'mesa', dir: path.join(wt, d) });
  return out;
}
const repoDe = (p, id) => gitRepos(p).find((r) => r.id === id);
async function submodulos(dir) { const r = await gitRun(dir, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']); return new Set(r.out.split('\n').map((l) => l.split(' ').slice(1).join(' ').trim()).filter(Boolean)); }
async function gitStatus(dir) {
  const r = await gitRun(dir, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
  if (!r.ok) return { erro: r.err.trim() };
  const t = r.out.split('\0'); const head = t.shift() || '';
  const m = head.match(/^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/) || [];
  const st = { branch: m[1] === 'HEAD' ? null : m[1] || null, upstream: m[2] || null, ahead: +((m[3] || '').match(/ahead (\d+)/) || [0, 0])[1], behind: +((m[3] || '').match(/behind (\d+)/) || [0, 0])[1], arquivos: [] };
  if (/HEAD \(no branch\)/.test(head)) st.branch = null;
  for (let i = 0; i < t.length; i++) { const e = t[i]; if (!e) continue; const x = e[0], y = e[1], f = e.slice(3); let de = null; if (x === 'R' || x === 'C') de = t[++i]; st.arquivos.push({ f, de, x, y, staged: x !== ' ' && x !== '?', mudado: y !== ' ', novo: x === '?' }); }
  return st;
}
async function gitResumo(p, r) {
  const st = await gitStatus(r.dir); const prot = protegidas(p);
  return { id: r.id, nome: r.nome, tipo: r.tipo, branch: st.branch, upstream: st.upstream, ahead: st.ahead, behind: st.behind, alterados: (st.arquivos || []).length, protegida: !!st.branch && prot.has(st.branch), erro: st.erro || null };
}
// contas do GitHub/GitLab (gh / glab): o próprio Orquestra faz o login
function hostDe(url) { url = String(url || '').trim(); let m = url.match(/^[a-z+]+:\/\/(?:[^@\/]+@)?([^:\/]+)/i) || url.match(/^[^@\s]+@([^:\s]+):/); return m ? m[1].toLowerCase() : null; }
const temCli = (c) => new Promise((ok) => execFile('/bin/sh', ['-c', 'command -v ' + c], (err, o) => ok(!err && !!String(o).trim())));
async function contasGit(p) {
  const hosts = new Map();
  for (const r of gitRepos(p).filter((x) => x.tipo === 'repo')) { const u = (await gitRun(r.dir, ['config', '--get', 'remote.origin.url'])).out.trim(), h = hostDe(u), pl = plataforma(u); if (h && pl && !hosts.has(h)) hosts.set(h, { host: h, plat: pl, repos: [] }); if (h && hosts.has(h)) hosts.get(h).repos.push(r.nome); }
  return Promise.all([...hosts.values()].map(async (x) => {
    const cli = x.plat === 'github' ? 'gh' : 'glab', inst = await temCli(cli);
    let logado = false, conta = '', detalhe = '';
    if (inst) { const r = await cliRun(cli, HOME, ['auth', 'status', '--hostname', x.host], 20000); const t = (r.out + r.err).replace(/\x1b\[[0-9;]*m/g, ''); logado = r.ok && !/not logged|no token|invalid|failed|401/i.test(t); conta = (t.match(/(?:account|as)\s+([\w.-]+)/i) || [])[1] || ''; detalhe = t.trim().split('\n').slice(0, 4).join(' · ').slice(0, 300); }
    const token = x.plat === 'github' ? 'https://github.com/settings/tokens/new?description=Orquestra&scopes=repo,workflow,read:org' : `https://${x.host}/-/user_settings/personal_access_tokens?name=Orquestra&scopes=api,read_user,write_repository`;
    return { ...x, cli, instalado: inst, logado, conta, detalhe, token };
  }));
}
const logins = new Map(); // sessões de login pelo navegador (gh)
function plataforma(url) { return /github\.com/.test(url) ? 'github' : /gitlab/.test(url) ? 'gitlab' : null; }

// ---------- novo andar (projeto) pela interface ----------
const MODELO = [process.env.ORQ_MODELO, path.join(DIR, 'modelo'), path.join(DIR, '..', 'modelo')].filter(Boolean).find((d) => fs.existsSync(path.join(d, 'bin', 'equipe.sh')));
const ATALHOS = (() => { if (cfg.atalhos) return exp(cfg.atalhos); const velho = path.join(HOME, 'Desktop', 'Developer', 'orquestra.zsh'); return fs.existsSync(velho) ? velho : path.join(path.dirname(CFG_FILE), 'atalhos.zsh'); })();
const lerJson = (f, d = {}) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function atalhosUsados() { let t = ''; try { t = fs.readFileSync(ATALHOS, 'utf8'); } catch {} return new Set([...t.matchAll(/^([a-zA-Z][\w-]*)\s*\(\)\s*\{/gm)].map((m) => m[1]).filter((n) => n !== '_orq')); }
async function inspecionaPasta(dir) {
  const r = { caminho: dir, existe: fs.existsSync(dir), repos: [], jaTemAndar: fs.existsSync(path.join(dir, '.orquestra')) };
  if (r.jaTemAndar) { const pc = lerJson(path.join(dir, '.orquestra', 'estudio', 'config.json'), {}); r.andar = { id: pc.project_id || null, titulo: pc.ui?.title || null, noPredio: !!byId[pc.project_id] }; }
  if (!r.existe) return r;
  let ds = []; try { ds = fs.readdirSync(dir).sort(); } catch {}
  if (fs.existsSync(path.join(dir, '.git'))) { // a própria pasta é um repo: o andar fica numa pasta ao lado, com um atalho para ele
    r.ehRepo = true; const u = (await gitRun(dir, ['config', '--get', 'remote.origin.url'])).out.trim();
    r.repoProprio = { nome: path.basename(dir), remoto: u.replace(/\/\/[^@/]*@/, '//'), plat: plataforma(u), develop: (await gitRun(dir, ['rev-parse', '-q', '--verify', 'refs/remotes/origin/develop'])).ok };
    r.pastaDoAndar = path.join(path.dirname(dir), path.basename(dir) + '-orquestra').replace(HOME, '~');
    const w = path.join(path.dirname(dir), path.basename(dir) + '-orquestra'); if (fs.existsSync(path.join(w, '.orquestra'))) { r.jaTemAndar = true; const pc = lerJson(path.join(w, '.orquestra', 'estudio', 'config.json'), {}); r.andar = { id: pc.project_id || null, titulo: pc.ui?.title || null, noPredio: !!byId[pc.project_id] }; r.caminhoAndar = w; }
    return r;
  }
  for (const d of ds) if (!d.startsWith('.') && fs.existsSync(path.join(dir, d, '.git'))) {
    const u = (await gitRun(path.join(dir, d), ['config', '--get', 'remote.origin.url'])).out.trim();
    const dev = (await gitRun(path.join(dir, d), ['rev-parse', '-q', '--verify', 'refs/remotes/origin/develop'])).ok;
    r.repos.push({ nome: d, remoto: u.replace(/\/\/[^@/]*@/, '//'), plat: plataforma(u), develop: dev });
  }
  return r;
}
function scriptEstudio() {
  return `#!/usr/bin/env bash
# Sobe (ou reaproveita) o servidor do Orquestra e abre este andar. Gerado pelo Orquestra.
set -uo pipefail
ORQ="$(cd "$(dirname "$0")/.." && pwd)"
SRV_DIR=${shq(DIR)}; CFG=${shq(CFG_FILE)}
PID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("project_id","proj"))' "$ORQ/estudio/config.json")"
PORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("port",4777))' "$CFG")"
mkdir -p "$ORQ/estudio/data" "$(dirname "$CFG")/data"
codigo="$(python3 -c 'import os,sys;print(int(os.stat(sys.argv[1]).st_mtime*1000))' "$SRV_DIR/server.mjs")"
rodando="$( { curl -s -m 1 "http://localhost:$PORT/health" 2>/dev/null || true; } | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("code",0))
except Exception: print(0)')"
if [ "\${rodando:-0}" -gt 0 ] && [ "\${rodando}" -ge "$((codigo - 2000))" ] && [ "\${1:-}" != "--restart" ]; then
  echo "Orquestra já está rodando (porta $PORT)."
else
  pids="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"; [ -n "$pids" ] && { kill $pids 2>/dev/null || true; sleep 0.5; }
  (cd "$SRV_DIR" && ORQ_CONFIG="$CFG" env -u HC_TERMINAL_ID nohup node server.mjs > "$(dirname "$CFG")/data/server.log" 2>&1 < /dev/null &)
  sleep 1; echo "Orquestra iniciado (porta $PORT)."
fi
[ -n "\${NO_OPEN:-}" ] && exit 0
url="http://localhost:$PORT/?p=$PID"
if [ "$(uname)" = Darwin ] && [ -d /Applications/Orquestra.app ]; then open -a Orquestra; else open "$url" 2>/dev/null || xdg-open "$url" 2>/dev/null || echo "Abra $url"; fi
`;
}
const GITLAB_MD = `# GitLab — MRs e pipelines (__TITULO__)

Você abre os MRs da equipe no GitLab com o \`glab\`.

## Abrir MR
- Só quando o Boss mandar \`ABRIR MR <repo> <slug>: <título> — <descrição>\` (o usuário já aprovou).
- Na mesa do dev (\`../../.worktrees/dev-<repo>\`): confira a branch \`agente/<slug>\` limpa; \`git push -u origin agente/<slug>\`; \`glab mr create --source-branch agente/<slug> --target-branch __BASE__ --title "<título>" --description "<descrição>" --yes\`.
- Devolva o link ao Boss: \`../bin/avisa-boss.sh "MR <repo> <slug>: <link>"\`.
- Acompanhe a pipeline (\`glab ci status -b agente/<slug>\`): falhou → \`glab ci trace <job>\`, diga a causa e a correção e avise o dev (\`../bin/avisa-agente.sh dev-<repo> "PIPELINE FALHOU <slug>: …"\`) e o Boss.

## Nunca
Merge, aprovar MR, push em \`__BASE__\`, force push, apagar branch remota, mexer em segredos/variáveis de CI.
`;
function settingsDe(orq) { const out = [path.join(orq, 'dev-settings.json'), path.join(orq, 'boss', '.claude', 'settings.json')]; try { for (const d of fs.readdirSync(orq)) { const f = path.join(orq, d, 'agente-settings.json'); if (fs.existsSync(f)) out.push(f); } } catch {} return out.filter((f) => fs.existsSync(f)); }
function negaPasta(arquivo, raiz) {
  const d = lerJson(arquivo, null); if (!d) return; d.permissions ||= {}; const deny = d.permissions.deny || [];
  const abs = '//' + raiz.replace(/^\//, ''); for (const t of ['Read', 'Edit']) deny.push(`${t}(${abs}/**)`); // Read cobre Glob/Grep e Edit cobre Write (o Claude avisa que Write()/Glob() com caminho nunca casam)
  deny.push(`Bash(*${path.relative(HOME, raiz)}*)`); d.permissions.deny = [...new Set(deny)]; fs.writeFileSync(arquivo, JSON.stringify(d, null, 2));
}

// ---------- informações do andar (nome, "sobre o projeto", repositórios) — editáveis pelo Orquestra ----------
const SOBRE = '**Sobre o projeto:**';
function lerSobre(p) {
  let t = ''; try { t = fs.readFileSync(path.join(p.orq, 'boss', 'CLAUDE.md'), 'utf8'); } catch {}
  const i = t.indexOf(SOBRE); if (i < 0) return '';
  const fim = t.indexOf('\n## ', i); return t.slice(i + SOBRE.length, fim < 0 ? undefined : fim).trim();
}
function gravaSobre(p, texto) {
  const f = path.join(p.orq, 'boss', 'CLAUDE.md'); let t = fs.readFileSync(f, 'utf8'); texto = String(texto || '').replace(/\r/g, '').trim();
  const bloco = texto ? `${SOBRE} ${texto}\n\n` : '';
  const i = t.indexOf(SOBRE);
  if (i >= 0) { const fim = t.indexOf('\n## ', i); t = t.slice(0, i) + bloco + (fim < 0 ? '' : t.slice(fim + 1)); }
  else if (bloco) { const k = t.indexOf('\n## '); t = k < 0 ? t.replace(/\s*$/, '\n\n') + bloco : t.slice(0, k + 1) + bloco + t.slice(k + 1); }
  fs.writeFileSync(f, t);
}
function infoAndar(p) {
  const devs = new Set(readEquipe(p).map((x) => x.nome)), c = lerJson(path.join(p.orq, 'estudio', 'config.json'), {});
  const repos = fs.readdirSync(p.root).filter((d) => !d.startsWith('.') && fs.existsSync(path.join(p.root, d, '.git'))).map((d) => {
    const l = path.join(p.root, d); let link = null; try { if (fs.lstatSync(l).isSymbolicLink()) link = fs.realpathSync(l).replace(HOME, '~'); } catch {}
    return { nome: d, link, dev: devs.has('dev-' + d) };
  });
  return { id: p.id, titulo: p.ui.title || p.id, marca: p.ui.brand || '', atalho: p.atalho, pasta: p.root.replace(HOME, '~'), sobre: lerSobre(p), descricao: c.ui?.about || c.descricao || '', repos };
}
function negaRepoNosEspecialistas(p, dir) {
  const regra = `Edit(//${dir.replace(/^\//, '')}/**)`;
  for (const d of fs.readdirSync(p.orq)) { const f = path.join(p.orq, d, 'agente-settings.json'); const s = lerJson(f, null); if (!s) continue; s.permissions ||= {}; s.permissions.deny = [...new Set([...(s.permissions.deny || []), regra])]; fs.writeFileSync(f, JSON.stringify(s, null, 2)); }
}

// ---------- "precisa de você": lê a pergunta/aprovação que está na tela do agente e responde por botões ----------
function lerPergunta(tela) {
  const L = String(tela || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').split('\n');
  const opRe = /^\s*(❯|›|>)?\s*(\d+)\.\s+(.+?)\s*$/;
  let fim = L.length - 1; while (fim > 0 && !opRe.test(L[fim])) fim--;
  if (fim <= 0) return { opcoes: [], contexto: L.slice(-25).join('\n').trim() };
  let ini = fim; while (ini > 0 && (opRe.test(L[ini - 1]) || (/^\s{3,}\S/.test(L[ini - 1]) && !/^\s*[─│]/.test(L[ini - 1])) || /^─{5,}/.test(L[ini - 1].trim()))) ini--;
  const opcoes = [];
  for (let i = ini; i <= fim + 3 && i < L.length; i++) {
    const m = L[i].match(opRe);
    if (m) opcoes.push({ n: +m[2], texto: m[3], atual: !!m[1], desc: '' });
    else if (opcoes.length && /^\s{3,}\S/.test(L[i]) && !/Enter to|Esc to/.test(L[i])) opcoes[opcoes.length - 1].desc += (opcoes[opcoes.length - 1].desc ? ' ' : '') + L[i].trim();
  }
  const antes = L.slice(Math.max(0, ini - 30), ini).filter((x) => !/^\s*─{5,}/.test(x));
  const titulo = (antes.map((x) => x.match(/☐\s*(.+)/)).filter(Boolean).pop() || [])[1] || '';
  const pergunta = antes.filter((x) => /^\s*│/.test(x)).map((x) => x.replace(/^\s*│\s?/, '')).join('\n').trim();
  return { titulo, pergunta, opcoes, contexto: antes.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(-2500) };
}
const telaDe = (addr) => new Promise((ok) => execFile(HC, ['read', addr, '--lines', '80'], { timeout: 8000, maxBuffer: 2e6 }, (e, o) => ok(String(o || ''))));
function resumo(s) { const l = String(s || '').trim().split(/\n/)[0].replace(/[*#`]/g, '').trim(); if (l.length <= 200) return l; const m = l.match(/^.{20,200}?[.!?](\s|$)/); return (m ? m[0] : l.slice(0, 197) + '…').trim(); }
async function criarAndar(j, progresso) {
  if (!MODELO) throw new Error('não achei os modelos de andar (pasta modelo/) junto do servidor');
  const titulo = String(j.titulo || '').trim().slice(0, 40); if (!titulo) throw new Error('dê um nome ao andar');
  const id = String(j.id || '').toLowerCase(); if (!/^[a-z][a-z0-9-]{1,11}$/.test(id)) throw new Error('identificador: 2 a 12 letras minúsculas/números/hífen, começando por letra');
  if (byId[id]) throw new Error('já existe um andar com o id ' + id);
  const atalho = String(j.atalho || id); if (!/^[a-z][a-z0-9_-]{1,19}$/.test(atalho)) throw new Error('atalho inválido (letras minúsculas, números, - e _)');
  if (atalhosUsados().has(atalho) || projects.some((q) => q.atalho === atalho)) throw new Error(`o atalho "${atalho}" já é de outro andar`);
  if (await temCli(atalho)) throw new Error(`"${atalho}" já é um comando do sistema — escolha outro atalho`);
  let root = path.resolve(exp(String(j.pasta || '').trim())); if (!j.pasta || root === HOME || root === '/') throw new Error('escolha a pasta do projeto');
  if (fs.existsSync(path.join(root, '.git'))) {
    // projeto de um repo só: cria a pasta do andar ao lado (<repo>-orquestra) com um atalho (link) para o repositório — o repo não é tocado
    const repo = root, nome = path.basename(repo); root = path.join(path.dirname(repo), nome + '-orquestra');
    if (!fs.existsSync(path.join(root, '.orquestra'))) { fs.mkdirSync(root, { recursive: true }); const link = path.join(root, nome); if (!fs.existsSync(link)) fs.symlinkSync(path.join('..', nome), link); }
  }
  if (fs.existsSync(path.join(root, '.orquestra'))) throw new Error('essa pasta já tem um andar (.orquestra)');
  if (projects.some((q) => root === q.root || root.startsWith(q.root + path.sep) || q.root.startsWith(root + path.sep))) throw new Error('essa pasta se sobrepõe a outro andar');
  fs.mkdirSync(root, { recursive: true });
  for (const u of (j.clonar || []).map(String).map((x) => x.trim()).filter(Boolean)) {
    if (!/^(https:\/\/|ssh:\/\/|git@)[\w.@:\/~-]+$/.test(u)) throw new Error('URL de repositório inválida: ' + u);
    const nome = path.basename(u).replace(/\.git$/, ''); if (fs.existsSync(path.join(root, nome))) continue;
    progresso('clonando ' + nome + '…');
    const g = await new Promise((ok) => execFile('git', ['clone', u, path.join(root, nome)], { timeout: 900000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, o, se) => ok({ ok: !err, err: String(se || err?.message || '') })));
    if (!g.ok) throw new Error(`não clonei ${u}: ${g.err.slice(-400)}`);
  }
  const info = await inspecionaPasta(root);
  const escolhidos = new Set((j.devs || info.repos.map((r) => r.nome)).map(String));
  const repos = info.repos.filter((r) => escolhidos.has(r.nome));
  if (!info.repos.length) throw new Error('nenhum repositório git nessa pasta (coloque os repos dentro dela ou informe URLs para clonar)');
  const base = /^[\w.\/-]+$/.test(j.base || '') ? j.base : info.repos.some((r) => r.develop) ? 'develop' : 'main';
  const plat = j.git === 'nenhum' ? null : (j.git === 'github' || j.git === 'gitlab') ? j.git : (info.repos.map((r) => r.plat).find(Boolean) || null);
  const contaEq = ACCOUNTS.some((a) => a.id === contaKey(String(j.contaEquipe || ''))) ? String(j.contaEquipe) : '2', contaBoss = /^\d+$/.test(String(j.contaBoss || '')) && ACCOUNTS.some((a) => a.id === 'conta' + j.contaBoss) ? String(j.contaBoss) : '1';
  const mDev = ['sonnet', 'opus', 'haiku'].includes(j.modeloDevs) ? j.modeloDevs : 'sonnet', mEsp = ['sonnet', 'opus', 'haiku'].includes(j.modeloEspecialistas) ? j.modeloEspecialistas : 'sonnet';
  progresso('montando a equipe…');
  const orq = path.join(root, '.orquestra');
  for (const d of ['bin', 'boss', 'qa', 'github']) fs.cpSync(path.join(MODELO, d), path.join(orq, d), { recursive: true });
  for (const f of ['dev-protocolo.md', 'dev-settings.json', 'projeto.env']) fs.copyFileSync(path.join(MODELO, f), path.join(orq, f));
  fs.mkdirSync(path.join(orq, 'estudio', 'data'), { recursive: true }); fs.mkdirSync(path.join(orq, 'relatorios'), { recursive: true });
  fs.copyFileSync(path.join(MODELO, 'hook.mjs'), path.join(orq, 'estudio', 'hook.mjs'));
  fs.mkdirSync(path.join(orq, 'boss', '.claude'), { recursive: true }); fs.renameSync(path.join(orq, 'boss', 'claude-settings.json'), path.join(orq, 'boss', '.claude', 'settings.json'));
  fs.writeFileSync(path.join(orq, 'bin', 'estudio.sh'), scriptEstudio());
  for (const f of fs.readdirSync(path.join(orq, 'bin'))) fs.chmodSync(path.join(orq, 'bin', f), 0o755);
  fs.appendFileSync(path.join(orq, 'projeto.env'), `\nBOSS_CONTA=${contaBoss}\n`);
  if (!j.qa) fs.rmSync(path.join(orq, 'qa'), { recursive: true, force: true });
  if (plat === 'gitlab') { fs.renameSync(path.join(orq, 'github'), path.join(orq, 'gitlab')); fs.writeFileSync(path.join(orq, 'gitlab', 'CLAUDE.md'), GITLAB_MD); }
  else if (!plat) fs.rmSync(path.join(orq, 'github'), { recursive: true, force: true });
  // equipe.conf
  const linhas = ['# Equipe de ' + titulo + ' — criada pelo Orquestra. nome  pasta  conta  modelo'];
  for (const r of repos) linhas.push(`${('dev-' + r.nome).padEnd(24)} ${('.worktrees/dev-' + r.nome).padEnd(34)} ${contaEq}  ${mDev}`);
  if (j.qa) linhas.push(`${'qa'.padEnd(24)} ${'.orquestra/qa'.padEnd(34)} ${contaEq}  ${mEsp}`);
  if (plat) linhas.push(`${plat.padEnd(24)} ${('.orquestra/' + plat).padEnd(34)} ${contaEq}  ${mEsp}`);
  fs.writeFileSync(path.join(orq, 'equipe.conf'), linhas.join('\n') + '\n');
  // aceite de confiança já dado (o andar é seu): o Claude/motor não para na tela "Do you trust this folder?"
  try { confiaPasta(contaDir(null, contaBoss), path.join(orq, 'boss')); } catch {}
  for (const d of ['qa', plat].filter(Boolean)) { const pd = path.join(orq, d); if (!fs.existsSync(pd)) continue; try { /^\d+$/.test(contaEq) ? confiaPasta(contaDir(null, contaEq), pd) : confiaMotor(contaEq, pd); } catch {} }
  fs.writeFileSync(path.join(orq, 'servicos.conf'), ['# Serviços do projeto (terminais srv-* no Herdr). Subir/parar também pelo Orquestra.', '# nome   pasta   comando   [#parar: comando]   [#manual = não sobe sozinho]',
    ...info.repos.map((r) => fs.existsSync(path.join(root, r.nome, 'package.json')) ? `# srv-${r.nome}   ${r.nome}   npm run dev   #manual` : (fs.existsSync(path.join(root, r.nome, 'docker-compose.yml')) || fs.existsSync(path.join(root, r.nome, 'compose.yaml'))) ? `# srv-${r.nome}   ${r.nome}   docker compose up   #parar: docker compose down   #manual` : `# srv-${r.nome}   ${r.nome}   <comando>   #manual`)].join('\n') + '\n');
  // config do andar
  const cores = ['#e8875a', '#5aa9ff', '#b98cff', '#4fd1c5', '#f2c14e', '#ff9ecd', '#8bd450', '#c4a484', '#a0a8b8'];
  const special = {}; if (j.qa) special.qa = { title: 'QA', sub: 'valida no navegador (Playwright)', color: '#e9ff70', decor: 'qa' };
  if (plat) special[plat] = { title: plat === 'github' ? 'GitHub' : 'GitLab', sub: plat === 'github' ? 'PRs e checks' : 'MRs e pipelines', color: '#ff6b35', decor: 'gitlab' };
  fs.writeFileSync(path.join(orq, 'estudio', 'config.json'), JSON.stringify({ project_id: id, atalho, ui: { title: titulo, brand: titulo.length <= 14 ? titulo : titulo.split(' ')[0], subtitle: 'ORQUESTRA DE AGENTES', repos: repos.map((r) => r.nome), labels: {}, colors: Object.fromEntries(repos.map((r, i) => [r.nome, cores[i % cores.length]])), special, about: resumo(j.sobre) || `${titulo}: ${repos.map((r) => r.nome).join(', ')}` }, sessoes: { boss: 'nova', equipe: 'nova', memoria: true } }, null, 2) + '\n');
  // placeholders dos modelos
  const sub = { __TITULO__: titulo, __BASE__: base, __ORQ__: orq, __MAPA__: info.repos.map((r) => `| \`${r.nome}\` | (descreva) | (comandos) |`).join('\n'), __EQUIPE__: repos.map((r) => `| \`dev-${r.nome}\` | dev residente de \`${r.nome}\`; mesa = \`../../.worktrees/dev-${r.nome}\` |`).join('\n') };
  const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, x.name); if (x.isDirectory()) { if (!['relatorios', 'data'].includes(x.name)) walk(f); } else if (/\.(md|json)$/.test(x.name)) { let t = fs.readFileSync(f, 'utf8'), n = t; for (const [k, v] of Object.entries(sub)) n = n.split(k).join(v); if (n !== t) fs.writeFileSync(f, n); } } };
  walk(orq);
  // Boss e protocolo conforme a equipe escolhida
  const bf = path.join(orq, 'boss', 'CLAUDE.md'); let bt = fs.readFileSync(bf, 'utf8');
  if (String(j.sobre || '').trim()) { const cf = path.join(orq, 'estudio', 'config.json'), c = lerJson(cf, {}); c.ui ||= {}; if (!c.ui.about) { c.ui.about = String(j.descricao || '').trim().slice(0, 300) || ((String(j.sobre).trim().split(/\n/)[0].replace(/[*#`]/g, '').match(/^.{20,200}?[.!?](\s|$)/) || [String(j.sobre).trim().split(/\n/)[0].slice(0, 200)])[0].trim()); fs.writeFileSync(cf, JSON.stringify(c, null, 2) + '\n'); } }
  if (String(j.sobre || '').trim()) bt = bt.replace('Pasta do projeto: `../..` a partir daqui.', `Pasta do projeto: \`../..\` a partir daqui.\n\n**Sobre o projeto:** ${String(j.sobre).trim()}`);
  if (plat === 'gitlab') bt = bt.split('send github "ABRIR PR').join('send gitlab "ABRIR MR').split('GitHub abre o PR').join('GitLab abre o MR').replace('| `github` | abre o PR (depois do seu OK) e acompanha os checks |', '| `gitlab` | abre o MR (depois do seu OK) e acompanha a pipeline |');
  if (!plat) bt = bt.replace(/\n\| `github` \|[^\n]*/, '').replace(/4\. Usuário aprovou →[^\n]*/, '4. Usuário aprovou → diga a ele para abrir o MR/PR pela aba **Git** do Orquestra (não há agente de Git nesta equipe).');
  if (!j.qa) bt = bt.replace(/\n\| `qa` \|[^\n]*/, '').replace('**você → dev(s) → QA → você (revisão) →', '**você → dev(s) → você (revisão) →').replace(/2\. \*\*Encerre o turno\.\*\*[^\n]*/, '2. **Encerre o turno.** O dev te avisa quando terminar (não há QA nesta equipe — valide na revisão).').replace(/3\. Com o QA aprovado:/, '3. Com o dev pronto:').replace(/send qa "REVISÃO DO BOSS <slug>: <o que está errado>"/g, 'send dev-<repo> "REVISÃO DO BOSS <slug>: <o que está errado>"').replace(/send qa "REVISÃO DO BOSS <slug>: <problema>"/g, 'send dev-<repo> "REVISÃO DO BOSS <slug>: <problema>"');
  fs.writeFileSync(bf, bt);
  if (!j.qa) { const pf = path.join(orq, 'dev-protocolo.md'); fs.writeFileSync(pf, fs.readFileSync(pf, 'utf8').replace(/Depois \*\*passe para o QA\*\*[^\n]*/, 'Depois avise o Boss com `avisa-boss.sh "<repo> <slug>: pronto — relatório em <caminho>"` (não há QA nesta equipe).').replace(/Se o QA devolver[^\n]*\n/, '')); }
  // revisor
  if (j.revisor) {
    const ad = [path.join(MODELO, '..', 'adicionar-revisor.sh'), path.join(DIR, 'adicionar-revisor.sh')].find((f) => fs.existsSync(f));
    if (ad) await new Promise((ok) => execFile('bash', [ad, root], { timeout: 60000 }, () => ok()));
  }
  // isolamento: este andar não enxerga os outros, e os outros não enxergam este
  for (const q of projects) { for (const f of settingsDe(orq)) negaPasta(f, q.root); for (const f of settingsDe(q.orq)) negaPasta(f, root); }
  // registra o andar no servidor
  const c = lerJson(CFG_FILE, { projects: [] }); c.projects ||= [];
  const rel = root.startsWith(HOME + path.sep) ? '~' + root.slice(HOME.length) : root;
  c.projects.push({ id, orq: path.join(rel, '.orquestra') }); fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2) + '\n');
  // atalho no terminal
  if (!fs.existsSync(ATALHOS)) fs.writeFileSync(ATALHOS, `# Atalhos do Orquestra — rode num terminal do Herdr (os agentes viram filhos desse terminal).\n_orq() {\n  local proj="$1"; shift\n  [ -n "$HC_TERMINAL_ID" ] || { echo "Abra um terminal do Herdr para usar este atalho."; return 1; }\n  [ -x "$proj/.orquestra/bin/boss.sh" ] || { echo "Orquestra não encontrada em $proj"; return 1; }\n  cd "$proj/.orquestra/boss" && ../bin/boss.sh "$@"\n}\n`);
  fs.appendFileSync(ATALHOS, `${atalho}() { _orq "${root.startsWith(HOME + path.sep) ? '$HOME' + root.slice(HOME.length) : root}" "$@"; }\n`);
  for (const rc of ['.zshrc', '.bashrc'].map((x) => path.join(HOME, x)).filter((x) => fs.existsSync(x))) { const t = fs.readFileSync(rc, 'utf8'); if (!t.includes(ATALHOS) && !t.includes(path.basename(ATALHOS))) fs.appendFileSync(rc, `\n# Orquestra (atalhos dos andares)\n[ -f "${ATALHOS}" ] && source "${ATALHOS}"\n`); }
  const p = addProjeto({ id, orq: path.join(root, '.orquestra') });
  // especialistas personalizados
  for (const e of (j.especialistas || []).slice(0, 12)) { progresso('criando ' + (e.nome || 'especialista') + '…'); novoAgente(p, { ...e, tipo: 'especialista', conta: contaEq, modelo: e.modelo || mEsp, subir: false }); }
  reloadTeam(p); emit(p);
  return p;
}

// ---------- gerenciar o prédio: ordem dos andares, nome/atalho, tirar e trazer de volta ----------
function salvaOrdem() { const c = lerJson(CFG_FILE, { projects: [] }); const porId = Object.fromEntries((c.projects || []).map((x) => [x.id, x])); c.projects = projects.map((q) => porId[q.id] || { id: q.id, orq: q.orq }); fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2) + '\n'); broadcastAll('rooms', rooms()); }
function atalhoTroca(antigo, novo, raiz) {
  let t = ''; try { t = fs.readFileSync(ATALHOS, 'utf8'); } catch { return; }
  const re = new RegExp('^' + antigo.replace(/[-]/g, '\\-') + '\\s*\\(\\)\\s*\\{[^\\n]*\\n?', 'm');
  t = t.replace(re, '');
  if (novo) { const r = raiz.startsWith(HOME + path.sep) ? '$HOME' + raiz.slice(HOME.length) : raiz; t = t.replace(/\s*$/, '\n') + `${novo}() { _orq "${r}" "$@"; }\n`; }
  fs.writeFileSync(ATALHOS, t);
}
async function pararAndar(p) {
  for (const [id, a] of Object.entries(p.agents)) { if (id === 'boss') { await hcRun(['send', a.address, '/exit']); continue; } await hcRun(['kill', a.address]); }
  for (const sv of Object.values(p.services)) if (sv.live) { await hcRun(['interrupt', sv.address]); await sleep(500); await hcRun(['kill', sv.address]); }
  if (p.floorTerm) await hcRun(['kill', p.floorTerm]);
}
async function gerenciaPredio(j) {
  if (j.action === 'atalhos-rc') {
    const linha = `\n# Orquestra (atalhos dos andares)\n[ -f "${ATALHOS}" ] && source "${ATALHOS}"\n`; let n = 0;
    for (const rc of ['.zshrc', '.bashrc'].map((x) => path.join(HOME, x))) { const t = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : null; if (t === null && !rc.endsWith('.zshrc')) continue; if (t && t.includes(ATALHOS)) continue; fs.appendFileSync(rc, linha); n++; }
    return n ? 'pronto — os terminais novos já carregam os atalhos' : 'seu shell já carrega os atalhos';
  }
  if (j.action === 'atalhos-recarregar') {
    let n = 0; for (const q of projects) { if (!q.floorTerm || q.agents.boss?.address === q.floorTerm) continue; await hcRun(['send', q.floorTerm, `source ${shq(ATALHOS)}`]); n++; }
    return n ? `atalhos recarregados em ${n} terminal(is) de andar` : 'nenhum terminal de andar livre agora (os que estão com o Boss rodando recarregam quando você der /exit e abrir de novo)';
  }
  if (j.action === 'ordem') {
    const ids = (j.ids || []).map(String); if (ids.length !== projects.length || ids.some((i) => !byId[i])) throw new Error('lista de andares inválida');
    projects.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); salvaOrdem(); return 'ordem dos andares salva';
  }
  if (j.action === 'editar') {
    const p = byId[j.id]; if (!p) throw new Error('andar não encontrado');
    const titulo = String(j.titulo || '').trim().slice(0, 40), atalho = String(j.atalho || '').trim().toLowerCase();
    if (!titulo) throw new Error('dê um nome ao andar');
    if (!/^[a-z][a-z0-9_-]{1,19}$/.test(atalho)) throw new Error('atalho inválido');
    if (atalho !== p.atalho) { if (atalhosUsados().has(atalho) || projects.some((q) => q !== p && q.atalho === atalho)) throw new Error(`o atalho "${atalho}" já é de outro andar`); if (await temCli(atalho)) throw new Error(`"${atalho}" já é um comando do sistema`); }
    const f = path.join(p.orq, 'estudio', 'config.json'), c = lerJson(f, {}); c.ui ||= {};
    c.ui.title = titulo; c.ui.brand = String(j.marca || '').trim().slice(0, 16) || (titulo.length <= 14 ? titulo : titulo.split(' ')[0]); c.atalho = atalho;
    fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n');
    const antigo = p.atalho; if (atalho !== antigo) atalhoTroca(antigo, atalho, p.root);
    reloadTeam(p); emit(p); broadcastAll('rooms', rooms()); return `andar atualizado${atalho !== antigo ? ` — novo atalho: ${atalho} (abra um terminal novo do Herdr para usar)` : ''}`;
  }
  if (j.action === 'info-salvar') {
    const p = byId[j.id]; if (!p) throw new Error('andar não encontrado');
    const f = path.join(p.orq, 'estudio', 'config.json'), c = lerJson(f, {}); c.ui ||= {}; c.ui.about = String(j.descricao || '').trim().slice(0, 300); delete c.descricao;
    fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n'); gravaSobre(p, j.sobre);
    reloadTeam(p); emit(p); broadcastAll('rooms', rooms()); return 'salvo — o Boss passa a usar quando reiniciar ou renovar o contexto';
  }
  if (j.action === 'repo-adicionar') {
    const p = byId[j.id]; if (!p) throw new Error('andar não encontrado');
    const src = path.resolve(exp(String(j.pasta || '').trim())); if (!fs.existsSync(path.join(src, '.git'))) throw new Error('essa pasta não é um repositório git');
    let nome = path.basename(src);
    if (path.dirname(src) !== p.root) {
      if (fs.existsSync(path.join(p.root, nome))) throw new Error(`já existe "${nome}" na pasta do andar`);
      fs.symlinkSync(path.relative(p.root, src), path.join(p.root, nome)); // atalho (link) para o repo — o repo não é tocado
    }
    negaRepoNosEspecialistas(p, path.join(p.root, nome));
    let dev = ''; if (j.dev !== false && !readEquipe(p).some((x) => x.nome === 'dev-' + nome)) { const ref = readEquipe(p).find((x) => x.nome.startsWith('dev-')); dev = novoAgente(p, { tipo: 'dev', repo: nome, conta: j.conta || ref?.conta, modelo: j.modelo || ref?.modelo }); }
    const f = path.join(p.orq, 'estudio', 'config.json'), c = lerJson(f, {}); c.ui ||= {}; c.ui.repos = [...new Set([...(c.ui.repos || []), nome])]; fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n');
    reloadTeam(p); emit(p); broadcastAll('rooms', rooms());
    return `${nome} entrou no andar${dev ? ` com o ${dev} (chame ele no card quando quiser)` : ''}`;
  }
  if (j.action === 'repo-remover') {
    const p = byId[j.id]; if (!p) throw new Error('andar não encontrado');
    const nome = String(j.nome || ''); const l = path.join(p.root, nome); if (!/^[\w.-]+$/.test(nome) || !fs.existsSync(path.join(l, '.git'))) throw new Error('repositório não encontrado');
    const dev = 'dev-' + nome;
    if (p.agents[dev]) { await hcRun(['interrupt', p.agents[dev].address]); await sleep(1000); await hcRun(['kill', p.agents[dev].address]); }
    const ef = path.join(p.orq, 'equipe.conf'); fs.writeFileSync(ef, fs.readFileSync(ef, 'utf8').split('\n').filter((x) => x.trim().split(/\s+/)[0] !== dev).join('\n'));
    const f = path.join(p.orq, 'estudio', 'config.json'), c = lerJson(f, {}); c.ui ||= {}; c.ui.repos = (c.ui.repos || []).filter((r) => r !== nome); fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n');
    let link = false; try { link = fs.lstatSync(l).isSymbolicLink(); } catch {}
    if (link) fs.unlinkSync(l); // só o atalho; o repositório original fica onde está
    reloadTeam(p); emit(p); broadcastAll('rooms', rooms());
    return `${nome} saiu do andar${link ? ' (era um atalho — o repositório original não foi tocado)' : ' — a pasta continua aí, só não tem mais dev nem aparece no escritório'}. A cópia de trabalho do ${dev} (.worktrees/${dev}) ficou guardada.`;
  }
  if (j.action === 'remover') {
    const p = byId[j.id]; if (!p) throw new Error('andar não encontrado');
    if (Object.keys(p.agents).length || Object.values(p.services).some((x) => x.live)) { if (!j.parar) throw new Error('a equipe deste andar ainda está no ar'); await pararAndar(p); }
    projects.splice(projects.indexOf(p), 1); delete byId[p.id]; for (const r of p.clients) { try { r.end(); } catch {} }
    atalhoTroca(p.atalho, null); salvaOrdem();
    return `andar "${p.ui.title || p.id}" saiu do prédio. Nada foi apagado: a pasta ${p.root.replace(HOME, '~')} continua com a equipe e o histórico (.orquestra) — dá para trazer de volta em "Adicionar andar".`;
  }
  if (j.action === 'religar') {
    const root = path.resolve(exp(String(j.pasta || ''))), orq = path.join(root, '.orquestra'), pc = lerJson(path.join(orq, 'estudio', 'config.json'), null);
    if (!pc?.project_id) throw new Error('essa pasta não tem um andar do Orquestra');
    if (byId[pc.project_id]) throw new Error('esse andar já está no prédio');
    const atalho = pc.atalho || pc.project_id;
    const c = lerJson(CFG_FILE, { projects: [] }); const rel = root.startsWith(HOME + path.sep) ? '~' + root.slice(HOME.length) : root;
    c.projects = [...(c.projects || []).filter((x) => x.id !== pc.project_id), { id: pc.project_id, orq: path.join(rel, '.orquestra') }]; fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2) + '\n');
    const p = addProjeto({ id: pc.project_id, orq });
    if (!atalhosUsados().has(atalho)) atalhoTroca(atalho, atalho, root);
    broadcastAll('rooms', rooms()); return `andar "${p.ui.title || p.id}" voltou ao prédio (atalho: ${p.atalho})`;
  }
  throw new Error('ação inválida');
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const projOf = (url) => byId[url.searchParams.get('p')] || projects[0];
const mesmaOrigem = (req) => { const s = req.headers['sec-fetch-site']; const o = req.headers.origin; return (!s || s === 'same-origin' || s === 'none') && (!o || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/stream') {
    const p = projOf(url); if (!p) { res.writeHead(404); return res.end('nenhum andar ainda'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    send(res, 'init', { ...pub(p), project: p.id, token: TOKEN, rooms: rooms(), accounts: accounts(), interactions: p.interactions.slice(-60) });
    p.clients.add(res);
    req.on('close', () => p.clients.delete(res));
    return;
  }
  if (url.pathname === '/config') {
    const p = projOf(url); if (!p) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    reloadTeam(p);
    try { const ui = JSON.parse(fs.readFileSync(path.join(p.orq, 'estudio', 'config.json'), 'utf8')).ui || {}; p.ui = { ...ui }; p.special = new Set(Object.keys(ui.special || {})); } catch {} // sempre a configuração atual
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...p.ui, project: p.id, atalho: p.atalho }));
  }
  if (url.pathname === '/screen') {
    const p = projOf(url), a = p.agents[url.searchParams.get('agent')];
    if (!a) { res.writeHead(404); return res.end('agente não está vivo'); }
    execFile(HC, ['read', a.address, '--lines', '80'], { timeout: 8000, maxBuffer: 2e6 }, (err, out) => {
      res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(err ? 'não consegui ler a tela: ' + err.message : out);
    });
    return;
  }
  if (url.pathname === '/chat') {
    const p = projOf(url);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify((p.chat[url.searchParams.get('agent')] || []).slice(-80)));
  }
  if (url.pathname === '/sessions') {
    const p = projOf(url), id = url.searchParams.get('agent') || '';
    const salvas = new Set((() => { try { return fs.readdirSync(sessDir(p, id)); } catch { return []; } })());
    const mf = memFile(p, id); let mem = null; try { const st = fs.statSync(mf); mem = { at: st.mtimeMs, text: fs.readFileSync(mf, 'utf8').slice(0, 6000), path: mf }; } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ memoria: mem, renovando: renewing.has(p.id + '/' + id), pasta: sessDir(p, id), sessoes: sessionsOf(p, id).slice(0, 40).map((s, i) => ({ sid: s.sid, start: s.start, end: s.end, n: s.n, conta: s.conta, atual: i === 0 && !!p.agents[id], salva: salvas.has(sessFileName(s)) })) }));
  }
  if (url.pathname === '/session.md') {
    const p = projOf(url), s = sessionsOf(p, url.searchParams.get('agent') || '').find((x) => x.sid === url.searchParams.get('sid'));
    if (!s) { res.writeHead(404); return res.end('sessão não encontrada'); }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', ...(url.searchParams.get('dl') ? { 'Content-Disposition': `attachment; filename="${s.id}_${sessFileName(s)}"` } : {}) });
    return res.end(sessionMd(s));
  }
  if (url.pathname === '/settings' && req.method === 'GET') { const p = projOf(url); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(readSettings(p))); }
  if ((url.pathname === '/settings' || url.pathname === '/sessao') && req.method === 'POST') {
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token'); }
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 4000) req.destroy(); });
    req.on('end', async () => {
      const out = (code, msg, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200, out: msg, ...extra })); };
      let j; try { j = JSON.parse(body); } catch { return out(400, 'json'); }
      const p = byId[j.project]; if (!p) return out(404, 'projeto');
      if (url.pathname === '/settings') { try { return out(200, 'salvo', { settings: writeSettings(p, j.settings || {}) }); } catch (e) { return out(500, 'não consegui salvar: ' + e.message); } }
      const id = String(j.agent || ''); if (!p.team.includes(id) && !p.agents[id]) return out(404, id + ' não é deste projeto');
      if (j.action === 'salvar') {
        const s = j.sid ? sessionsOf(p, id).find((x) => x.sid === j.sid) : sessionsOf(p, id)[0];
        if (!s) return out(404, 'sessão não encontrada');
        try { const f = saveSession(s); return out(200, 'salva em ' + f.replace(HOME, '~'), { path: f }); } catch (e) { return out(500, e.message); }
      }
      if (j.action === 'renovar') { const m = await renew(p, id); return out(/^renovando/.test(m) ? 200 : 409, m); }
      if (j.action === 'retomar') {
        const s = sessionsOf(p, id).find((x) => x.sid === j.sid); if (!s) return out(404, 'sessão não encontrada');
        if (id === 'boss') {
          const a = p.agents.boss;
          if (!a) return out(400, `O Boss não está no ar. Para retomar essa sessão, no terminal do Herdr rode:\nORQ_RESUME=${s.sid} ${p.id}`);
          if (a.status === 'working') return out(409, 'o Boss está trabalhando agora — espere ele terminar');
          await hcRun(['send', a.address, '/resume ' + s.sid]); logEvent(p, { from: 'voce', to: 'boss', kind: 'servico', text: 'retomar sessão de ' + dt(s.start) });
          return out(200, 'pedi ao Boss para retomar a sessão de ' + dt(s.start));
        }
        if (!p.team.includes(id)) return out(400, 'dev extra não é retomado por aqui');
        const nomeHc = tnHc(p, id);
        if (p.agents[id]) { await hcRun(['interrupt', nomeHc]); await sleep(1200); await hcRun(['kill', nomeHc]); await sleep(1500); }
        const env = { ...process.env, ORQ_RESUME: s.sid, HC_TERMINAL_ID: p.agents.boss?.address || '' }; if (!env.HC_TERMINAL_ID) delete env.HC_TERMINAL_ID;
        execFile(path.join(p.orq, 'bin', 'equipe.sh'), ['--so', id], { env, timeout: 90000, maxBuffer: 2e6 }, (err, o, se) => {
          logEvent(p, { from: 'voce', to: id, kind: 'servico', text: 'retomar sessão de ' + dt(s.start) }); setTimeout(pollHc, 1500);
          out(err ? 500 : 200, err ? String(se || err.message) : `${id} voltou na sessão de ${dt(s.start)}`);
        });
        return;
      }
      out(400, 'ação inválida');
    });
    return;
  }
  if (url.pathname === '/terminal' && req.method === 'POST') {
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token'); }
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 2000) req.destroy(); });
    req.on('end', async () => {
      const out = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200, out: msg })); };
      let j; try { j = JSON.parse(body); } catch { return out(400, 'json'); }
      const p = byId[j.project]; if (!p) return out(404, 'projeto');
      if (j.action === 'iniciar-boss') {
        if (p.agents.boss) return out(409, 'o Boss deste andar já está no ar');
        try { return out(200, await iniciarBoss(p)); } catch (e) { return out(500, e.message); }
      }
      out(400, 'ação inválida');
    });
    return;
  }
  if (url.pathname === '/skills' && req.method === 'GET') {
    const p = projOf(url), f = fontesDe(p, url.searchParams.get('agent') || '');
    res.writeHead(f ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(f || { erro: 'agente não é deste andar' }));
  }
  if (url.pathname === '/skill' && req.method === 'GET') {
    const p = projOf(url), id = url.searchParams.get('agent') || '', arq = url.searchParams.get('arquivo') || '';
    if (!dentroDeFonte(p, id, arq)) { res.writeHead(403); return res.end('fora das pastas de skills deste agente'); }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); try { return res.end(fs.readFileSync(arq, 'utf8')); } catch (e) { return res.end(''); }
  }
  if (url.pathname === '/agente' && req.method === 'GET') {
    const p = projOf(url); reloadTeam(p);
    const id = url.searchParams.get('agent') || '', a = id ? agenteInfo(p, id) : null;
    const devs = new Set(readEquipe(p).map((x) => x.nome));
    const repos = fs.readdirSync(p.root).filter((d) => fs.existsSync(path.join(p.root, d, '.git'))).map((d) => ({ nome: d, temDev: devs.has('dev-' + d) }));
    let instr = ''; if (a) { try { instr = fs.readFileSync(a.instr, 'utf8'); } catch {} }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ repos, contas: ACCOUNTS.map((x) => ({ id: x.id, nome: x.nome || '', provedor: x.provedor, nomeProvedor: PROVEDORES[x.provedor]?.nome, n: x.provedor === 'claude' ? x.id.replace('conta', '') : x.id, email: acctInfo[x.id]?.email || '', modelos: PROVEDORES[x.provedor]?.modelos || ['sonnet', 'haiku', 'opus'] })), agente: a ? { id, tipo: a.tipo, conta: a.conta, modelo: a.modelo || '', motor: motorDe(a), motorNome: PROVEDORES[motorDe(a)]?.nome || '', sync: motorDe(a) ? syncInfo(a.cwd) : null, arquivo: a.instr.replace(HOME, '~'), instrucoes: instr } : null }));
  }
  if ((url.pathname === '/skills' || url.pathname === '/agente') && req.method === 'POST') {
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token'); }
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 300000) req.destroy(); });
    req.on('end', async () => {
      const out = (code, msg, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200, out: msg, ...extra })); };
      let j; try { j = JSON.parse(body); } catch { return out(400, 'json'); }
      const p = byId[j.project]; if (!p) return out(404, 'projeto');
      reloadTeam(p);
      try {
        if (url.pathname === '/agente') {
          if (j.action === 'novo') {
            const nome = novoAgente(p, j);
            logEvent(p, { from: 'voce', to: 'boss', kind: 'servico', text: 'novo agente na equipe: ' + nome });
            if (!j.subir) return out(200, nome + ' entrou na equipe — chame ele no card quando quiser', { nome });
            const env = { ...process.env, HC_TERMINAL_ID: p.agents.boss?.address || '' }; if (!env.HC_TERMINAL_ID) delete env.HC_TERMINAL_ID;
            execFile(path.join(p.orq, 'bin', 'equipe.sh'), ['--so', nome], { env, timeout: 120000, maxBuffer: 2e6 }, (err, o, se) => { setTimeout(pollHc, 1500); out(200, err ? `${nome} criado, mas não subiu: ${String(se || err.message).slice(0, 300)}` : `${nome} entrou na equipe e está chegando ao escritório`, { nome }); });
            return;
          }
          if (j.action === 'conta-modelo') {
            const id = String(j.agent || ''); if (!agenteInfo(p, id)) return out(404, 'agente não é deste andar');
            contaModeloAgente(p, id, String(j.conta || ''), String(j.modelo || '')); reloadTeam(p);
            logEvent(p, { from: 'voce', to: id, kind: 'servico', text: `${id}: conta ${j.conta}${j.modelo ? ' · ' + j.modelo : ''}` });
            return out(200, 'salvo — vale quando ele reiniciar');
          }
          if (j.action === 'instrucoes') {
            const a = agenteInfo(p, String(j.agent || '')); if (!a) return out(404, 'agente não é deste andar');
            fs.mkdirSync(path.dirname(a.instr), { recursive: true }); fs.writeFileSync(a.instr, String(j.texto || '').replace(/\r/g, ''));
            logEvent(p, { from: 'voce', to: a.id, kind: 'servico', text: 'instruções de ' + a.id + ' atualizadas' });
            return out(200, a.tipo === 'dev' ? 'salvo — vale quando ele reiniciar' : 'salvo — vale quando ele reiniciar ou renovar o contexto');
          }
          return out(400, 'ação inválida');
        }
        // skills
        const id = String(j.agent || ''); if (!agenteInfo(p, id)) return out(404, 'agente não é deste andar');
        if (j.action === 'sincronizar') {
          const alvos = j.todos ? motoresDoAndar(p) : [id]; const rs = await Promise.all(alvos.map((x) => syncMotor(p, x)));
          const ok = rs.filter((r) => r && !r.erro); if (!ok.length) return out(400, rs.find((r) => r?.erro)?.erro || 'este agente usa o Claude — as skills já valem direto');
          return out(200, alvos.map((x, i) => rs[i]?.erro ? `${x}: erro` : `${x}: ${rs[i]?.skills.length ?? 0} skill(s)`).join(' · ') + ' sincronizadas', { resultado: rs });
        }
        if (j.action === 'liberar' || j.action === 'bloquear') {
          if (id === 'boss') return out(400, 'o Boss segue as regras do projeto — não dá para liberar skill bloqueada para ele');
          const sk = String(j.nome || ''); if (!/^[\w.:-]{1,80}$/.test(sk)) return out(400, 'nome de skill inválido');
          const a = agenteInfo(p, id), lib = liberadasDe(p, id); j.action === 'liberar' ? lib.add(sk) : lib.delete(sk);
          if (j.action === 'liberar' && !bloqueio(a.settings)(sk)) return out(400, sk + ' não está bloqueada para ' + id);
          const dir = path.join(p.orq, 'skills', id); fs.mkdirSync(dir, { recursive: true });
          const lf = path.join(dir, 'liberadas.json'), gf = path.join(dir, 'settings.gerado.json');
          if (lib.size) fs.writeFileSync(lf, JSON.stringify([...lib].sort(), null, 2) + '\n'); else { fs.rmSync(lf, { force: true }); fs.rmSync(gf, { force: true }); }
          logEvent(p, { from: 'voce', to: id, kind: 'servico', text: `${id}: skill ${sk} ${j.action === 'liberar' ? 'liberada' : 'bloqueada de novo'}` });
          let extra = ''; if (motorDe(a)) { const r = await syncMotor(p, id); if (r && !r.erro) extra = ' · cópias em .agents/skills atualizadas'; }
          return out(200, `${sk} ${j.action === 'liberar' ? 'liberada' : 'bloqueada de novo'} para ${id} — vale quando ele reiniciar${extra}`);
        }
        const esc = j.escopo === 'equipe' ? 'equipe' : 'agente', raiz = escopoDir(p, id, esc), ativas = path.join(raiz, '.claude', 'skills'), desat = path.join(raiz, 'skills-desativadas');
        const nome = String(j.nome || '').toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(nome)) return out(400, 'nome da skill: letras minúsculas, números e hífen');
        fs.mkdirSync(ativas, { recursive: true });
        const alvosSync = esc === 'equipe' ? motoresDoAndar(p) : motorDe(agenteInfo(p, id)) ? [id] : [];
        const fim = async (code, msg) => { if (code === 200 && alvosSync.length) { const rs = await Promise.all(alvosSync.map((x) => syncMotor(p, x))); const n = rs.filter((r) => r && !r.erro).length; if (n) msg += ` · sincronizada com ${n === 1 && alvosSync.length === 1 ? alvosSync[0] : n + ' agente(s) em outros motores'}`; } out(code, msg); };
        if (j.action === 'salvar') {
          fs.mkdirSync(path.join(ativas, nome), { recursive: true }); fs.writeFileSync(path.join(ativas, nome, 'SKILL.md'), corpoSkill(nome, j.descricao, j.conteudo));
          return fim(200, `skill ${nome} salva (${esc === 'equipe' ? 'para a equipe toda' : 'só para ' + id}) — já vale nas próximas mensagens`);
        }
        if (j.action === 'copiar') {
          const de = String(j.de || ''); if (!dentroDeFonte(p, id, de)) return out(403, 'origem fora das skills deste agente');
          if (fs.existsSync(path.join(ativas, nome))) return out(409, 'já existe uma skill ' + nome + ' aí');
          fs.cpSync(path.dirname(de), path.join(ativas, nome), { recursive: true, dereference: true }); return fim(200, `skill ${nome} copiada`);
        }
        if (j.action === 'desativar' || j.action === 'ativar') {
          const [a, b] = j.action === 'desativar' ? [ativas, desat] : [desat, ativas];
          if (!fs.existsSync(path.join(a, nome))) return out(404, 'skill não encontrada'); fs.mkdirSync(b, { recursive: true });
          if (fs.existsSync(path.join(b, nome))) return out(409, 'já existe ' + nome + ' do outro lado');
          fs.renameSync(path.join(a, nome), path.join(b, nome)); return fim(200, `skill ${nome} ${j.action === 'desativar' ? 'desativada' : 'ativada'}`);
        }
        if (j.action === 'remover') {
          const src = [path.join(ativas, nome), path.join(desat, nome)].find((x) => fs.existsSync(x)); if (!src) return out(404, 'skill não encontrada');
          const lx = path.join(p.orq, 'skills', '.lixeira'); fs.mkdirSync(lx, { recursive: true }); fs.renameSync(src, path.join(lx, `${id}-${nome}-${Date.now()}`));
          return fim(200, `skill ${nome} removida (guardada em .orquestra/skills/.lixeira)`);
        }
        out(400, 'ação inválida');
      } catch (e) { out(400, e.message); }
    });
    return;
  }
  if (url.pathname === '/git/contas' && req.method === 'GET') {
    const p = projOf(url); (async () => { const c = await contasGit(p); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(c)); })(); return;
  }
  if (url.pathname === '/git/login' && req.method === 'GET') {
    const l = logins.get(url.searchParams.get('s') || ''); res.writeHead(l ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(l ? { codigo: l.codigo, url: l.url, fim: l.fim, ok: l.ok, saida: l.saida.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').slice(-1500) } : { erro: 'sessão' }));
  }
  if ((url.pathname === '/git/login' || url.pathname === '/git/instalar') && req.method === 'POST') {
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token'); }
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      const out = (code, msg, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200, out: msg, ...extra })); };
      let j; try { j = JSON.parse(body); } catch { return out(400, 'json'); }
      const plat = j.plat === 'github' ? 'github' : 'gitlab', cli = plat === 'github' ? 'gh' : 'glab', host = String(j.host || '');
      if (!/^[a-z0-9.-]+$/i.test(host)) return out(400, 'host inválido');
      if (url.pathname === '/git/instalar') {
        if (process.platform !== 'darwin') return out(400, `instale o ${cli} pelo gerenciador de pacotes do seu sistema (veja ${plat === 'github' ? 'https://cli.github.com' : 'https://gitlab.com/gitlab-org/cli'})`);
        if (!(await temCli('brew'))) return out(400, 'precisa do Homebrew (https://brew.sh) para instalar o ' + cli);
        const r = await cliRun('brew', HOME, ['install', cli], 600000); return r.ok ? out(200, cli + ' instalado') : out(500, (r.err || r.out).slice(-800));
      }
      if (!(await temCli(cli))) return out(400, `o ${cli} não está instalado`);
      if (j.modo === 'token') {
        const tk = String(j.token || '').trim(); if (tk.length < 10 || /\s/.test(tk)) return out(400, 'token inválido');
        const args = plat === 'github' ? ['auth', 'login', '--hostname', host, '--git-protocol', 'https', '--with-token'] : ['auth', 'login', '--hostname', host, '--stdin', '--api-protocol', 'https', '--git-protocol', 'ssh'];
        const r = await new Promise((ok) => { const ch = spawn(cli, args, { cwd: HOME, env: { ...process.env, NO_COLOR: '1' } }); let o = ''; ch.stdout.on('data', (d) => (o += d)); ch.stderr.on('data', (d) => (o += d)); ch.on('error', (e) => ok({ ok: false, o: e.message })); ch.on('exit', (c) => ok({ ok: c === 0, o })); ch.stdin.end(tk + '\n'); });
        if (!r.ok) return out(400, 'não entrou: ' + r.o.replace(tk, '***').slice(-600));
        if (plat === 'github') await cliRun('gh', HOME, ['auth', 'setup-git', '--hostname', host]);
        return out(200, `pronto — ${cli} logado em ${host}`);
      }
      if (j.modo === 'web' && plat === 'github') {
        const id = crypto.randomBytes(8).toString('hex'), l = { saida: '', codigo: null, url: null, fim: false, ok: false, enter: false };
        logins.set(id, l); setTimeout(() => logins.delete(id), 15 * 60e3);
        const ch = spawn('python3', ['-c', PTY_PY, '100', '30', 'gh', 'auth', 'login', '--hostname', host, '--git-protocol', 'https', '--web', '--scopes', 'repo,workflow,read:org'], { cwd: HOME, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
        ch.stdin.on('error', () => {});
        const ler = (d) => { l.saida += d; l.codigo ||= (l.saida.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/) || [])[1] || null; l.url ||= (l.saida.match(/https:\/\/\S*login\/device\S*/) || [])[0] || (l.codigo ? `https://${host}/login/device` : null);
          if (!l.enter && /Press Enter|pressione Enter|Enter to open/i.test(l.saida)) { l.enter = true; ch.stdin.write('\r'); }
          if (/Authenticate Git with your GitHub credentials\?\s*\(Y\/n\)/i.test(l.saida) && !l.yes) { l.yes = true; ch.stdin.write('Y\r'); } };
        ch.stdout.on('data', ler); ch.stderr.on('data', ler);
        ch.on('exit', async (c) => { l.fim = true; l.ok = c === 0 && !/error|failed/i.test(l.saida.slice(-300)); if (l.ok) await cliRun('gh', HOME, ['auth', 'setup-git', '--hostname', host]); });
        setTimeout(() => { if (!l.fim) { try { ch.kill(); } catch {} } }, 14 * 60e3);
        return out(200, 'aguardando o código', { sessao: id });
      }
      out(400, 'modo inválido');
    });
    return;
  }
  if (url.pathname === '/git' && req.method === 'GET') {
    const p = projOf(url);
    (async () => { const lista = await Promise.all(gitRepos(p).map((r) => gitResumo(p, r))); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ repos: lista, protegidas: [...protegidas(p)] })); })();
    return;
  }
  if (url.pathname === '/git/repo' && req.method === 'GET') {
    const p = projOf(url), r = repoDe(p, url.searchParams.get('r') || '');
    if (!r) { res.writeHead(404); return res.end('repo'); }
    (async () => {
      const [st, sub, log, rem, rb] = await Promise.all([gitStatus(r.dir), submodulos(r.dir), gitRun(r.dir, ['log', '-30', '--format=%h\x1f%an\x1f%ar\x1f%s']), gitRun(r.dir, ['config', '--get', 'remote.origin.url']), gitRun(r.dir, ['for-each-ref', '--count=200', '--format=%(refname:lstrip=3)', 'refs/remotes/origin'])]);
      const prot = protegidas(p), alvo = (await gitRun(r.dir, ['rev-parse', '-q', '--verify', 'refs/remotes/origin/develop'])).ok ? 'develop' : 'main';
      for (const a of st.arquivos || []) a.bloqueio = SENSIVEL(a.f) ? 'arquivo sensível (segredo/.env/chave)' : [...sub].some((s) => a.f === s || a.f.startsWith(s + '/')) ? 'submódulo — não se altera nem commita' : null;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ...st, id: r.id, nome: r.nome, tipo: r.tipo, protegida: !!st.branch && prot.has(st.branch), plataforma: plataforma(rem.out), alvo, branchesRemotas: rb.out.split('\n').filter((x) => x && x !== 'HEAD'), commits: log.out.trim().split('\n').filter(Boolean).map((l) => { const [h, a, q, m] = l.split('\x1f'); return { h, a, q, m }; }) }));
    })();
    return;
  }
  if (url.pathname === '/git/diff' && req.method === 'GET') {
    const p = projOf(url), r = repoDe(p, url.searchParams.get('r') || ''), f = url.searchParams.get('f') || '';
    if (!r || !f || f.includes('\0') || path.isAbsolute(f) || f.split('/').includes('..')) { res.writeHead(400); return res.end('arquivo'); }
    if (SENSIVEL(f)) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('(arquivo sensível — o conteúdo não é exibido)'); }
    (async () => {
      const novo = url.searchParams.get('novo') === '1', staged = url.searchParams.get('staged') === '1';
      const d = novo ? await gitRun(r.dir, ['diff', '--no-index', '--', '/dev/null', f]) : await gitRun(r.dir, ['diff', ...(staged ? ['--cached'] : []), '--', f]);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end((d.out || d.err || '(sem diferenças)').slice(0, 300000));
    })();
    return;
  }
  if (url.pathname === '/git' && req.method === 'POST') {
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token'); }
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 200000) req.destroy(); });
    req.on('end', async () => {
      const out = (code, msg, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200, out: msg, ...extra })); };
      let j; try { j = JSON.parse(body); } catch { return out(400, 'json'); }
      const p = byId[j.project]; if (!p) return out(404, 'projeto');
      const r = repoDe(p, String(j.repo || '')); if (!r) return out(404, 'repositório');
      const st = await gitStatus(r.dir); if (st.erro) return out(500, st.erro);
      const prot = protegidas(p), sub = await submodulos(r.dir), br = st.branch;
      const log = (t) => logEvent(p, { from: 'voce', to: 'boss', kind: 'servico', text: `git ${r.nome}: ${t}`.slice(0, 220) });
      const arquivos = (Array.isArray(j.files) ? j.files : []).map(String).filter((f) => f && !f.includes('\0') && !path.isAbsolute(f) && !f.split('/').includes('..'));
      const bloq = (f) => SENSIVEL(f) ? 'arquivo sensível' : [...sub].some((s) => f === s || f.startsWith(s + '/')) ? 'submódulo' : null;
      try {
        switch (j.action) {
          case 'stage': {
            const ruins = arquivos.filter(bloq); if (ruins.length) return out(400, 'não adiciono: ' + ruins.map((f) => `${f} (${bloq(f)})`).join(', '));
            if (!arquivos.length) return out(400, 'nenhum arquivo');
            const g = await gitRun(r.dir, ['add', '--', ...arquivos]); return g.ok ? out(200, `${arquivos.length} arquivo(s) adicionado(s)`) : out(500, g.err);
          }
          case 'unstage': {
            if (!arquivos.length) return out(400, 'nenhum arquivo');
            const g = await gitRun(r.dir, ['restore', '--staged', '--', ...arquivos]); return g.ok ? out(200, `${arquivos.length} arquivo(s) tirado(s) do commit`) : out(500, g.err);
          }
          case 'branch': {
            const nb = String(j.branch || '').trim();
            if (!/^[A-Za-z0-9._\/-]{2,100}$/.test(nb) || nb.includes('..') || nb.endsWith('/') || nb.startsWith('-')) return out(400, 'nome de branch inválido');
            if (prot.has(nb)) return out(400, `${nb} é uma branch protegida — use outro nome (ex.: feature/…, fix/…)`);
            const g = await gitRun(r.dir, ['switch', '-c', nb]); if (!g.ok) return out(500, g.err);
            log('nova branch ' + nb); return out(200, `branch ${nb} criada a partir de ${br || 'HEAD'} (suas alterações vieram junto)`);
          }
          case 'commit': {
            const msg = String(j.mensagem || '').trim(); if (msg.length < 5) return out(400, 'escreva uma mensagem de commit');
            if (!br) return out(400, 'o repo não está em nenhuma branch — crie uma');
            if (prot.has(br)) return out(400, `não commito direto em ${br} (branch protegida). Crie uma branch antes — ex.: feature/<assunto>`);
            const staged = st.arquivos.filter((a) => a.staged).map((a) => a.f); if (!staged.length) return out(400, 'nada adicionado ao commit');
            const ruins = staged.filter(bloq); if (ruins.length) return out(400, 'tire do commit: ' + ruins.join(', '));
            const g = await gitRun(r.dir, ['commit', '-m', msg], 120000); if (!g.ok) return out(500, (g.out + '\n' + g.err).trim().slice(-1500));
            log(`commit em ${br}: ${msg.split('\n')[0]}`); return out(200, g.out.split('\n')[0] || 'commit feito');
          }
          case 'fetch': { const g = await gitRun(r.dir, ['fetch', '--prune', 'origin'], 90000); return g.ok ? out(200, 'atualizado do remoto') : out(500, 'fetch falhou (VPN/rede?): ' + g.err.slice(-400)); }
          case 'pull': {
            if (!st.upstream) return out(400, 'esta branch não acompanha nenhuma branch remota');
            const g = await gitRun(r.dir, ['pull', '--ff-only'], 120000); if (!g.ok) return out(500, 'não deu para puxar sem merge (--ff-only): ' + g.err.slice(-600));
            log('pull em ' + br); return out(200, 'puxado: ' + (g.out.trim().split('\n').pop() || 'ok'));
          }
          case 'push': {
            if (!br) return out(400, 'o repo não está em nenhuma branch');
            if (prot.has(br)) return out(400, `push em ${br} é proibido pelas regras — só via MR/PR`);
            const g = await gitRun(r.dir, ['push', '-u', 'origin', br], 180000); if (!g.ok) return out(500, 'push falhou: ' + g.err.slice(-800));
            const link = (g.err.match(/https?:\/\/\S+/) || [])[0];
            log('push de ' + br); return out(200, `branch ${br} enviada`, { link });
          }
          case 'mr': {
            if (!br || prot.has(br)) return out(400, 'o MR/PR sai de uma branch sua, não de ' + (br || 'HEAD'));
            const alvo = String(j.alvo || 'develop'); if (!/^[A-Za-z0-9._\/-]+$/.test(alvo) || alvo === br) return out(400, 'branch de destino inválida');
            const titulo = String(j.titulo || '').trim(), desc = String(j.descricao || '').trim(); if (titulo.length < 5) return out(400, 'dê um título ao MR/PR');
            if (!st.upstream || st.ahead > 0) { const g = await gitRun(r.dir, ['push', '-u', 'origin', br], 180000); if (!g.ok) return out(500, 'push falhou: ' + g.err.slice(-800)); }
            const url0 = (await gitRun(r.dir, ['config', '--get', 'remote.origin.url'])).out, plat = plataforma(url0);
            let g;
            if (plat === 'github') g = await cliRun('gh', r.dir, ['pr', 'create', '--base', alvo, '--head', br, '--title', titulo, '--body', desc || titulo]);
            else if (plat === 'gitlab') g = await cliRun('glab', r.dir, ['mr', 'create', '--source-branch', br, '--target-branch', alvo, '--title', titulo, '--description', desc || titulo, '--yes', '--remove-source-branch']);
            else return out(400, 'não reconheci o remoto (nem GitHub nem GitLab)');
            const link = ((g.out + g.err).match(/https?:\/\/\S+\/(?:pull|merge_requests)\/\d+/) || [])[0];
            if (!g.ok && !link) return out(500, `${plat === 'github' ? 'gh' : 'glab'} falhou: ` + (g.err || g.out).slice(-800), { login: /auth|login|token|401|403|unauthori|credential|ENOENT/i.test(g.err + g.out) ? hostDe(url0) : null });
            log(`${plat === 'github' ? 'PR' : 'MR'} ${br} → ${alvo}: ${titulo}`); return out(200, `${plat === 'github' ? 'PR' : 'MR'} aberto: ${br} → ${alvo}`, { link });
          }
          case 'merge': {
            // merge do PR/MR é decisão SUA: o botão só existe para você (os agentes continuam proibidos de fazer merge)
            if (!br || prot.has(br)) return out(400, 'escolha a branch do PR/MR (não ' + (br || 'HEAD') + ')');
            const url0 = (await gitRun(r.dir, ['config', '--get', 'remote.origin.url'])).out, plat = plataforma(url0);
            let g;
            if (plat === 'github') g = await cliRun('gh', r.dir, ['pr', 'merge', br, '--squash', '--delete-branch'], 120000);
            else if (plat === 'gitlab') g = await cliRun('glab', r.dir, ['mr', 'merge', br, '--squash', '--remove-source-branch', '--yes'], 120000);
            else return out(400, 'não reconheci o remoto');
            const txt = (g.out + g.err).trim();
            if (!g.ok) return out(500, 'o merge não foi feito: ' + txt.slice(-800), { login: /auth|login|token|401|403|credential|ENOENT/i.test(txt) ? hostDe(url0) : null });
            log(`merge do ${plat === 'github' ? 'PR' : 'MR'} de ${br}`);
            // volta para a branch de destino e traz o merge (só se não houver alterações pendentes)
            const alvo = (await gitRun(r.dir, ['rev-parse', '-q', '--verify', 'refs/remotes/origin/develop'])).ok ? 'develop' : 'main';
            let extra = '';
            const st2 = await gitStatus(r.dir);
            if (!(st2.arquivos || []).length) { await gitRun(r.dir, ['fetch', '--prune', 'origin'], 90000); const sw = await gitRun(r.dir, ['switch', alvo]); const pl = sw.ok ? await gitRun(r.dir, ['pull', '--ff-only'], 120000) : sw; extra = pl.ok ? ` — você está de volta em ${alvo}, atualizado` : ` — volte para ${alvo} e puxe quando puder`; }
            else extra = ` — você tem alterações pendentes, então continuei em ${br}`;
            return out(200, `merge feito (squash) de ${br}${extra}`);
          }
          default: return out(400, 'ação inválida');
        }
      } catch (e) { out(500, e.message); }
    });
    return;
  }
  if (url.pathname === '/contas' && req.method === 'GET') {
    if (!mesmaOrigem(req)) { res.writeHead(403); return res.end(); }
    readAccounts(); const uso = usoDasContas();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    (async () => {
      const lista = await Promise.all(ACCOUNTS.map(async (a) => {
        const P = PROVEDORES[a.provedor] || {}; const inst = await temCli(P.cli || 'claude');
        const logada = a.provedor === 'claude' ? !!acctInfo[a.id]?.email : !!P.logado?.(a.dir);
        return { id: a.id, nome: a.nome || '', provedor: a.provedor, nomeProvedor: P.nome, n: a.id.replace('conta', ''), pasta: a.dir.replace(HOME, '~'), ...(acctInfo[a.id] || {}), instalado: inst, logada, modelos: P.modelos || ['sonnet', 'haiku', 'opus'], uso: uso[a.id] || [] };
      }));
      res.end(JSON.stringify({ contas: lista, disponiveis: Object.entries(PROVEDORES).filter(([k]) => k !== 'claude' && !ACCOUNTS.some((a) => a.id === k)).map(([k, v]) => ({ id: k, nome: v.nome })) }));
    })();
    return;
  }
  if (url.pathname === '/contas' && req.method === 'POST') {
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token'); }
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 4000) req.destroy(); });
    req.on('end', () => {
      const out = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200, out: msg })); };
      let j; try { j = JSON.parse(body); } catch { return out(400, 'json'); }
      try {
        if (j.action === 'renomear') {
          const a = ACCOUNTS.find((x) => x.id === j.id); if (!a) return out(404, 'conta não encontrada');
          a.nome = String(j.nome || '').trim().slice(0, 30); salvaContas(); emitAccounts(); return out(200, a.nome ? `agora a ${a.id} se chama "${a.nome}"` : 'nome removido');
        }
        if (j.action === 'medir') {
          const a = ACCOUNTS.find((x) => x.id === j.id); if (!a) return out(404, 'conta não encontrada');
          return medirUso(a).then((u) => { emitAccounts(); out(u ? 200 : 500, u ? `medido: sessão ${u.h5 ?? '?'}% · semana ${u.d7 ?? '?'}%` : 'não consegui ler o /usage (a conta está logada? veja em "entrar")'); });
        }
        if (j.action === 'instalar') {
          const a = ACCOUNTS.find((x) => x.id === j.id); const P = a && PROVEDORES[a.provedor]; if (!P?.instalar) return out(400, 'nada para instalar');
          const cmd = P.instalar[process.platform === 'darwin' ? 'darwin' : 'outro'];
          return execFile(process.env.SHELL || '/bin/zsh', ['-lc', cmd], { timeout: 600000, maxBuffer: 5e6 }, (err, o, se) => out(err ? 500 : 200, err ? `não instalou (${cmd}): ` + String(se || err.message).slice(-600) : `${P.nome} instalado`));
        }
        if (j.action === 'adicionar' && j.provedor && j.provedor !== 'claude') {
          const P = PROVEDORES[j.provedor]; if (!P) return out(400, 'motor desconhecido'); if (ACCOUNTS.some((a) => a.id === j.provedor)) return out(409, P.nome + ' já está na lista');
          ACCOUNTS.push({ id: j.provedor, provedor: j.provedor, dir: exp(P.home) }); salvaContas(); return out(200, `${P.nome} adicionado — agora instale (se precisar) e entre`);
        }
        if (j.action === 'adicionar') {
          let n = 2; while (ACCOUNTS.some((a) => a.id === 'conta' + n)) n++;
          const dir = path.join(HOME, '.claude-conta' + n); fs.mkdirSync(dir, { recursive: true });
          // reaproveita skills, comandos, agentes e plugins da conta 1
          for (const it of ['skills', 'commands', 'agents', 'plugins', 'CLAUDE.md', 'settings.json']) { const src = path.join(HOME, '.claude', it), dst = path.join(dir, it); if (fs.existsSync(src) && !fs.existsSync(dst)) try { fs.symlinkSync(src, dst); } catch {} }
          ACCOUNTS.push({ id: 'conta' + n, dir }); salvaContas(); readAccounts(); emitAccounts();
          return out(200, `conta ${n} criada (${dir.replace(HOME, '~')}) — agora entre nela com "Entrar / trocar login"`);
        }
        if (j.action === 'remover') {
          const a = ACCOUNTS.find((x) => x.id === j.id); if (!a) return out(404, 'conta não encontrada'); if (a.id === 'conta1') return out(400, 'a conta 1 é a principal');
          const u = usoDasContas()[a.id] || []; if (u.length) return out(400, `ainda em uso por: ${u.map((x) => x.projeto + ' · ' + x.agente).join(', ')} — troque a conta deles antes`);
          ACCOUNTS.splice(ACCOUNTS.indexOf(a), 1); salvaContas(); emitAccounts(); return out(200, `${a.id} saiu da lista (a pasta ${a.dir.replace(HOME, '~')} não foi apagada)`);
        }
        out(400, 'ação inválida');
      } catch (e) { out(500, e.message); }
    });
    return;
  }
  if (url.pathname === '/predio' && req.method === 'GET') {
    if (!mesmaOrigem(req)) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const rc = ['.zshrc', '.bashrc'].map((x) => path.join(HOME, x)).filter((f) => fs.existsSync(f)).some((f) => fs.readFileSync(f, 'utf8').includes(ATALHOS));
    let conteudo = ''; try { conteudo = fs.readFileSync(ATALHOS, 'utf8'); } catch {}
    return res.end(JSON.stringify({ arquivo: ATALHOS.replace(HOME, '~'), carregado: rc, conteudo, andares: projects.map((q, i) => ({ id: q.id, andar: i + 1, titulo: q.ui.title || q.id, marca: q.ui.brand || '', atalho: q.atalho, pasta: q.root.replace(HOME, '~'), noAr: Object.keys(q.agents).length, servicos: Object.values(q.services).filter((x) => x.live).length, terminal: !!q.floorTerm })) }));
  }
  if (url.pathname === '/predio' && req.method === 'POST') {
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token'); }
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => { const out = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200, out: msg })); }; let j; try { j = JSON.parse(body); } catch { return out(400, 'json'); } try { out(200, await gerenciaPredio(j)); } catch (e) { out(400, e.message); } });
    return;
  }
  if (url.pathname === '/token' && req.method === 'GET') {
    if (!mesmaOrigem(req)) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ token: TOKEN }));
  }
  if (url.pathname === '/andar/info' && req.method === 'GET') {
    if (!mesmaOrigem(req)) { res.writeHead(403); return res.end(); }
    const p = byId[url.searchParams.get('id') || '']; res.writeHead(p ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(p ? infoAndar(p) : { erro: 'andar não encontrado' }));
  }
  if (url.pathname === '/andar/pastas' && req.method === 'GET') {
    // navegador de pastas para o "Adicionar andar" (funciona no navegador e em qualquer versão do app)
    if (!mesmaOrigem(req)) { res.writeHead(403); return res.end(); }
    let dir = path.resolve(exp(String(url.searchParams.get('caminho') || '').trim() || (fs.existsSync(path.join(HOME, 'Desktop', 'Developer')) ? path.join(HOME, 'Desktop', 'Developer') : HOME)));
    if (dir !== HOME && !dir.startsWith(HOME + path.sep)) dir = HOME;
    let itens = []; try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    const pastas = itens.filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.') && !['node_modules', 'Library', 'Applications'].includes(d.name)).map((d) => {
      const f = path.join(dir, d.name); let filhos = []; try { filhos = fs.readdirSync(f); } catch {}
      return { nome: d.name, ehRepo: fs.existsSync(path.join(f, '.git')), temRepos: filhos.some((x) => !x.startsWith('.') && fs.existsSync(path.join(f, x, '.git'))), temAndar: fs.existsSync(path.join(f, '.orquestra')) || fs.existsSync(path.join(path.dirname(f), d.name + '-orquestra', '.orquestra')) };
    }).sort((a, b) => a.nome.localeCompare(b.nome)).slice(0, 400);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ caminho: dir.replace(HOME, '~'), acima: dir === HOME ? null : path.dirname(dir).replace(HOME, '~'), ehRepo: fs.existsSync(path.join(dir, '.git')), pastas }));
  }
  if (url.pathname === '/andar/pasta' && req.method === 'GET') {
    if (!mesmaOrigem(req)) { res.writeHead(403); return res.end(); }
    const c = String(url.searchParams.get('caminho') || '').trim(); if (!c) { res.writeHead(400); return res.end('caminho'); }
    (async () => { const r = await inspecionaPasta(path.resolve(exp(c))); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ...r, atalhos: [...atalhosUsados(), ...projects.map((q) => q.atalho)], ids: projects.map((q) => q.id), modelo: !!MODELO })); })();
    return;
  }
  if (url.pathname === '/andar' && req.method === 'POST') {
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token'); }
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 200000) req.destroy(); });
    req.on('end', async () => {
      const out = (code, msg, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200, out: msg, ...extra })); };
      let j; try { j = JSON.parse(body); } catch { return out(400, 'json'); }
      try {
        const p = await criarAndar(j, (m) => broadcastAll('andar', { msg: m }));
        let extra = ''; if (j.iniciar) { try { extra = '\n\n' + await iniciarBoss(p); } catch (e) { extra = '\n\nNão consegui chamar o Boss agora (' + e.message + ').'; } }
        out(200, `Andar "${p.ui.title}" criado. Atalho no terminal do Herdr: ${p.atalho}${extra}`, { id: p.id });
      } catch (e) { out(400, e.message); }
    });
    return;
  }
  if (url.pathname === '/mensagem' && req.method === 'GET') {
    // texto completo de uma mensagem da equipe: procura na conversa de quem recebeu (e de quem enviou)
    const p = projOf(url); const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const alvo = norm(url.searchParams.get('texto')).slice(0, 80); let achou = '';
    if (p && alvo.length > 10) for (const id of [url.searchParams.get('para'), url.searchParams.get('de')].filter(Boolean)) {
      const it = [...(p.chat[id] || [])].reverse().find((x) => x.kind === 'text' && norm(x.text).includes(alvo)); if (it) { achou = it.text; break; }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ texto: achou }));
  }
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, code: CODE_MTIME, pub: PUB_MTIME, projects: projects.map((p) => p.id), perf })); }
  if (url.pathname === '/accounts') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(accounts())); }
  if (url.pathname === '/rooms') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(rooms())); }
  if (url.pathname === '/agent' && req.method === 'POST') {
    // chamar / reiniciar / dispensar um agente da equipe (o Boss fica no terminal do usuário)
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token'); }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 2000) req.destroy(); });
    req.on('end', async () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('json'); }
      const p = byId[j.project]; if (!p) { res.writeHead(404); return res.end('projeto'); }
      reloadTeam(p);
      const ag = String(j.agent || ''), act = j.action;
      const out = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200, out: msg })); };
      if (act === 'herdr') {
        const alvo = ag === 'andar' ? 'andar' : ag, addr = ag === 'andar' ? (p.floorTerm || await ensureFloorTerm(p).catch(() => null)) : p.agents[ag]?.address;
        if (!addr) return out(404, ag + ' não está no ar');
        const r = await herdrMostrar(p, alvo, addr, rotuloHerdr(p, alvo), true);
        if (r.ok) return out(200, r.out);
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, manual: true, cmd: 'hc attach ' + addr, out: 'cmd' }));
      }
      if (act === 'visto') { (p.visto ||= {})[ag] = Date.now(); if (p.agents[ag]) delete p.agents[ag].pergunta; emit(p); return out(200, 'ok'); }
      if (act === 'ok') { (p.ack ||= {})[ag] = true; if (p.agents[ag]?.status === 'done') { p.agents[ag].status = 'idle'; emit(p); } return out(200, 'ok — de volta a aguardando'); }
      if (ag === 'boss') {
        const b = p.agents.boss;
        if (act === 'interromper') {
          if (!b) return out(200, 'o Boss não está no ar');
          await hcRun(['interrupt', b.address]); await sleep(600); await hcRun(['interrupt', b.address]); await sleep(800); pollHc();
          logEvent(p, { from: 'voce', to: 'boss', kind: 'servico', text: 'Ctrl-C no terminal do andar' });
          return out(200, 'Ctrl-C enviado — a subida parou. Agora é só chamar o Boss de novo.');
        }
        if (act === 'stop' || act === 'restart') {
          if (!b) { if (act === 'stop') return out(200, 'o Boss já está fora do ar'); }
          else if (!/claude|node/.test(b.fg || '')) { // travado na subida (boss.sh) ou num shell: Ctrl-C limpa o que foi digitado e para o script
            await hcRun(['interrupt', b.address]); await sleep(600); await hcRun(['interrupt', b.address]); for (let i = 0; i < 10 && p.agents.boss; i++) { await sleep(500); pollHc(); }
          } else { if (b.status === 'working') await hcRun(['interrupt', b.address]); await sleep(800); await hcRun(['send', b.address, '/exit']); for (let i = 0; i < 20 && p.agents.boss; i++) { await sleep(500); pollHc(); } }
          if (act === 'stop') { logEvent(p, { from: 'voce', to: 'boss', kind: 'servico', text: 'dispensar o Boss' }); return out(200, 'Boss dispensado (o terminal do andar continua aberto)'); }
        }
        try { const m = await iniciarBoss(p); return out(200, m); } catch (e) { return out(500, e.message + `\n\nOu, num terminal do Herdr, rode: ${p.atalho}`); }
      }
      const daEquipe = p.team.includes(ag), extra = /^dev-[\w-]+$/.test(ag) && !!p.agents[ag];
      if (!daEquipe && !extra) return out(404, ag + ' não é da equipe deste projeto');
      const nomeHc = tnHc(p, ag), vivo = !!p.agents[ag];
      if (act === 'stop' || act === 'restart') {
        try { const cur = sessionsOf(p, ag)[0]; if (cur && vivo) saveSession(cur); } catch {}
        if (vivo) { await hcRun(['interrupt', nomeHc]); await new Promise((r) => setTimeout(r, 1200)); await hcRun(['kill', nomeHc]); }
        if (act === 'stop') { logEvent(p, { from: 'voce', to: ag, kind: 'servico', text: 'dispensar ' + ag }); setTimeout(pollHc, 1500); return out(200, ag + ' dispensado'); }
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (act === 'start' || act === 'restart') {
        if (!daEquipe) return out(400, 'dev extra não é reiniciado sozinho — peça ao Boss uma nova tarefa');
        const env = { ...process.env, HC_TERMINAL_ID: p.agents.boss?.address || '' }; // fica como filho do Boss, se ele estiver no ar
        if (!env.HC_TERMINAL_ID) delete env.HC_TERMINAL_ID;
        execFile(path.join(p.orq, 'bin', 'equipe.sh'), ['--so', ag], { env, timeout: 90000, maxBuffer: 2e6 }, (err, o, se) => {
          logEvent(p, { from: 'voce', to: ag, kind: 'servico', text: (act === 'start' ? 'chamar ' : 'reiniciar ') + ag });
          setTimeout(pollHc, 1500);
          const saida = String(o || '') + String(se || ''), falhou = err || /não subiu/.test(saida);
          const motivo = (saida.match(/"message":"([^"]+)"/) || [])[1];
          out(falhou ? 500 : 200, falhou ? `${ag} não subiu${motivo ? ': ' + motivo : ''}\n\n${saida.slice(-600)}` : saida || 'ok');
        });
        return;
      }
      out(400, 'ação inválida');
    });
    return;
  }
  if (url.pathname === '/port' && req.method === 'POST') {
    // parar container / derrubar compose / encerrar processo — só o que está na lista de portas DESTE projeto
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token'); }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 2000) req.destroy(); });
    req.on('end', async () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('json'); }
      const p = byId[j.project]; if (!p) { res.writeHead(404); return res.end('projeto'); }
      const out = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200, out: msg })); };
      let r = null, alvo = '';
      if (j.action === 'container') {
        const x = p.ports.find((q) => q.kind === 'docker' && q.id === j.target); if (!x) return out(404, 'container não é deste projeto');
        alvo = x.name; r = await run('docker', ['stop', x.id], 60000);
      } else if (j.action === 'compose') {
        const xs = p.ports.filter((q) => q.kind === 'docker' && q.compose === j.target); if (!xs.length) return out(404, 'grupo Docker não é deste projeto');
        alvo = 'grupo ' + j.target;
        r = await run('docker', ['compose', '-p', j.target, 'down'], 120000);
        if (!r) r = await run('docker', ['stop', ...new Set(xs.map((q) => q.id))], 60000); // compose sem arquivo: para os containers
      } else if (j.action === 'proc') {
        const x = p.ports.find((q) => q.kind === 'proc' && q.pid === +j.target); if (!x) return out(404, 'processo não é deste projeto');
        alvo = `${x.name} (pid ${x.pid})`; try { process.kill(x.pid, 'SIGTERM'); r = 'ok'; } catch (e) { return out(500, String(e.message)); }
      } else return out(400, 'ação inválida');
      logEvent(p, { from: 'voce', to: null, kind: 'servico', text: 'derrubar ' + alvo });
      setTimeout(scanPorts, 2500);
      out(200, alvo + ' parado');
    });
    return;
  }
  if (url.pathname === '/service' && req.method === 'POST') {
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token'); }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 5000) req.destroy(); });
    req.on('end', async () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('json'); }
      const p = byId[j.project]; if (!p) { res.writeHead(404); return res.end('projeto'); }
      if (!['start', 'stop', 'restart'].includes(j.action)) { res.writeHead(400); return res.end('ação'); }
      const alvo = j.name === '*' ? p.svcDefs.filter((d) => (j.action === 'stop' ? true : !d.manual || j.all)) : p.svcDefs.filter((d) => d.name === j.name);
      if (!alvo.length) { res.writeHead(404); return res.end('serviço não encontrado'); }
      const outs = [];
      for (const d of alvo) {
        if (j.action === 'stop' || j.action === 'restart') outs.push((await svcStop(p, d)).out);
        if (j.action === 'start' || j.action === 'restart') outs.push((await svcStart(p, d)).out);
      }
      logEvent(p, { from: 'voce', to: null, kind: 'servico', text: `${j.action === 'stop' ? 'parar' : j.action === 'start' ? 'subir' : 'reiniciar'} ${j.name === '*' ? 'tudo' : j.name.replace(/^srv-/, '')}` });
      setTimeout(() => { pollHc(); scanPorts(); }, 2500);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, out: outs.join('\n') }));
    });
    return;
  }
  if (url.pathname === '/pendencias' && req.method === 'GET') {
    // sino de notificações: o que cada agente de cada andar espera de você (aprovação/pergunta) e o que terminou
    const itens = [];
    projects.forEach((p, i) => {
      for (const [id, a] of Object.entries(p.agents || {})) {
        const base = { projeto: p.id, andar: i + 1, andarNome: p.ui.title || p.id, cor: p.ui.colors?.[id] || '', agente: id, nome: id === 'boss' ? 'Boss' : p.ui.special?.[id]?.title || id };
        if (a.status === 'blocked') itens.push({ ...base, tipo: 'aprovacao', ts: ((p.desde ||= {})[id + ':blocked:' + a.address] ||= Date.now()) });
        else if (a.pergunta) itens.push({ ...base, tipo: 'pergunta', ts: a.pergunta.ts, trecho: a.pergunta.trecho, opcoes: a.pergunta.opcoes || [], autoriza: !!a.pergunta.autoriza });
        else if (a.status === 'done') itens.push({ ...base, tipo: 'terminou', ts: ((p.desde ||= {})[id + ':done:' + a.address + ':' + a.turn] ||= Date.now()) });
      }
    });
    itens.sort((x, y) => ({ aprovacao: 0, pergunta: 1, terminou: 2 }[x.tipo] - { aprovacao: 0, pergunta: 1, terminou: 2 }[y.tipo]) || y.ts - x.ts);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ itens, andares: projects.map((p, i) => ({ id: p.id, nome: p.ui.title || p.id, andar: i + 1 })) }));
  }
  if (url.pathname === '/pergunta' && req.method === 'GET') {
    const p = projOf(url), a = p?.agents[url.searchParams.get('agent') || ''];
    if (!a) { res.writeHead(404); return res.end('agente não está no ar'); }
    (async () => { const r = lerPergunta(await telaDe(a.address)); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ...r, status: a.status })); })(); return;
  }
  if (url.pathname === '/responder' && req.method === 'POST') {
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token'); }
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      const out = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200, out: msg })); };
      let j; try { j = JSON.parse(body); } catch { return out(400, 'json'); }
      const p = byId[j.project], a = p?.agents[j.agent]; if (!a) return out(404, 'agente não está no ar');
      const q = lerPergunta(await telaDe(a.address)), texto = String(j.texto || '').trim();
      const vai = async (n) => { const i = q.opcoes.findIndex((o) => o.n === n), cur = Math.max(0, q.opcoes.findIndex((o) => o.atual)); if (i < 0) return false; const d = i - cur; const ks = Array(Math.abs(d)).fill(d > 0 ? 'down' : 'up'); if (ks.length) await hcRun(['keys', a.address, ...ks]); return true; };
      if (j.esc) { await hcRun(['keys', a.address, 'esc']); logEvent(p, { from: 'voce', to: j.agent, kind: 'user', text: '(cancelou a pergunta)' }); return out(200, 'cancelado'); }
      if (j.opcao != null && !texto) {
        if (!(await vai(+j.opcao))) return out(409, 'a pergunta mudou — abra de novo');
        await sleep(150); await hcRun(['keys', a.address, 'enter']);
        const o = q.opcoes.find((x) => x.n === +j.opcao); logEvent(p, { from: 'voce', to: j.agent, kind: 'user', text: `resposta: ${o?.texto || j.opcao}` });
        setTimeout(pollHc, 800); return out(200, 'respondido: ' + (o?.texto || j.opcao));
      }
      if (texto) {
        const livre = q.opcoes.find((o) => /type something|digite|outro|other/i.test(o.texto));
        if (livre) { await vai(livre.n); await sleep(150); }
        const r = await hcRun(['send', '--force', a.address, texto]);
        logEvent(p, { from: 'voce', to: j.agent, kind: 'user', text: texto.slice(0, 20000) }); setTimeout(pollHc, 800);
        return out(r.ok ? 200 : 500, r.ok ? 'resposta enviada' : r.out.slice(0, 300));
      }
      out(400, 'escolha uma opção ou escreva a resposta');
    });
    return;
  }
  if (url.pathname === '/send' && req.method === 'POST') {
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token'); }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('json'); }
      const p = byId[j.project] || projects[0];
      const a = p.agents[j.agent];
      const text = String(j.text || '').trim();
      if (!a || !text) { res.writeHead(404); return res.end('agente não está vivo'); }
      if (a.status === 'starting' || /^-?(zsh|bash|sh|fish|dash)$/.test(a.fg || '')) { res.writeHead(409); return res.end(a.status === 'starting' ? 'o ' + j.agent + ' ainda está subindo — espere ele ficar "aguardando" e mande de novo' : 'o ' + j.agent + ' não está rodando (só o terminal está aberto) — use reiniciar no card dele'); }
      if (a.status === 'blocked') { res.writeHead(409, { 'X-Orq': 'bloqueado' }); return res.end('esse agente está esperando você responder uma pergunta/aprovação — responda pelo botão "responder" (senão a mensagem cairia na pergunta)'); }
      // tela de confiança/aprovação do Claude aberta? a mensagem cairia nela (e o Enter poderia escolher uma opção)
      const tela = await new Promise((ok) => execFile(HC, ['read', a.address, '--lines', '30'], { timeout: 5000 }, (e, o2) => ok(String(o2 || ''))));
      if (/one you trust\?|Do you trust the files|Enter to confirm · Esc to cancel/i.test(tela)) { res.writeHead(409); return res.end(`o ${j.agent} está numa tela de confirmação do Claude (ex.: "confiar nesta pasta?") — responda na aba Terminal (ou no Herdr) e mande de novo`); }
      // Claude ainda carregando (sem a caixa de digitar): a mensagem se perderia
      if (/Claude Code v/.test(tela) && !/❯/.test(tela) && a.status !== 'working') { res.writeHead(409); return res.end(`o ${j.agent} ainda está carregando — espere alguns segundos e mande de novo`); }
      execFile(HC, ['send', a.address, text], { timeout: 20000 }, (err, _o, se) => {
        if (err) { res.writeHead(500); return res.end(String(se || err.message).slice(0, 300)); }
        fs.appendFileSync(p.eventsFile, JSON.stringify({ ts: Date.now(), from: 'voce', to: j.agent, kind: 'user', text: text.slice(0, 20000) }) + '\n');
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
      });
    });
    return;
  }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const fp = path.join(DIR, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!fp.startsWith(path.join(DIR, 'public'))) { res.writeHead(403); return res.end(); }
  let st; try { st = fs.statSync(fp); } catch {}
  const lm = st ? new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString() : null;
  if (lm && req.headers['if-modified-since'] === lm) { res.writeHead(304); return res.end(); } // não mudou: o navegador usa a cópia dele
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': /three\.module/.test(fp) ? 'public, max-age=604800' : 'no-cache', ...(lm ? { 'Last-Modified': lm } : {}) });
    res.end(data);
  });
});

for (const p of projects) readEvents(p, true);
scanUsage();
pollHc();
setInterval(pollHc, 1500);
setInterval(() => projects.forEach((p) => readEvents(p)), 400);
setInterval(scanUsage, 1500);
scanPorts(); setInterval(scanPorts, 5000);
readAccounts(); setInterval(readAccounts, 30000);
scanAcctTimes(); setInterval(scanAcctTimes, 60000);
setInterval(emitAccounts, 5000);
setInterval(() => broadcastAll('ping', {}), 15000);
server.on('upgrade', (req, sock) => { const url = new URL(req.url, 'http://x'); if (url.pathname === '/term') openTerm(req, sock, url); else sock.destroy(); });
// porta ocupada (o servidor antigo ainda saindo, numa atualização): tenta de novo por alguns segundos
let tentaPorta = 0;
server.on('error', (e) => { if (e.code === 'EADDRINUSE' && tentaPorta++ < 60) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 250); console.error(e); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => console.log(`Orquestra (${projects.map((p) => p.id).join(', ')}) em http://localhost:${PORT}`));

// ---------- atualização sozinha: código novo do servidor -> ele mesmo se reinicia; tela nova -> avisa quem está com o Orquestra aberto ----------
const PUB_DIR = path.join(DIR, 'public');
const pubMtime = () => { let m = 0; try { for (const f of fs.readdirSync(PUB_DIR)) { if (!/\.(js|html|css)$/.test(f)) continue; m = Math.max(m, fs.statSync(path.join(PUB_DIR, f)).mtimeMs); } } catch {} return Math.floor(m); };
let PUB_MTIME = pubMtime(), reiniciando = false;
function reiniciaSozinho() {
  if (reiniciando) return; reiniciando = true;
  console.log('[orquestra] código do servidor mudou — reiniciando sozinho');
  try { const ch = spawn(process.execPath, process.argv.slice(1), { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); ch.unref(); } catch (e) { console.error('não consegui reiniciar:', e.message); reiniciando = false; return; }
  try { server.close(); } catch {} setTimeout(() => process.exit(0), 400);
}
setInterval(() => {
  let m = 0; try { m = Math.floor(fs.statSync(fileURLToPath(import.meta.url)).mtimeMs); } catch {}
  if (m > CODE_MTIME + 1000) return reiniciaSozinho();
  const pm = pubMtime(); if (pm > PUB_MTIME + 500) { PUB_MTIME = pm; broadcastAll('atualizou', { pub: pm }); }
}, 4000);
