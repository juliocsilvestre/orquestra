#!/usr/bin/env node
// Demonstração do Orquestra sem Herdr nem Claude: dois projetos fictícios, agentes simulados e um roteiro
// que se repete (pedido → delegação → QA reprova → correção → QA aprova → revisão → PR).
//   node demo/demo.mjs            → abre em http://localhost:4790
//   PORT=4791 node demo/demo.mjs  → outra porta
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const H = path.join(os.tmpdir(), 'orquestra-demo');
const PORT = Number(process.env.PORT || 4790);
fs.rmSync(H, { recursive: true, force: true });
const W = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof c === 'string' ? c : JSON.stringify(c, null, 2)); };

// ---------- projetos ----------
const PROJ = {
  loja: {
    root: path.join(H, 'Projetos/loja-online'), title: 'Loja Online', brand: 'Loja', repos: ['api', 'web', 'mobile', 'pagamentos'],
    colors: { api: '#e8875a', web: '#5aa9ff', mobile: '#b98cff', pagamentos: '#4fd1c5' },
    special: {
      issues: { title: 'Issues', sub: 'cards, critérios e comentários', color: '#06d6a0', decor: 'kanban' },
      monitor: { title: 'Monitor', sub: 'logs, métricas e alertas', color: '#ef476f', decor: 'screen' },
      qa: { title: 'QA', sub: 'valida no navegador (Playwright)', color: '#e9ff70', decor: 'qa' },
      github: { title: 'GitHub', sub: 'PRs e checks', color: '#ff6b35', decor: 'gitlab' },
    },
    about: 'E-commerce de exemplo: API, site, app e serviço de pagamentos.',
    services: [['srv-api', 'api', 'npm run dev'], ['srv-web', 'web', 'npm run dev']],
  },
  app: {
    root: path.join(H, 'Projetos/app-financas'), title: 'App Finanças', brand: 'Finanças', repos: ['backend', 'app'],
    colors: { backend: '#f2c14e', app: '#ff9ecd' },
    special: {
      qa: { title: 'QA', sub: 'valida no navegador (Playwright)', color: '#e9ff70', decor: 'qa' },
      github: { title: 'GitHub', sub: 'PRs e checks', color: '#ff6b35', decor: 'gitlab' },
    },
    about: 'App de finanças pessoais de exemplo: backend e app.',
    services: [['srv-backend', 'backend', 'npm start']],
  },
};
const orqOf = (id) => path.join(PROJ[id].root, '.orquestra');
const cwdOf = (id, ag) => (ag.startsWith('dev-') ? path.join(PROJ[id].root, '.worktrees', ag) : path.join(orqOf(id), ag));

W(path.join(H, 'config.json'), {
  port: PORT,
  projects: Object.keys(PROJ).map((id) => ({ id, orq: orqOf(id) })),
  accounts: [{ id: 'conta1', dir: path.join(H, '.claude') }, { id: 'conta2', dir: path.join(H, '.claude-conta2') }],
  prices: { opus: { input: 5, output: 25 }, sonnet: { input: 3, output: 15 }, haiku: { input: 1, output: 5 }, default: { input: 3, output: 15 } },
  cacheWriteMult: 1.25, cacheReadMult: 0.1,
});
W(path.join(H, '.claude.json'), { oauthAccount: { emailAddress: 'voce@exemplo.com', displayName: 'Você' } });
W(path.join(H, '.claude-conta2/.claude.json'), { oauthAccount: { emailAddress: 'equipe@exemplo.com', displayName: 'Equipe' } });

