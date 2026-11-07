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
const projects = cfg.projects.map((p) => {
  const orq = exp(p.orq);
  let ui = {};
  try { ui = JSON.parse(fs.readFileSync(path.join(orq, 'estudio', 'config.json'), 'utf8')).ui || {}; } catch {}
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
    id: p.id, orq, root: path.dirname(orq), ui: { ...ui, ...(p.ui || {}) }, team: ['boss', ...team], servicesConf, svcDefs, ports: [],
    eventsFile: path.join(data, 'events.jsonl'), evOffset: 0,
    special: new Set(Object.keys(ui.special || {})),
    hcOk: false, agents: {}, services: {}, usage: {}, chat: {}, interactions: [], rework: {}, byAddr: {},
    clients: new Set(), last: '',
  };
});
const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
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
const pub = (p) => ({ team: p.team, hcOk: p.hcOk, svcDefs: p.svcDefs.map(({ name, short, pasta, cmd, stop, manual }) => ({ name, short, pasta, cmd, stop: !!stop, manual })), ports: p.ports, services: p.services, agents: p.agents, usage: p.usage, rework: p.rework });
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
  const agents = {}, services = {}, byAddr = {};
  for (const t of snap.terminals || []) {
    const fg = t.foreground || {};
    const cwd = fg.cwd || t.cwd;
    if (!inside(cwd, p.root) && !inside(t.cwd, p.root)) continue; // só o que é desta sala
    const nm = t.name && t.name.startsWith(p.id + '-') ? t.name.slice(p.id.length + 1) : t.name; // nomes no Herdr: <projeto>-<agente>
    if (nm && nm.startsWith('srv-')) { services[nm.slice(4)] = { live: t.state === 'live', address: t.address }; continue; }
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
  p.agents = agents; p.services = services; p.byAddr = byAddr; p.hcOk = true;
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

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const projOf = (url) => byId[url.searchParams.get('p')] || projects[0];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/stream') {
    const p = projOf(url);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    send(res, 'init', { ...pub(p), project: p.id, token: TOKEN, rooms: rooms(), accounts: accounts(), interactions: p.interactions.slice(-60) });
    p.clients.add(res);
    req.on('close', () => p.clients.delete(res));
    return;
  }
  if (url.pathname === '/config') {
    const p = projOf(url);
    try { const ui = JSON.parse(fs.readFileSync(path.join(p.orq, 'estudio', 'config.json'), 'utf8')).ui || {}; p.ui = { ...ui }; p.special = new Set(Object.keys(ui.special || {})); } catch {} // sempre a configuração atual
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...p.ui, project: p.id }));
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
      const ag = String(j.agent || ''), act = j.action;
      const out = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200, out: msg })); };
      if (ag === 'boss') return out(400, 'O Boss roda no seu terminal do Herdr: para chamar, abra um terminal no espaço do projeto e rode o atalho (contas / fp); para dispensar, /exit nele.');
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
server.listen(PORT, '127.0.0.1', () => console.log(`Orquestra (${projects.map((p) => p.id).join(', ')}) em http://localhost:${PORT}`));
