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
const ACCOUNTS = cfg.accounts.map((a) => ({ ...a, dir: exp(a.dir) }));
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
    const argv = [...(t.argv || []), ...(fg.argv || [])].join(' ');
    let conta = null;
    for (const a of ACCOUNTS) if (a.dir !== exp('~/.claude') && argv.includes('CLAUDE_CONFIG_DIR=' + a.dir)) conta = a.id;
    agents[id] = {
      id, address: t.address, status: (t.status && t.status.state) || 'idle', title: t.title || '', turn: t.turn || 0,
      parent: t.parent, conta: conta || p.usage[id]?.conta || null, ctx: (() => { try { const j = JSON.parse(fs.readFileSync(path.join(SB_DIR, t.address + '.json'), 'utf8')); return (j.meters || []).find((m) => m.label === 'ctx')?.percent ?? null; } catch { return null; } })(), model: (() => { try { return JSON.parse(fs.readFileSync(path.join(SB_DIR, t.address + '.json'), 'utf8')).model || null; } catch { return null; } })(),
    };
    byAddr[t.address] = id;
  }
  p.agents = agents; p.services = services; p.byAddr = byAddr; p.hcOk = true; p.floorTerm = floorTerm;
  emit(p);
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
  for (const a of ACCOUNTS) {
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
function accounts() {
  const now = Date.now();
  return ACCOUNTS.map((a) => {
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
    return { id: a.id, ...(acctInfo[a.id] || {}), users, h5: meters['5h'] ?? null, d7: meters['7d'] ?? null, metersAt: at || null, reset5, reset7, tokToday, costToday };
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
const hcRun = (args, timeout = 20000) => new Promise((ok) => execFile(HC, args, { timeout }, (err, o, se) => ok({ ok: !err, out: String(o || se || (err && err.message) || '') })));
const sh = (cmd, cwd, timeout = 120000) => new Promise((ok) => execFile('/bin/zsh', ['-lc', cmd], { cwd, timeout, maxBuffer: 4e6 }, (err, o, se) => ok({ ok: !err, out: String(o || '') + String(se || '') })));
async function svcStart(p, d) {
  if (p.services[d.short]?.live) return { ok: true, out: d.name + ' já está rodando' };
  const r = await hcRun(['run', '--bg', '--no-notify', '--no-parent', '--label', 'orq.projeto=' + p.id, '--name', p.id + '-' + d.name, '--cwd', path.join(p.root, d.pasta), '--', '/bin/zsh', '-lc', d.cmd]);
  return { ok: r.ok, out: r.ok ? d.name + ' subindo' : r.out };
}
async function svcStop(p, d) {
  const outs = [];
  if (d.stop) { const r = await sh(d.stop, path.join(p.root, d.pasta)); outs.push((r.ok ? '' : 'falha ao parar: ') + r.out.slice(-300)); }
  if (p.services[d.short]?.live) { await hcRun(['interrupt', p.id + '-' + d.name]); await new Promise((r) => setTimeout(r, 1500)); await hcRun(['kill', p.id + '-' + d.name]); }
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
  const p = byId[url.searchParams.get('p')]; if (!p) { sock.destroy(); return; }
  const qual = url.searchParams.get('w') === 'boss' ? 'boss' : 'andar';
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
    try { addr = qual === 'boss' ? p.agents.boss?.address : await ensureFloorTerm(p); } catch (e) { wsSend(sock, '\r\n\x1b[31m' + e.message + '\x1b[0m\r\n'); }
    if (!addr) { if (qual === 'boss') wsSend(sock, '\r\n\x1b[33mO Boss deste andar não está no ar. Use "Iniciar Boss" ou abra o terminal do andar.\x1b[0m\r\n'); return; }
    if (fechado) return;
    ch = spawn('python3', ['-c', PTY_PY, String(cols), String(rows), HC, 'attach', addr], { cwd: p.root, env: { ...process.env, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
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
function contaDir(p, n) { const env = projEnv(p); const d = n === '1' ? env.CONTA1_DIR : n === '2' ? (env.CONTA2_DIR || path.join(HOME, '.claude-conta2')) : ''; return d ? exp(d) : path.join(HOME, '.claude'); }
function agenteInfo(p, id) {
  if (id === 'boss') { const c = projEnv(p).BOSS_CONTA || '1'; return { id, cwd: path.join(p.orq, 'boss'), conta: c, cfg: contaDir(p, c), settings: path.join(p.orq, 'boss', '.claude', 'settings.json'), addDirs: [p.root], instr: path.join(p.orq, 'boss', 'CLAUDE.md'), tipo: 'boss' }; }
  const e = readEquipe(p).find((x) => x.nome === id); if (!e) return null;
  const cwd = path.join(p.root, e.pasta), dev = id.startsWith('dev-');
  let args = ''; try { args = fs.readFileSync(path.join(cwd, 'agente.args'), 'utf8'); } catch {}
  const st = fs.existsSync(path.join(cwd, 'agente-settings.json')) ? path.join(cwd, 'agente-settings.json') : path.join(p.orq, 'dev-settings.json');
  return { id, cwd, conta: e.conta, modelo: e.modelo, cfg: contaDir(p, e.conta), settings: st, addDirs: args.includes('{PROJ}') ? [p.root] : [], tipo: dev ? 'dev' : 'especialista',
    repo: dev ? id.slice(4) : null, instr: dev ? path.join(p.orq, 'agentes', id + '.md') : path.join(cwd, 'CLAUDE.md') };
}
const escopoDir = (p, id, esc) => path.join(p.orq, 'skills', esc === 'equipe' ? '_equipe' : id);
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
  const bl = bloqueio(a.settings), F = [];
  const add = (tipo, rotulo, dir, extra = {}) => { const sk = skillsEm(dir); F.push({ tipo, rotulo, pasta: dir, editavel: !!extra.editavel, skills: sk.map((x) => ({ ...x, bloqueada: bl(x.nome) })), ...extra }); };
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
  const acc = ACCOUNTS.find((x) => x.dir === a.cfg); const nomeConta = acc ? acc.id : 'conta ' + a.conta;
  add('conta', `Da conta ${nomeConta} (todos que usam esta conta, em qualquer projeto)`, path.join(a.cfg, 'skills'));
  add('conta', 'Sincronizadas do claude.ai', path.join(a.cfg, 'skills', 'synced'));
  const pl = pluginSkills(a.cfg); if (pl.length) F.push({ tipo: 'plugin', rotulo: 'De plugins instalados nesta conta', pasta: path.join(a.cfg, 'plugins'), editavel: false, skills: pl.map((x) => ({ ...x, bloqueada: bl(x.plugin + ':' + x.nome) || bl(x.nome) })) });
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
  const conta = j.conta === '1' ? '1' : '2', modelo = ['sonnet', 'opus', 'haiku'].includes(j.modelo) ? j.modelo : 'sonnet';
  const equipe = readEquipe(p), texto = String(j.instrucoes || '').trim();
  let nome, pasta;
  if (tipo === 'dev') {
    const repo = String(j.repo || ''); if (!/^[\w.-]+$/.test(repo) || !fs.existsSync(path.join(p.root, repo, '.git'))) throw new Error('repositório inválido');
    nome = 'dev-' + repo; pasta = '.worktrees/' + nome;
  } else {
    nome = String(j.nome || '').toLowerCase(); if (!SLUG.test(nome) || RESERVADOS.has(nome) || nome.startsWith('dev-') || nome.startsWith('srv-')) throw new Error('nome inválido: use letras minúsculas, números e hífen (ex.: seguranca, docs-api)');
    if ((p.id + '-' + nome).length > 32) throw new Error('nome longo demais');
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
    for (const d of fs.readdirSync(p.root)) if (fs.existsSync(path.join(p.root, d, '.git'))) for (const t of ['Edit', 'Write', 'NotebookEdit']) deny.push(`${t}(//${path.join(p.root, d).replace(/^\//, '')}/**)`);
    for (const t of ['Edit', 'Write']) deny.push(`${t}(//${path.join(p.root, '.worktrees').replace(/^\//, '')}/**)`);
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
  if (fs.existsSync(path.join(dir, '.git'))) r.ehRepo = true; // a própria pasta é um repo: precisa de uma pasta acima
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
  (cd "$SRV_DIR" && ORQ_CONFIG="$CFG" nohup node server.mjs > "$(dirname "$CFG")/data/server.log" 2>&1 &)
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
  const abs = '//' + raiz.replace(/^\//, ''); for (const t of ['Read', 'Edit', 'Write', 'Glob', 'Grep']) deny.push(`${t}(${abs}/**)`);
  deny.push(`Bash(*${path.relative(HOME, raiz)}*)`); d.permissions.deny = [...new Set(deny)]; fs.writeFileSync(arquivo, JSON.stringify(d, null, 2));
}
async function criarAndar(j, progresso) {
  if (!MODELO) throw new Error('não achei os modelos de andar (pasta modelo/) junto do servidor');
  const titulo = String(j.titulo || '').trim().slice(0, 40); if (!titulo) throw new Error('dê um nome ao andar');
  const id = String(j.id || '').toLowerCase(); if (!/^[a-z][a-z0-9-]{1,11}$/.test(id)) throw new Error('identificador: 2 a 12 letras minúsculas/números/hífen, começando por letra');
  if (byId[id]) throw new Error('já existe um andar com o id ' + id);
  const atalho = String(j.atalho || id); if (!/^[a-z][a-z0-9_-]{1,19}$/.test(atalho)) throw new Error('atalho inválido (letras minúsculas, números, - e _)');
  if (atalhosUsados().has(atalho) || projects.some((q) => q.atalho === atalho)) throw new Error(`o atalho "${atalho}" já é de outro andar`);
  if (await temCli(atalho)) throw new Error(`"${atalho}" já é um comando do sistema — escolha outro atalho`);
  const root = path.resolve(exp(String(j.pasta || '').trim())); if (!j.pasta || root === HOME || root === '/') throw new Error('escolha a pasta do projeto');
  if (fs.existsSync(path.join(root, '.git'))) throw new Error('essa pasta é um repositório — escolha (ou crie) a pasta ACIMA dela, que contém o(s) repo(s)');
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
  const contaEq = j.contaEquipe === '1' ? '1' : '2', contaBoss = j.contaBoss === '2' ? '2' : '1';
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
  fs.writeFileSync(path.join(orq, 'servicos.conf'), ['# Serviços do projeto (terminais srv-* no Herdr). Subir/parar também pelo Orquestra.', '# nome   pasta   comando   [#parar: comando]   [#manual = não sobe sozinho]',
    ...info.repos.map((r) => fs.existsSync(path.join(root, r.nome, 'package.json')) ? `# srv-${r.nome}   ${r.nome}   npm run dev   #manual` : (fs.existsSync(path.join(root, r.nome, 'docker-compose.yml')) || fs.existsSync(path.join(root, r.nome, 'compose.yaml'))) ? `# srv-${r.nome}   ${r.nome}   docker compose up   #parar: docker compose down   #manual` : `# srv-${r.nome}   ${r.nome}   <comando>   #manual`)].join('\n') + '\n');
  // config do andar
  const cores = ['#e8875a', '#5aa9ff', '#b98cff', '#4fd1c5', '#f2c14e', '#ff9ecd', '#8bd450', '#c4a484', '#a0a8b8'];
  const special = {}; if (j.qa) special.qa = { title: 'QA', sub: 'valida no navegador (Playwright)', color: '#e9ff70', decor: 'qa' };
  if (plat) special[plat] = { title: plat === 'github' ? 'GitHub' : 'GitLab', sub: plat === 'github' ? 'PRs e checks' : 'MRs e pipelines', color: '#ff6b35', decor: 'gitlab' };
  fs.writeFileSync(path.join(orq, 'estudio', 'config.json'), JSON.stringify({ project_id: id, atalho, ui: { title: titulo, brand: titulo.length <= 14 ? titulo : titulo.split(' ')[0], subtitle: 'ORQUESTRA DE AGENTES', repos: repos.map((r) => r.nome), labels: {}, colors: Object.fromEntries(repos.map((r, i) => [r.nome, cores[i % cores.length]])), special, about: String(j.sobre || '').trim() || `${titulo}: ${repos.map((r) => r.nome).join(', ')}` }, sessoes: { boss: 'nova', equipe: 'nova', memoria: true } }, null, 2) + '\n');
  // placeholders dos modelos
  const sub = { __TITULO__: titulo, __BASE__: base, __ORQ__: orq, __MAPA__: info.repos.map((r) => `| \`${r.nome}\` | (descreva) | (comandos) |`).join('\n'), __EQUIPE__: repos.map((r) => `| \`dev-${r.nome}\` | dev residente de \`${r.nome}\`; mesa = \`../../.worktrees/dev-${r.nome}\` |`).join('\n') };
  const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, x.name); if (x.isDirectory()) { if (!['relatorios', 'data'].includes(x.name)) walk(f); } else if (/\.(md|json)$/.test(x.name)) { let t = fs.readFileSync(f, 'utf8'), n = t; for (const [k, v] of Object.entries(sub)) n = n.split(k).join(v); if (n !== t) fs.writeFileSync(f, n); } } };
  walk(orq);
  // Boss e protocolo conforme a equipe escolhida
  const bf = path.join(orq, 'boss', 'CLAUDE.md'); let bt = fs.readFileSync(bf, 'utf8');
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
        const nomeHc = p.id + '-' + id;
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
    return res.end(JSON.stringify({ repos, agente: a ? { id, tipo: a.tipo, conta: a.conta, modelo: a.modelo || '', arquivo: a.instr.replace(HOME, '~'), instrucoes: instr } : null }));
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
        const esc = j.escopo === 'equipe' ? 'equipe' : 'agente', raiz = escopoDir(p, id, esc), ativas = path.join(raiz, '.claude', 'skills'), desat = path.join(raiz, 'skills-desativadas');
        const nome = String(j.nome || '').toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(nome)) return out(400, 'nome da skill: letras minúsculas, números e hífen');
        fs.mkdirSync(ativas, { recursive: true });
        if (j.action === 'salvar') {
          fs.mkdirSync(path.join(ativas, nome), { recursive: true }); fs.writeFileSync(path.join(ativas, nome, 'SKILL.md'), corpoSkill(nome, j.descricao, j.conteudo));
          return out(200, `skill ${nome} salva (${esc === 'equipe' ? 'para a equipe toda' : 'só para ' + id}) — já vale nas próximas mensagens`);
        }
        if (j.action === 'copiar') {
          const de = String(j.de || ''); if (!dentroDeFonte(p, id, de)) return out(403, 'origem fora das skills deste agente');
          if (fs.existsSync(path.join(ativas, nome))) return out(409, 'já existe uma skill ' + nome + ' aí');
          fs.cpSync(path.dirname(de), path.join(ativas, nome), { recursive: true, dereference: true }); return out(200, `skill ${nome} copiada`);
        }
        if (j.action === 'desativar' || j.action === 'ativar') {
          const [a, b] = j.action === 'desativar' ? [ativas, desat] : [desat, ativas];
          if (!fs.existsSync(path.join(a, nome))) return out(404, 'skill não encontrada'); fs.mkdirSync(b, { recursive: true });
          if (fs.existsSync(path.join(b, nome))) return out(409, 'já existe ' + nome + ' do outro lado');
          fs.renameSync(path.join(a, nome), path.join(b, nome)); return out(200, `skill ${nome} ${j.action === 'desativar' ? 'desativada' : 'ativada'}`);
        }
        if (j.action === 'remover') {
          const src = [path.join(ativas, nome), path.join(desat, nome)].find((x) => fs.existsSync(x)); if (!src) return out(404, 'skill não encontrada');
          const lx = path.join(p.orq, 'skills', '.lixeira'); fs.mkdirSync(lx, { recursive: true }); fs.renameSync(src, path.join(lx, `${id}-${nome}-${Date.now()}`));
          return out(200, `skill ${nome} removida (guardada em .orquestra/skills/.lixeira)`);
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
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, code: CODE_MTIME, projects: projects.map((p) => p.id), perf })); }
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
      if (ag === 'boss') {
        const b = p.agents.boss;
        if (act === 'stop' || act === 'restart') {
          if (!b) { if (act === 'stop') return out(200, 'o Boss já está fora do ar'); }
          else { if (b.status === 'working') await hcRun(['interrupt', b.address]); await sleep(800); await hcRun(['send', b.address, '/exit']); for (let i = 0; i < 20 && p.agents.boss; i++) { await sleep(500); pollHc(); } }
          if (act === 'stop') { logEvent(p, { from: 'voce', to: 'boss', kind: 'servico', text: 'dispensar o Boss' }); return out(200, 'Boss dispensado (o terminal do andar continua aberto)'); }
        }
        try { const m = await iniciarBoss(p); return out(200, m); } catch (e) { return out(500, e.message + `\n\nOu, num terminal do Herdr, rode: ${p.atalho}`); }
      }
      const daEquipe = p.team.includes(ag), extra = /^dev-[\w-]+$/.test(ag) && !!p.agents[ag];
      if (!daEquipe && !extra) return out(404, ag + ' não é da equipe deste projeto');
      const nomeHc = p.id + '-' + ag, vivo = !!p.agents[ag];
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
          out(err ? 500 : 200, String(o || '') + String(se || '') || (err && err.message) || 'ok');
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
  if (url.pathname === '/send' && req.method === 'POST') {
    if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token'); }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('json'); }
      const p = byId[j.project] || projects[0];
      const a = p.agents[j.agent];
      const text = String(j.text || '').trim();
      if (!a || !text) { res.writeHead(404); return res.end('agente não está vivo'); }
      if (a.status === 'blocked') { res.writeHead(409); return res.end('esse agente está esperando uma aprovação no Herdr — responda lá primeiro (senão a mensagem cairia na pergunta)'); }
      execFile(HC, ['send', a.address, text], { timeout: 20000 }, (err, _o, se) => {
        if (err) { res.writeHead(500); return res.end(String(se || err.message).slice(0, 300)); }
        fs.appendFileSync(p.eventsFile, JSON.stringify({ ts: Date.now(), from: 'voce', to: j.agent, kind: 'user', text: text.slice(0, 220) }) + '\n');
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
server.listen(PORT, '127.0.0.1', () => console.log(`Orquestra (${projects.map((p) => p.id).join(', ')}) em http://localhost:${PORT}`));