const team = {};
for (const [id, p] of Object.entries(PROJ)) {
  const orq = orqOf(id);
  team[id] = ['boss', ...Object.keys(p.special), ...p.repos.map((r) => 'dev-' + r)];
  W(path.join(orq, 'estudio/config.json'), { project_id: id, ui: { title: p.title, subtitle: 'ORQUESTRA DE AGENTES', brand: p.brand, repos: p.repos, labels: {}, colors: p.colors, special: p.special, about: p.about } });
  W(path.join(orq, 'equipe.conf'), team[id].filter((a) => a !== 'boss').map((a) => `${a} x 2 sonnet`).join('\n') + '\n');
  W(path.join(orq, 'servicos.conf'), p.services.map(([n, d, c]) => `${n} ${d} ${c}`).join('\n') + '\n');
  for (const a of team[id]) fs.mkdirSync(cwdOf(id, a), { recursive: true });
  for (const r of p.repos) fs.mkdirSync(path.join(p.root, r), { recursive: true });
  W(path.join(orq, 'relatorios/boss/memoria.md'), `# Memória do Boss — ${p.title}\n\n- Sprint atual: checkout com cupom e melhorias de desempenho\n- Padrão: todo PR passa pelo QA antes da revisão\n- Próximo passo: aguardar pedidos\n`);
  W(path.join(orq, 'estudio/data/events.jsonl'), '');
}

// ---------- "Herdr" falso: terminais e telas ----------
const STATE = path.join(H, 'hc-state.json');
const term = {}; let n = 10;
const status = {}; const svcAddr = {}; let sv = 900;
for (const [id, p] of Object.entries(PROJ)) for (const [n2] of p.services) svcAddr[id + '/' + n2] = 't' + sv++;
for (const [id, p] of Object.entries(PROJ)) for (const a of team[id]) { term[id + '/' + a] = 't' + n++; status[id + '/' + a] = 'idle'; }
function writeState() {
  const terminals = [];
  for (const [id, p] of Object.entries(PROJ)) {
    for (const a of team[id]) {
      const addr = term[id + '/' + a];
      terminals.push({ address: addr, name: a === 'boss' ? undefined : `${id}-${a}`, argv: a === 'boss' ? ['/bin/zsh'] : ['env', 'CLAUDE_CONFIG_DIR=' + path.join(H, '.claude-conta2'), 'claude'], cwd: cwdOf(id, a), foreground: { argv: ['claude'], cwd: cwdOf(id, a) }, state: 'live', status: { state: status[id + '/' + a] }, title: '', turn: 1 });
    }
    for (const [n2, d] of p.services) terminals.push({ address: svcAddr[id + '/' + n2], name: `${id}-${n2}`, cwd: path.join(p.root, d), state: 'live', status: { state: 'working' } });
  }
  fs.writeFileSync(STATE + '.tmp', JSON.stringify({ terminals })); fs.renameSync(STATE + '.tmp', STATE);
}
writeState();
const HC = path.join(H, 'bin/hc');
W(HC, `#!/usr/bin/env node
const fs = require('fs');
const [cmd] = process.argv.slice(2);
if (cmd === 'events') { process.stdout.write(fs.readFileSync(${JSON.stringify(STATE)}, 'utf8') + '\\n'); setTimeout(() => {}, 30000); }
else if (cmd === 'read') { process.stdout.write('╭─────────────────────────────────────────╮\\n│ > TAREFA cupom: validar cupom no checkout │\\n╰─────────────────────────────────────────╯\\n⏺ Lendo src/checkout/cupom.ts\\n⏺ Edit(src/checkout/cupom.ts)\\n  ⎿  +18 −3\\n⏺ Bash(npm test -- cupom)\\n  ⎿  12 passed\\n'); }
else process.exit(0);
`);
fs.chmodSync(HC, 0o755);
// barra de uso (5h / semana) das contas
const SB = path.join(H, '.local/state/herdr-session-bar');
for (const [k, addr] of Object.entries(term)) W(path.join(SB, addr + '.json'), { model: k.endsWith('/boss') ? 'claude-opus' : 'claude-sonnet', meters: [{ label: 'ctx', percent: 8 + (addr.charCodeAt(2) % 30) }, { label: '5h', percent: k.endsWith('/boss') ? 41 : 27 }, { label: '7d', percent: k.endsWith('/boss') ? 18 : 12 }], at: Date.now() });

// ---------- conversa e uso (transcripts no formato do Claude Code) ----------
const slug = (c) => c.replace(/[^a-zA-Z0-9]/g, '-');
let msgN = 0;
function say(proj, ag, role, text, tool) {
  const cwd = cwdOf(proj, ag), conta = ag === 'boss' ? '.claude' : '.claude-conta2';
  const f = path.join(H, conta, 'projects', slug(cwd), 'demo-' + proj + '-' + ag + '.jsonl');
  const ts = new Date().toISOString();
  const content = role === 'user' ? text : [{ type: 'text', text }, ...(tool ? [{ type: 'tool_use', name: tool[0], input: tool[1] }] : [])];
  const l = { type: role === 'user' ? 'user' : 'assistant', cwd, timestamp: ts, requestId: 'r' + ++msgN, message: { id: 'm' + msgN, role: role === 'user' ? 'user' : 'assistant', model: ag === 'boss' ? 'claude-opus' : 'claude-sonnet', content, ...(role === 'user' ? {} : { usage: { input_tokens: 900 + Math.round(Math.random() * 3000), output_tokens: 300 + Math.round(Math.random() * 900), cache_read_input_tokens: 20000 + Math.round(Math.random() * 30000), cache_creation_input_tokens: 2000 } }) } };
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(l) + '\n');
}
const ev = (proj, e) => fs.appendFileSync(path.join(orqOf(proj), 'estudio/data/events.jsonl'), JSON.stringify({ ts: Date.now(), ...e }) + '\n');
const st = (proj, ag, s) => { status[proj + '/' + ag] = s; writeState(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// histórico de manhã (para custos e sessões já aparecerem)
for (const [id, p] of Object.entries(PROJ)) for (const a of team[id]) { say(id, a, 'user', 'Bom dia! Revise o que ficou pendente ontem.'); say(id, a, 'agent', 'Tudo em dia por aqui — nenhum pendente.'); }

// ---------- servidor ----------
const srv = spawn(process.execPath, [path.join(REPO, 'server/server.mjs')], { env: { ...process.env, HOME: H, HC_BIN: HC, ORQ_CONFIG: path.join(H, 'config.json'), PORT: String(PORT) }, stdio: ['ignore', 'inherit', 'inherit'] });
process.on('SIGINT', () => { srv.kill(); process.exit(0); }); process.on('SIGTERM', () => { srv.kill(); process.exit(0); });
console.log(`\n  Orquestra (demonstração) → http://localhost:${PORT}\n  Ctrl+C para sair.\n`);

// ---------- roteiro ----------
async function roteiro() {
  const L = 'loja';
  await sleep(Number(process.env.DEMO_ESPERA || 6000));
  for (;;) {
    ev(L, { from: 'voce', to: 'boss', kind: 'user', text: 'Adicionar cupom de desconto no checkout (site e API)' });
    say(L, 'boss', 'user', 'Adicionar cupom de desconto no checkout (site e API)'); st(L, 'boss', 'working'); await sleep(2500);
    say(L, 'boss', 'agent', 'Vou dividir: **API** valida o cupom e **Web** mostra o campo no checkout. Depois o QA testa no navegador.', ['Bash', { command: 'tarefa.sh api cupom "validar cupom"' }]);
    ev(L, { from: 'boss', to: 'dev-api', kind: 'delegate', text: 'cupom: endpoint POST /cupons/validar com testes' }); st(L, 'dev-api', 'working'); await sleep(1800);
    ev(L, { from: 'boss', to: 'dev-web', kind: 'delegate', text: 'cupom: campo de cupom no checkout + desconto no total' }); st(L, 'dev-web', 'working'); st(L, 'boss', 'idle'); await sleep(1500);
    ev(L, { from: 'boss', to: 'issues', kind: 'ask', text: 'criar card LOJA-128 "Cupom no checkout" com os critérios' }); st(L, 'issues', 'working'); await sleep(2500);
    say(L, 'issues', 'agent', 'Card **LOJA-128** criado com 4 critérios de aceite.'); ev(L, { from: 'issues', to: 'boss', kind: 'report', text: 'card LOJA-128 criado com 4 critérios' }); st(L, 'issues', 'idle');
    say(L, 'dev-api', 'agent', 'Criando o endpoint e os testes.', ['Edit', { file_path: 'src/cupons/validar.ts' }]); await sleep(3500);
    say(L, 'dev-api', 'agent', 'Pronto: `POST /cupons/validar` com 12 testes passando.', ['Bash', { command: 'npm test -- cupons' }]);
    ev(L, { from: 'dev-api', to: 'qa', kind: 'report', text: 'VALIDAR api cupom — endpoint pronto, 12 testes passando' }); st(L, 'dev-api', 'idle'); st(L, 'qa', 'working'); await sleep(3000);
    ev(L, { from: 'monitor', to: 'boss', kind: 'report', text: 'ALERTA: latência da API de pagamentos subiu para 900 ms (normal: 200 ms)' }); st(L, 'monitor', 'working'); await sleep(2500); st(L, 'monitor', 'idle');
    say(L, 'dev-web', 'agent', 'Campo de cupom no checkout, com o desconto no total.', ['Edit', { file_path: 'src/pages/checkout.tsx' }]);
    ev(L, { from: 'dev-web', to: 'qa', kind: 'report', text: 'VALIDAR web cupom — campo no checkout pronto' }); st(L, 'dev-web', 'idle'); await sleep(3000);
    say(L, 'qa', 'agent', 'Testei no navegador: com cupom expirado o total fica negativo. **Reprovado** para a Web.', ['mcp__playwright__browser_click', {}]);
    ev(L, { from: 'qa', to: 'dev-web', kind: 'qafail', text: 'QA REPROVADO: cupom expirado deixa o total negativo' }); st(L, 'dev-web', 'working'); await sleep(4000);
    say(L, 'dev-web', 'agent', 'Corrigido: cupom expirado mostra aviso e não aplica desconto.', ['Edit', { file_path: 'src/pages/checkout.tsx' }]);
    ev(L, { from: 'dev-web', to: 'qa', kind: 'report', text: 'VALIDAR web cupom — corrigido o cupom expirado' }); st(L, 'dev-web', 'idle'); await sleep(3500);
    say(L, 'qa', 'agent', 'Tudo certo: 6 cenários no navegador, API e Web. **Aprovado**.');
    ev(L, { from: 'qa', to: 'boss', kind: 'qaok', text: 'QA APROVADO: cupom ok — 6 cenários (Playwright)' }); st(L, 'qa', 'idle'); st(L, 'boss', 'working'); await sleep(2500);
    ev(L, { from: 'boss', to: 'dev-api', kind: 'review', text: 'revisando o diff' }); await sleep(2500);
    ev(L, { from: 'boss', to: 'dev-web', kind: 'review', text: 'revisando o diff' }); await sleep(2500);
    say(L, 'boss', 'agent', 'Revisei os dois diffs: está bom. **Posso abrir o PR?**'); st(L, 'boss', 'blocked'); await sleep(4000);
    ev(L, { from: 'voce', to: 'boss', kind: 'user', text: 'pode abrir' }); st(L, 'boss', 'working');
    ev(L, { from: 'boss', to: 'dev-api', kind: 'approve', text: 'aprovado' }); ev(L, { from: 'boss', to: 'dev-web', kind: 'approve', text: 'aprovado' }); await sleep(1500);
    ev(L, { from: 'boss', to: 'github', kind: 'ask', text: 'abrir PR do cupom (api + web)' }); st(L, 'github', 'working'); await sleep(3000);
    say(L, 'github', 'agent', 'PR **#42** aberto, checks verdes.'); ev(L, { from: 'github', to: 'boss', kind: 'report', text: 'PIPELINE ok — PR #42 aberto, checks verdes' }); st(L, 'github', 'idle'); st(L, 'boss', 'idle');
    // o outro andar também trabalha
    ev('app', { from: 'voce', to: 'boss', kind: 'user', text: 'Gráfico de gastos por categoria no app' }); st('app', 'boss', 'working'); await sleep(1500);
    ev('app', { from: 'boss', to: 'dev-app', kind: 'delegate', text: 'gráfico de gastos por categoria' }); st('app', 'dev-app', 'working'); st('app', 'boss', 'idle');
    await sleep(15000); st('app', 'dev-app', 'idle');
  }
}
roteiro();
