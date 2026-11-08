import * as THREE from './three.module.min.js';

// ---------------- dados ----------------
window.__esperaInit = true; window.bootStep?.('lendo a configuração da sala…');
let PROJECT = new URLSearchParams(location.search).get('p') || '';
const UI = await fetch('/config?p=' + encodeURIComponent(PROJECT)).then((r) => r.json()).catch(() => ({}));
PROJECT = UI.project || PROJECT;
window.bootStep?.('montando o escritório…');
let ROOMS = [];
const REPO_ORDER = UI.repos || [];
const REPOS = [...REPO_ORDER].sort((x, y) => y.length - x.length); // prefixo mais longo primeiro
const toHex = (c) => (typeof c === 'string' ? parseInt(c.replace('#', ''), 16) : c);
const REPO_COLOR = Object.fromEntries(Object.entries(UI.colors || {}).map(([k, v]) => [k, toHex(v)]));
const SPECIAL = Object.fromEntries(Object.entries(UI.special || {}).map(([k, v]) => [k, { ...v, color: toHex(v.color) }]));
const LABEL = (repo) => (UI.labels || {})[repo] || repo;
document.title = 'Orquestra · ' + (UI.brand || UI.title || '');
document.querySelector('header h1').innerHTML = 'Orquestra <span>' + (UI.brand || UI.title || '') + '</span>';
const KIND = {
  delegate: { label: 'nova tarefa', css: 'var(--delegate)' },
  send: { label: 'ajuste do Boss', css: 'var(--send)' },
  report: { label: 'relatório', css: 'var(--report)' },
  review: { label: 'revisando', css: 'var(--review)' },
  inspect: { label: 'verificando', css: 'var(--inspect)' },
  ask: { label: 'pedido do Boss', css: 'var(--send)' },
  user: { label: 'você', css: 'var(--accent)' },
  approve: { label: 'aprovado', css: 'var(--done)' },
  qaok: { label: 'QA aprovou', css: 'var(--done)' },
  qafail: { label: 'QA reprovou', css: 'var(--blocked)' },
  servico: { label: 'servidores', css: 'var(--accent)' },
  alert: { label: 'alerta', css: 'var(--blocked)' },
  pipeok: { label: 'pipeline passou', css: 'var(--done)' },
  pipefail: { label: 'pipeline falhou', css: 'var(--blocked)' },
  ronda: { label: 'ronda', css: 'var(--inspect)' },
  fala: { label: 'diz', css: 'var(--accent)' },
  think: { label: '', css: '#8a7f75' },
  wait: { label: 'acompanhando', css: 'var(--inspect)' },
};
const STATUS_TXT = { starting: 'subindo…', working: 'trabalhando', blocked: 'precisa de você', done: 'terminou', idle: 'aguardando', unknown: '—' };

function parseId(id) {
  if (id === 'boss') return { repo: null, slug: null, title: 'Boss' };
  if (id === 'voce') return { repo: null, slug: null, title: 'Você' };
  if (SPECIAL[id]) return { repo: null, slug: null, title: SPECIAL[id].title, special: true };
  const rest = id.replace(/^dev-/, '');
  const repo = REPOS.find((r) => rest === r || rest.startsWith(r + '-')) || rest.split('-')[0];
  const slug = rest.slice(repo.length + 1);
  return { repo, slug, title: LABEL(repo) };
}
function colorFor(id) {
  if (id === 'boss') return 0xf2b544;
  if (SPECIAL[id]) return SPECIAL[id].color;
  const { repo } = parseId(id);
  if (REPO_COLOR[repo] != null) return REPO_COLOR[repo];
  let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.6, 0.6).getHex();
}
const hex = (n) => '#' + n.toString(16).padStart(6, '0');
const fmtUsd = (v) => 'US$ ' + (v || 0).toFixed(2).replace('.', ',');
const fmtTok = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1).replace('.', ',') + ' mi' : v >= 1e3 ? Math.round(v / 1e3) + ' mil' : String(v || 0));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------- janela de confirmação / aviso do Estúdio (em vez do confirm/alert do navegador) ----------------
function modal({ title, text, ok = 'Confirmar', cancel = 'Cancelar', danger = false, info = false }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'mbg';
    bg.innerHTML = `<div class="mdl ${danger ? 'danger' : ''}" role="dialog" aria-modal="true"><h4>${esc(title || '')}</h4><p>${esc(text || '').replace(/\n/g, '<br>')}</p>
      <div class="mact">${info ? '' : `<button class="mc">${esc(cancel)}</button>`}<button class="mo">${esc(info ? 'Entendi' : ok)}</button></div></div>`;
    const fim = (v) => { bg.classList.add('out'); setTimeout(() => bg.remove(), 150); document.removeEventListener('keydown', kd); resolve(v); };
    const kd = (e) => { if (e.key === 'Escape') fim(false); if (e.key === 'Enter') fim(true); };
    bg.addEventListener('click', (e) => { if (e.target === bg || e.target.classList.contains('mc')) fim(false); if (e.target.classList.contains('mo')) fim(true); });
    document.addEventListener('keydown', kd);
    document.body.appendChild(bg); setTimeout(() => bg.querySelector('.mo').focus(), 20);
  });
}
const confirma = (title, text, danger = true, ok = 'Confirmar') => modal({ title, text, danger, ok });
const avisa = (title, text) => modal({ title, text, info: true });

let S = { hcOk: false, agents: {}, usage: {}, rework: {} };
let ACCTS = [];
// grupos recolhíveis (lembra por navegador)
const fold = (() => { try { return JSON.parse(localStorage.getItem('estudio.fold') || '{}'); } catch { return {}; } })();
const isFolded = (k, def = false) => (k in fold ? fold[k] : def);
function toggleFold(k, def) { fold[k] = !isFolded(k, def); try { localStorage.setItem('estudio.fold', JSON.stringify(fold)); } catch {} renderAll(); }
const groupHead = (k, title, info, def = false) => `<div class="gh" data-fold="${k}" data-def="${def ? 1 : 0}"><span class="tw">${isFolded(k, def) ? '▸' : '▾'}</span><b>${title}</b>${info ? `<span class="gi">${info}</span>` : ''}</div>`;
document.addEventListener('click', (e) => { const h = e.target.closest('[data-fold]'); if (h) toggleFold(h.dataset.fold, h.dataset.def === '1'); });
// texto curto: caminhos viram o nome do arquivo
const tidy = (t) => String(t || '').replace(/(?:\/Users\/[^\s]+|\.\.?\/[^\s]*|\$R)\/?([\w.-]+\.md)/g, '📄$1').replace(/\/Users\/[^\s]+\/([\w.-]+)/g, '…/$1').replace(/\s+/g, ' ').trim();
const clip = (t, n) => { t = tidy(t); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
let feed = [];

// ---------------- cena ----------------
const host = document.getElementById('office');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
host.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14110f);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
let az = Math.PI / 4, zoom = 0.95;
function placeCamera() {
  const r = 40;
  camera.position.set(2 + Math.sin(az) * r, 30, 1 + Math.cos(az) * r);
  camera.lookAt(2, 0, 1);
}
function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return; // sala escondida (Painel aberto): não redimensiona para 0
  renderer.setSize(w, h);
  const half = 18.5 / zoom, aspect = w / h;
  camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half;
  camera.updateProjectionMatrix();
}
placeCamera();
addEventListener('resize', resize);

scene.add(new THREE.HemisphereLight(0xfff1e0, 0x3a2a1e, 1.05));
const sun = new THREE.DirectionalLight(0xffe2c4, 1.6);
sun.position.set(10, 22, 14);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22 });
scene.add(sun);

const mat = (c, extra = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, ...extra });
function box(w, h, d, color, x = 0, y = 0, z = 0, parent = scene, m) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m || mat(color));
  mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true;
  parent.add(mesh); return mesh;
}

// sala
const W = 44, D = 32; // sala grande: coluna de especialistas à esquerda, devs com corredor largo
function canvasTex(w, h, draw, rep) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; if (rep) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...rep); } t.anisotropy = 4; return t; }
// piso de tábuas
const woodTex = canvasTex(512, 512, (g, w, h) => {
  const tones = ['#6b4a33', '#74513a', '#5f4230', '#7a563d', '#694833'];
  for (let y = 0; y < h; y += 32) { let x = -((y / 32) % 4) * 64; while (x < w) { const len = 128 + (Math.abs(x * 7 + y) % 3) * 64; g.fillStyle = tones[Math.abs((x + y * 3) / 32 | 0) % tones.length]; g.fillRect(x, y, len - 2, 30); x += len; } }
  g.globalAlpha = 0.08; for (let i = 0; i < 400; i++) { g.fillStyle = i % 2 ? '#000' : '#fff'; g.fillRect(Math.random() * w, Math.random() * h, 40, 1); }
}, [4, 3]);
const floor = box(W, 0.4, D, 0, 0, -0.2, 0, scene, new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.85 })); floor.castShadow = false;
// paredes mais claras + rodapé
const wallMat = mat(0x4a3f37, { roughness: 0.95 });
box(W, 7, 0.4, 0, 0, 3.5, -D / 2, scene, wallMat);
box(0.4, 7, D, 0, -W / 2, 3.5, 0, scene, wallMat);
box(W, 0.35, 0.1, 0x2b2420, 0, 0.18, -D / 2 + 0.25); box(0.1, 0.35, D, 0x2b2420, -W / 2 + 0.25, 0.18, 0);
// janelas (parede esquerda) — sem nada por cima
const winMat = mat(0xbfd6ef, { emissive: 0x89a8cc, emissiveIntensity: 0.55 });
for (const z of []) { // parede esquerda livre para os quadros dos especialistas (janela vai para o fundo)
  const g = new THREE.Group(); g.position.set(-W / 2 + 0.22, 0, z); scene.add(g);
  box(0.12, 2.8, 3.2, 0x2b2420, 0, 4, 0, g); box(0.1, 2.5, 2.9, 0, 0.05, 4, 0, g, winMat);
  box(0.12, 2.5, 0.08, 0x2b2420, 0.08, 4, 0, g); box(0.12, 0.08, 2.9, 0x2b2420, 0.08, 4, 0, g);
  box(0.5, 0.1, 3.3, 0x8a7a6a, 0.2, 2.55, 0, g); // peitoril
}
// janela no fundo (entre a estante e o elevador)
{
  const g = new THREE.Group(); g.position.set(W / 2 - 7.2, 0, -D / 2 + 0.22); scene.add(g);
  box(3.4, 2.8, 0.12, 0x2b2420, 0, 4, 0, g); box(3.1, 2.5, 0.1, 0, 0, 4, 0.05, g, winMat);
  box(0.08, 2.5, 0.12, 0x2b2420, 0, 4, 0.08, g); box(3.1, 0.08, 0.12, 0x2b2420, 0, 4, 0.08, g); box(3.5, 0.1, 0.5, 0x8a7a6a, 0, 2.55, 0.2, g);
}
// tapetes
box(11, 0.04, 7.5, 0x7a3b2e, 5, 0.02, -10.2, scene, mat(0x7a3b2e, { roughness: 1 })).castShadow = false; // área do Boss
box(10.6, 0.05, 7.2, 0xc9a26b, 5, 0.03, -10.2, scene, mat(0xc9a26b, { roughness: 1 })).castShadow = false;
box(30, 0.04, 18, 0x34404a, 6.2, 0.02, 6, scene, mat(0x34404a, { roughness: 1 })).castShadow = false; // área dos devs
// luzes quentes da sala
scene.add(new THREE.AmbientLight(0xffe7c8, 0.35));
// letreiro
{
  const tex = canvasTex(1024, 256, (g) => {
    g.fillStyle = '#141110'; g.fillRect(0, 0, 1024, 256); g.fillStyle = '#e8875a'; g.fillRect(0, 236, 1024, 20);
    g.fillStyle = '#f3ece4'; g.textAlign = 'center'; g.font = `bold ${(UI.title || '').length > 14 ? 84 : 116}px -apple-system, Inter, sans-serif`; g.fillText(UI.title || 'Projeto', 512, 140);
    g.fillStyle = '#e8875a'; g.font = '600 40px -apple-system, Inter, sans-serif'; g.fillText(UI.subtitle || 'ORQUESTRA DE AGENTES', 512, 205);
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.25), new THREE.MeshBasicMaterial({ map: tex }));
  sign.position.set(5, 4.9, -D / 2 + 0.22); scene.add(sign);
}
// estante atrás do Boss
{
  const g = new THREE.Group(); g.position.set(13.5, 0, -D / 2 + 0.75); scene.add(g);
  box(3.6, 3.4, 0.9, 0x5a3a26, 0, 1.7, 0, g);
  const cores = [0xe8875a, 0x5aa9ff, 0xf2c14e, 0x4fd18b, 0xb98cff, 0xef476f, 0xf3ece4];
  for (let r = 0; r < 3; r++) { box(3.3, 0.08, 0.8, 0x3a2618, 0, 0.5 + r * 1.05, 0.05, g); for (let i = 0; i < 9; i++) { const hgt = 0.6 + ((i * 7 + r * 3) % 4) * 0.08; box(0.28, hgt, 0.55, cores[(i + r * 2) % cores.length], -1.45 + i * 0.36, 0.55 + r * 1.05 + hgt / 2, 0.1, g); } }
}
// decoração
function plant(x, z, s = 1) { box(0.9 * s, 0.9 * s, 0.9 * s, 0xd46a3a, x, 0.45 * s, z); const c = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75 * s, 0), mat(0x3f8f4f, { flatShading: true })); c.position.set(x, 1.45 * s, z); c.castShadow = true; scene.add(c); const c2 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5 * s, 0), mat(0x4fa55d, { flatShading: true })); c2.position.set(x + 0.2, 2.05 * s, z - 0.1); scene.add(c2); }
plant(-W / 2 + 1.4, -D / 2 + 1.4, 1.2); plant(W / 2 - 1.6, -D / 2 + 1.4, 1.2); plant(W / 2 - 1.6, 5); plant(-W / 2 + 1.4, D / 2 - 1.4);
box(1, 1.8, 1, 0xdfe6ea, W / 2 - 1.6, 0.9, -2); box(0.7, 0.9, 0.7, 0x7fb2e5, W / 2 - 1.6, 2.25, -2, scene, mat(0x7fb2e5, { transparent: true, opacity: 0.85 })); // bebedouro
// cantinho do Taiga: quadro kanban na parede do fundo, ao lado da mesa
if (Object.values(SPECIAL).some((x) => x.decor === 'kanban')) {
  const g = new THREE.Group(); g.position.set(-16.6, 0, -D / 2 + 0.3); scene.add(g);
  box(4.4, 2.8, 0.12, 0xf3ece4, 0, 4, 0, g); box(4.6, 0.12, 0.3, 0x8a7a6a, 0, 2.55, 0.1, g);
  const cols = [0x5aa9ff, 0xf2c14e, 0x4fd18b];
  for (let c = 0; c < 3; c++) { box(0.04, 2.4, 0.03, 0xc9bfb3, -0.73 + c * 1.46 - 0.73 + 0.73, 4, 0.08, g); for (let r = 0; r < 3 - (c === 2 ? 1 : 0); r++) box(0.95, 0.5, 0.04, cols[c], -1.46 + c * 1.46, 4.9 - r * 0.68, 0.09, g); }
}
// cantinho dos Logs: parede de monitores
if (Object.values(SPECIAL).some((x) => x.decor === 'screen')) {
  const g = new THREE.Group(); g.position.set(-7.5, 0, -D / 2 + 0.3); scene.add(g);
  for (const [x, y] of [[-1.15, 3.6], [1.15, 3.6], [-1.15, 4.95], [1.15, 4.95]]) box(2.2, 1.25, 0.12, 0x0d0f12, x, y, 0, g, mat(0x0d0f12, { emissive: 0x0f1a2a, emissiveIntensity: 1 }));
  const hs = [0.3, 0.6, 0.4, 0.9, 0.35, 1.0, 0.55, 0.75];
  hs.forEach((h, i) => box(0.18, h * 0.9, 0.04, 0, -2 + i * 0.24, 3.05 + h * 0.45, 0.09, g, mat(i === 5 ? 0xef476f : 0x3d7dff, { emissive: i === 5 ? 0xef476f : 0x3d7dff, emissiveIntensity: 0.9 })));
  for (let i = 0; i < 6; i++) box(1.7 - (i % 3) * 0.4, 0.06, 0.04, 0, 1.1 - (i % 3) * 0.2, 4.6 + i * 0.13, 0.09, g, mat(0x4fd18b, { emissive: 0x4fd18b, emissiveIntensity: 0.6 }));
  box(0.9, 0.9, 0.04, 0, -1.15, 4.95, 0.09, g, mat(0xf2c14e, { emissive: 0xf2c14e, emissiveIntensity: 0.25 }));
}
// relógio
const clockFace = new THREE.Mesh(new THREE.CircleGeometry(0.9, 32), mat(0xf3ece4));
clockFace.position.set(-2.3, 5.4, -D / 2 + 0.22); scene.add(clockFace);
const hand = box(0.08, 0.7, 0.05, 0x111111, 0, 0.3, 0.02, clockFace);
const hand2 = box(0.06, 0.5, 0.05, 0x111111, 0, 0.22, 0.03, clockFace);

// mesas: Boss no fundo, devs em 2 fileiras
const BOSS_DESK = new THREE.Vector3(5, 0, -9.8);
const SLOTS = [];
for (const z of [0, 6, 12]) for (const x of [-5, 2.5, 10, 17.5]) SLOTS.push(new THREE.Vector3(x, 0, z));
// especialistas: cada um com lugar próprio (Taiga e Logs no fundo; QA, GitLab/GitHub e o 5º na coluna da esquerda)
// especialistas: lugar FIXO por nome (nunca dois na mesma mesa); quem não está na lista pega um lugar livre
const SPOT = { taiga: new THREE.Vector3(-16.5, 0, -10.2), logs: new THREE.Vector3(-7.5, 0, -10.2), qa: new THREE.Vector3(-16.5, 0, -2.2), gitlab: new THREE.Vector3(-16.5, 0, 5.2), github: new THREE.Vector3(-16.5, 0, 5.2), revisor: new THREE.Vector3(14.5, 0, -9.8) };
const SPARE = [new THREE.Vector3(-16.5, 0, 12.2), new THREE.Vector3(-7.5, 0, -3.5), new THREE.Vector3(14.5, 0, -9.8), new THREE.Vector3(-10.5, 0, 12.2), new THREE.Vector3(-10.5, 0, 5.2), new THREE.Vector3(-7.5, 0, 3.5)];
const SPECIAL_DESK = {};
{ const usados = new Set(); const k = (v) => v.x + ',' + v.z;
  const BY_DECOR = { kanban: SPOT.taiga, screen: SPOT.logs, qa: SPOT.qa, gitlab: SPOT.gitlab, revisor: SPOT.revisor };
  for (const id of Object.keys(SPECIAL)) { let p = SPOT[id] || BY_DECOR[SPECIAL[id].decor]; if (!p || usados.has(k(p))) p = SPARE.find((x) => !usados.has(k(x))) || SPARE[0]; usados.add(k(p)); SPECIAL_DESK[id] = p; } }
const SPECIAL_POS = Object.values(SPECIAL_DESK);
const DOOR = new THREE.Vector3(W / 2 - 2.6, 0, -D / 2 + 2.2); // em frente ao elevador (é por ele que os agentes entram e saem)
// cantinho do QA: tela grande com checklist verde/vermelho + mesa de testes
if (SPECIAL.qa) {
  const p = SPECIAL_DESK.qa;
  const g = new THREE.Group(); g.position.set(p.x - 2.3, 0, p.z - 0.2); scene.add(g);
  box(0.12, 1.8, 1.9, 0x111111, 0, 2.6, 0, g, mat(0x0d0f12, { emissive: 0x0f1a2a, emissiveIntensity: 1 })); box(0.15, 1.7, 0.1, 0x333333, 0, 0.85, 0, g);
  [0x4fd18b, 0x4fd18b, 0xff4d4d, 0x4fd18b].forEach((c, i) => { box(0.04, 0.16, 0.16, 0, 0.08, 3.2 - i * 0.38, -0.6, g, mat(c, { emissive: c, emissiveIntensity: 0.9 })); box(0.04, 0.08, 1.0, 0, 0.08, 3.2 - i * 0.38, 0.05, g, mat(0x9fb3c8, { emissive: 0x9fb3c8, emissiveIntensity: 0.4 })); });
}
// cantinho do GitLab: painel de pipeline (estágios em fila)
if (SPECIAL.gitlab || SPECIAL.github) {
  SPECIAL_DESK.gitlab = SPECIAL_DESK.gitlab || SPECIAL_DESK.github;
  const p = SPECIAL_DESK.gitlab;
  const g = new THREE.Group(); g.position.set(p.x - 2.3, 0, p.z - 0.2); scene.add(g);
  box(0.12, 1.4, 2.2, 0x111111, 0, 2.7, 0, g, mat(0x0d0f12, { emissive: 0x1a120d, emissiveIntensity: 1 })); box(0.15, 2.0, 0.1, 0x333333, 0, 1.0, 0, g);
  [0x4fd18b, 0x4fd18b, 0x5aa9ff, 0x8a7f75].forEach((c, i) => { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 16), mat(c, { emissive: c, emissiveIntensity: 0.9 })); b.rotation.z = Math.PI / 2; b.position.set(0.09, 2.85, -0.75 + i * 0.5); g.add(b); if (i < 3) box(0.03, 0.04, 0.3, 0, 0.08, 2.85, -0.5 + i * 0.5, g, mat(0x8a7f75)); });
}

// mural "sobre este andar": uma folha limpa presa com fita na parede do fundo; clicando, abre as informações do andar
const quadroInfo = new THREE.Group(); quadroInfo.position.set(-12, 0, -D / 2 + 0.2); scene.add(quadroInfo);
let infoAndar = null;
function desenhaPapel() {
  for (const n of ['papel', 'sombra', 'fita']) { const o = quadroInfo.getObjectByName(n); if (o) quadroInfo.remove(o); }
  const I = infoAndar || {}, cor = UI.colors ? '#e8875a' : '#e8875a';
  const quebra = (g, txt, x, y, larg, lh, max) => { const ws = String(txt || '').replace(/\s+/g, ' ').trim().split(' '); let l = '', n = 0; for (const w of ws) { const tt = l ? l + ' ' + w : w; if (g.measureText(tt).width > larg && l) { if (n === max - 1) { while (g.measureText(l + '…').width > larg && l.length) l = l.slice(0, -1); g.fillText(l + '…', x, y + n * lh); return n + 1; } g.fillText(l, x, y + n * lh); l = w; n++; } else l = tt; } if (l && n < max) { g.fillText(l, x, y + n * lh); n++; } return n; };
  const FONT = '-apple-system, "SF Pro Display", Inter, "Helvetica Neue", sans-serif';
  const tex = canvasTex(900, 1150, (g, w, h) => {
    g.fillStyle = '#fbf8f3'; g.fillRect(0, 0, w, h);
    const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(1, 'rgba(120,100,80,0.06)'); g.fillStyle = grad; g.fillRect(0, 0, w, h);
    const X = 84; let y = 150;
    try { g.letterSpacing = '6px'; } catch {}
    g.fillStyle = cor; g.beginPath(); g.arc(X + 9, y - 11, 9, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#9a8c80'; g.font = `600 26px ${FONT}`; g.fillText('SOBRE ESTE ANDAR', X + 32, y);
    try { g.letterSpacing = '0px'; } catch {}
    y += 92; g.fillStyle = '#1f1a17'; g.font = `700 76px ${FONT}`; y += (quebra(g, I.titulo || UI.title || 'Projeto', X, y, w - 2 * X, 84, 2) - 1) * 84;
    y += 40; g.fillStyle = cor; g.fillRect(X, y, 72, 7);
    y += 78; g.fillStyle = '#5b5047'; g.font = `400 36px ${FONT}`;
    const nd = quebra(g, curta(I.descricao) || (I.titulo ? 'Sem descrição ainda.' : 'carregando…'), X, y, w - 2 * X, 52, 5); y += nd * 52 + 40;
    if ((I.repos || []).length) {
      try { g.letterSpacing = '5px'; } catch {} g.fillStyle = '#a3968a'; g.font = `600 22px ${FONT}`; g.fillText('REPOSITÓRIOS', X, y); try { g.letterSpacing = '0px'; } catch {}
      y += 26; let x = X; g.font = `500 28px ${FONT}`;
      for (const r of I.repos.slice(0, 4)) { const tw = g.measureText(r.nome).width, bw = Math.min(tw + 44, w - 2 * X); if (x + bw > w - X) { x = X; y += 64; } g.fillStyle = '#efe8df'; g.beginPath(); g.roundRect(x, y, bw, 50, 25); g.fill(); g.fillStyle = '#3c332d'; g.save(); g.beginPath(); g.rect(x, y, bw - 18, 50); g.clip(); g.fillText(r.nome, x + 22, y + 35); g.restore(); x += bw + 12; }
    }
    g.fillStyle = '#e7dfd5'; g.fillRect(X, h - 150, w - 2 * X, 2);
    g.fillStyle = cor; g.font = `600 30px ${FONT}`; g.fillText('Ver tudo  →', X, h - 88);
  });
  const W2 = 2.3, H2 = 2.94;
  const sombra = new THREE.Mesh(new THREE.PlaneGeometry(W2 + 0.12, H2 + 0.12), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }));
  sombra.name = 'sombra'; sombra.position.set(0.06, 4.0, 0.01); sombra.rotation.z = -0.02; quadroInfo.add(sombra);
  const papel = new THREE.Mesh(new THREE.PlaneGeometry(W2, H2), new THREE.MeshBasicMaterial({ map: tex }));
  papel.name = 'papel'; papel.position.set(0, 4.08, 0.04); papel.rotation.z = -0.02; quadroInfo.add(papel);
  const fita = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.26), new THREE.MeshBasicMaterial({ color: 0xe9dcc2, transparent: true, opacity: 0.85 }));
  fita.name = 'fita'; fita.position.set(0.05, 4.08 + H2 / 2 - 0.02, 0.06); fita.rotation.z = 0.06; quadroInfo.add(fita);
}
desenhaPapel();
fetch('/andar/info?id=' + encodeURIComponent(PROJECT), { cache: 'no-store' }).then((r) => r.json()).then((I) => { if (!I.erro) { infoAndar = I; desenhaPapel(); } }).catch(() => {});
// Markdown simples e bonito para o "sobre o projeto": títulos, listas, parágrafos, negrito, código e links
function mdDoc(src) {
  const inl = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>').replace(/(https?:\/\/[^\s)<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const out = []; let lista = null, par = [];
  const fechaPar = () => { if (par.length) { out.push(`<p>${inl(par.join(' '))}</p>`); par = []; } };
  const fechaLista = () => { if (lista) { out.push(`<${lista.t}>${lista.i.map((x) => `<li>${inl(x)}</li>`).join('')}</${lista.t}>`); lista = null; } };
  for (const raw of String(src || '').replace(/\r/g, '').split('\n')) {
    const l = raw.trim(); let m;
    if (!l) { fechaPar(); fechaLista(); continue; }
    if ((m = l.match(/^#{1,4}\s+(.*)/))) { fechaPar(); fechaLista(); out.push(`<h5>${inl(m[1])}</h5>`); continue; }
    if ((m = l.match(/^[-*•]\s+(.*)/)) || (m = l.match(/^\d+[.)]\s+(.*)/))) { fechaPar(); const tg = /^\d/.test(l) ? 'ol' : 'ul'; if (!lista || lista.t !== tg) { fechaLista(); lista = { t: tg, i: [] }; } lista.i.push(m[1]); continue; }
    if ((m = l.match(/^([^:]{2,40}):\s*$/))) { fechaPar(); fechaLista(); out.push(`<h5>${inl(m[1])}</h5>`); continue; }
    if ((m = l.match(/^([A-ZÀ-Ú][\wÀ-ú ./()-]{1,28}):\s+(.+)$/))) { fechaPar(); fechaLista(); out.push(`<p class="kv"><b>${inl(m[1])}</b>${inl(m[2])}</p>`); continue; }
    fechaLista(); par.push(l);
  }
  fechaPar(); fechaLista(); return out.join('');
}
function curta(s) { s = String(s || '').replace(/\s+/g, ' ').trim(); if (s.length <= 160) return s; const m = s.match(/^(.{40,160}?[.!?])\s/); return m ? m[1] : s.slice(0, 157) + '…'; }
function mostrarInfoAndar() {
  const I = infoAndar || {}, bg = document.createElement('div'); bg.className = 'mbg';
  const andarN = (ROOMS || []).findIndex((r) => r.id === PROJECT) + 1;
  const ini = (I.titulo || UI.title || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  bg.innerHTML = `<div class="mdl wide infoA" role="dialog" aria-modal="true">
    <div class="iaH"><div class="iaIc">${esc(ini)}</div><div class="iaT"><div class="iaK">${andarN ? andarN + 'º ANDAR' : 'ANDAR'} · SOBRE O PROJETO</div><h3>${esc(I.titulo || UI.title || '')}</h3>${I.descricao ? `<p class="iaD" title="${esc(I.descricao)}">${esc(curta(I.descricao))}</p>` : ''}</div><button class="iaX mc" title="Fechar">✕</button></div>
    <div class="iaMeta"><span class="iaChip" title="${esc(I.pasta || '')}">📁 <code>${esc(I.pasta || '')}</code></span>${(I.repos || []).map((r) => `<span class="iaChip"><i class="iaDot ${r.dev ? 'on' : ''}"></i>${esc(r.nome)}${r.dev ? '<small>dev</small>' : ''}</span>`).join('')}</div>
    <div class="iaBody">${I.sobre ? mdDoc(I.sobre) : '<div class="iaVazio">Ainda não há uma descrição do projeto.<br><small>Ela é o que o Boss sabe sobre o projeto — vale preencher.</small></div>'}</div>
    <div class="iaF"><span>É isso que o Boss sabe do projeto.</span><button class="sb" data-x="editar">Editar</button><button class="sb pri mc">Fechar</button></div></div>`;
  const fim = () => { bg.classList.add('out'); setTimeout(() => bg.remove(), 150); };
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('.mc')) return fim(); if (e.target.dataset.x === 'editar') { fim(); import('./andar.js').then((m) => m.abrirInfoAndar(PROJECT)); } });
  document.body.appendChild(bg);
}
// cantinho do Revisor: quadro com o grafo de branches (o que outros devs subiram)
if (Object.values(SPECIAL).some((x) => x.decor === 'revisor')) {
  const id = Object.keys(SPECIAL).find((k) => SPECIAL[k].decor === 'revisor'), p = SPECIAL_DESK[id];
  const g = new THREE.Group(); g.position.set(p.x + 2.4, 0, p.z - 0.2); scene.add(g);
  box(0.12, 1.6, 2.2, 0x111111, 0, 2.8, 0, g, mat(0x0d0f12, { emissive: 0x0d1a22, emissiveIntensity: 1 })); box(0.15, 2.0, 0.1, 0x333333, 0, 1.0, 0, g);
  const linha = (z0, z1, y, c) => box(0.04, 0.05, Math.abs(z1 - z0), 0, -0.08, y, (z0 + z1) / 2, g, mat(c, { emissive: c, emissiveIntensity: 0.8 }));
  linha(-0.85, 0.85, 3.2, 0x5aa9ff); linha(-0.3, 0.6, 2.6, 0xf2c14e); box(0.04, 0.6, 0.05, 0, -0.08, 2.9, -0.3, g, mat(0xf2c14e, { emissive: 0xf2c14e, emissiveIntensity: 0.8 }));
  for (const [z, y, c] of [[-0.7, 3.2, 0x5aa9ff], [-0.3, 3.2, 0x5aa9ff], [0.2, 3.2, 0x5aa9ff], [0.7, 3.2, 0x4fd18b], [0, 2.6, 0xf2c14e], [0.45, 2.6, 0xf2c14e]]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.05, 16), mat(c, { emissive: c, emissiveIntensity: 0.9 })); b.rotation.z = Math.PI / 2; b.position.set(-0.09, y, z); g.add(b);
  }
}

let deskN = 0;
function makeDesk(pos, big = false) {
  const g = new THREE.Group(); g.position.copy(pos); scene.add(g);
  const w = big ? 4.4 : 3.1, n = deskN++;
  box(w, 0.18, 1.7, 0xa0714d, 0, 1.38, 0, g); // tampo
  box(w - 0.2, 0.9, 0.08, 0x6b4a33, 0, 0.85, 0.75, g); // painel frontal
  for (const sx of [-1, 1]) box(0.12, 1.3, 1.5, 0x6b4a33, sx * (w / 2 - 0.12), 0.65, 0, g); // laterais
  box(0.5, 0.06, 0.35, 0x222222, 0, 1.5, 0.2, g); box(0.12, 0.45, 0.12, 0x222222, 0, 1.72, 0.25, g); // base do monitor
  const screenMat = mat(0x222831, { emissive: 0x334455, emissiveIntensity: 0.4 });
  box(big ? 2.3 : 1.8, 1.1, 0.1, 0x111111, 0, 2.45, 0.28, g);
  const scr = box(big ? 2.1 : 1.6, 0.92, 0.02, 0, 0, 2.45, 0.22, g, screenMat);
  if (big) { box(1.5, 0.9, 0.1, 0x111111, -1.55, 2.3, 0.1, g).rotation.y = 0.35; } // 2º monitor do Boss
  box(1.2, 0.05, 0.38, 0x2c2c2c, 0, 1.5, -0.35, g); box(0.22, 0.05, 0.3, 0x2c2c2c, 0.85, 1.5, -0.35, g); // teclado + mouse
  // cadeira
  box(1.2, 0.18, 1.1, 0x2d2d33, 0, 0.95, -1.45, g); box(1.2, 1.1, 0.16, 0x2d2d33, 0, 1.6, -2.0, g); box(0.12, 0.85, 0.12, 0x444444, 0, 0.45, -1.45, g); box(0.9, 0.06, 0.9, 0x444444, 0, 0.05, -1.45, g);
  // detalhe de cada mesa
  const k = big ? 0 : n % 4;
  if (k === 0) { box(0.3, 0.38, 0.3, 0xf3ece4, w / 2 - 0.45, 1.66, -0.25, g); } // caneca
  if (k === 1) { box(0.4, 0.35, 0.4, 0xd46a3a, -w / 2 + 0.45, 1.65, -0.3, g); const c = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 0), mat(0x4fa55d, { flatShading: true })); c.position.set(-w / 2 + 0.45, 2.05, -0.3); g.add(c); } // plantinha
  if (k === 2) { box(0.7, 0.12, 0.5, 0xf2c14e, -w / 2 + 0.55, 1.53, -0.25, g); box(0.7, 0.1, 0.5, 0x5aa9ff, -w / 2 + 0.55, 1.64, -0.25, g); } // livros
  if (k === 3) { box(0.1, 0.8, 0.1, 0x333333, w / 2 - 0.4, 1.85, 0.3, g); box(0.4, 0.15, 0.3, 0xf2c14e, w / 2 - 0.55, 2.25, 0.2, g, mat(0xf2c14e, { emissive: 0xf2c14e, emissiveIntensity: 0.6 })); } // luminária
  return { group: g, screenMat, scr };
}
const bossDesk = makeDesk(BOSS_DESK, true);
// Boss olha pra frente (pra sala); devs também (de costas pro Boss)

// ---------------- portas para as outras salas ----------------
const doors = []; // {room, mesh, label, pos}
const DOOR_Z = [7.5, 3.2, -1.1];
function roomColor(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return new THREE.Color().setHSL((h % 360) / 360, 0.55, 0.55).getHex(); }
function buildDoors() {
  for (const d of doors) { scene.remove(d.group); d.label.remove(); }
  doors.length = 0;
  // um elevador só: leva ao prédio (todas as salas)
  const g = new THREE.Group(); g.position.set(W / 2 - 2.6, 0, -D / 2 + 0.25); g.rotation.y = -Math.PI / 2; scene.add(g);
  box(0.25, 4.6, 0.3, 0x8a8f96, 0, 2.3, -1.45, g); box(0.25, 4.6, 0.3, 0x8a8f96, 0, 2.3, 1.45, g); box(0.25, 0.3, 3.2, 0x8a8f96, 0, 4.6, 0, g);
  const steel = mat(0xb8bec6, { metalness: 0.6, roughness: 0.35, emissive: 0x223344, emissiveIntensity: 0.1 });
  const panel = box(0.1, 4.3, 1.25, 0, 0.05, 2.15, -0.63, g, steel); box(0.1, 4.3, 1.25, 0, 0.05, 2.15, 0.63, g, steel);
  box(0.12, 0.5, 0.3, 0x222222, 0.15, 2.2, 1.9, g); // botões
  box(0.05, 0.12, 0.12, 0xf2c14e, 0.22, 2.32, 1.9, g, mat(0xf2c14e, { emissive: 0xf2c14e, emissiveIntensity: 0.8 }));
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const x = c.getContext('2d'); x.fillStyle = '#111'; x.fillRect(0, 0, 512, 128); x.fillStyle = '#f3ece4'; x.font = 'bold 56px -apple-system, Inter, sans-serif'; x.textAlign = 'center'; x.fillText('ELEVADOR', 256, 82);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.65), new THREE.MeshBasicMaterial({ map: tex }));
  sign.rotation.y = Math.PI / 2; sign.position.set(0.2, 5.2, 0); g.add(sign);
  const label = document.createElement('div'); label.className = 'label door'; host.appendChild(label);
  doors.push({ room: { id: '' }, group: g, panel, label, pos: new THREE.Vector3(W / 2 - 2.6, 6.2, -D / 2 + 1.2) });
  updateDoorLabels();
}
function roomBadge(r) { return r.blocked ? `<b style="color:var(--blocked)">${r.blocked} precisa de você</b>` : r.working ? `${r.working} trabalhando` : r.live ? 'tudo calmo' : 'vazia'; }
function updateDoorLabels() {
  const outras = ROOMS.filter((r) => r.id !== PROJECT);
  const bl = outras.filter((r) => r.blocked), wk = outras.filter((r) => r.working);
  for (const d of doors) {
    d.room.blocked = bl.length;
    d.label.innerHTML = `Prédio · ${bl.length ? `<b style="color:#fff">${bl.map((r) => esc(r.brand)).join(', ')} precisa${bl.length > 1 ? 'm' : ''} de você</b>` : wk.length ? `${wk.length} sala(s) trabalhando` : `${outras.length} outra(s) sala(s)`}`;
    d.label.classList.toggle('blocked', !!bl.length);
  }
}
function goRoom(id) { document.body.style.transition = 'opacity .35s'; document.body.style.opacity = '0'; setTimeout(() => location.assign(id ? '/?p=' + encodeURIComponent(id) : '/'), 350); setTimeout(() => { document.body.style.opacity = ''; }, 3000); }
function renderRooms() {
  const el = document.getElementById('rooms');
  const bl = ROOMS.filter((r) => r.id !== PROJECT && r.blocked).length;
  el.innerHTML = `<button data-room="" title="Ver o prédio (todas as salas)">← Prédio${bl ? ' <span class="dot bad"></span>' : ''}</button>
    <select id="roomSel">${ROOMS.map((r, i) => `<option value="${esc(r.id)}" ${r.id === PROJECT ? 'selected' : ''}>${i + 1}º · ${esc(r.brand)}${r.blocked ? ' (!)' : r.working ? ' (…)' : ''}</option>`).join('')}<option value="__novo">＋ Adicionar andar…</option><option value="__ger">⚙ Gerenciar prédio…</option></select>`;
  document.getElementById('roomSel').onchange = (e) => { if (e.target.value === '__novo') { e.target.value = PROJECT; return import('./andar.js').then((m) => m.abrirNovoAndar()); } if (e.target.value === '__ger') { e.target.value = PROJECT; return import('./andar.js').then((m) => m.abrirGerenciar()); } if (e.target.value !== PROJECT) goRoom(e.target.value); };
  if (!doors.length) buildDoors(); else updateDoorLabels();
}
document.getElementById('rooms').addEventListener('click', (e) => { const b = e.target.closest('button[data-room]'); if (b) goRoom(b.dataset.room); });

// ---------------- personagens ----------------
const chars = new Map(); // id -> char
const labelsLayer = host;

function makeChar(id) {
  const color = colorFor(id);
  const isBoss = id === 'boss';
  const s = isBoss ? 1.6 : 1.3;
  const g = new THREE.Group();
  const body = new THREE.Group(); g.add(body);
  const bodyMat = mat(color, { roughness: 0.55 });
  const torso = box(1.3 * s, 1.2 * s, 1.0 * s, color, 0, 1.25 * s, 0, body, bodyMat);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x15121a, roughness: 0.3 });
  const shapeSeed = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const eyeStyle = shapeSeed % 3;
  for (const sx of [-1, 1]) {
    if (eyeStyle === 0) box(0.16 * s, 0.26 * s, 0.05, 0, sx * 0.28 * s, 1.4 * s, 0.51 * s, body, eyeMat);
    else if (eyeStyle === 1) box(0.26 * s, 0.1 * s, 0.05, 0, sx * 0.28 * s, 1.4 * s, 0.51 * s, body, eyeMat);
    else box(0.18 * s, 0.18 * s, 0.05, 0, sx * 0.28 * s, 1.42 * s, 0.51 * s, body, eyeMat);
  }
  const legs = [];
  for (const sx of [-1, 1]) legs.push(box(0.3 * s, 0.6 * s, 0.3 * s, color, sx * 0.35 * s, 0.35 * s, 0, g, bodyMat));
  const arms = [];
  for (const sx of [-1, 1]) arms.push(box(0.22 * s, 0.6 * s, 0.22 * s, color, sx * 0.8 * s, 1.15 * s, 0, body, bodyMat));
  if (isBoss) {
    box(0.9, 0.18, 0.9, 0x2b2b2b, 0, 1.97 * s, 0, body); // boné
    box(0.9, 0.06, 0.5, 0x2b2b2b, 0, 1.9 * s, 0.55, body);
    box(0.18, 0.5, 0.05, 0x9b2c2c, 0, 0.98 * s, 0.52 * s, body); // gravata
  } else if (shapeSeed % 2) {
    for (const sx of [-1, 1]) box(0.12, 0.45, 0.12, color, sx * 0.4, 2.05, 0, body, bodyMat); // antenas
  }
  scene.add(g);

  const label = document.createElement('div'); label.className = 'label'; labelsLayer.appendChild(label);
  const deskPos = isBoss ? BOSS_DESK : null;
  return {
    id, g, body, legs, arms, label, bodyMat, isBoss, deskPos, desk: isBoss ? bossDesk : null, slot: -1,
    pos: new THREE.Vector3(), home: new THREE.Vector3(), path: [], mode: 'home', bubble: null, bubbleUntil: 0,
    queue: [], status: 'idle', prevStatus: 'idle', hopT: 0, leaving: false, walkT: 0,
  };
}

const deskPosOf = (c) => (c.isBoss ? BOSS_DESK : SPECIAL_DESK[c.id] || SLOTS[c.slot]);
function homeOf(c) { const d = deskPosOf(c); return new THREE.Vector3(d.x, 0, d.z - 1.5); }
function visitPoint(target) {
  const d = deskPosOf(target);
  return new THREE.Vector3(d.x + (target.isBoss ? 2.8 : 2.2), 0, d.z + 0.2);
}

const deskBySlot = new Map();
let booted = false;
function ensureChar(id) {
  if (chars.has(id)) return chars.get(id);
  const c = makeChar(id);
  if (!c.isBoss) {
    if (!SPECIAL_DESK[id] && SPOT[id] && !Object.values(SPECIAL_DESK).includes(SPOT[id])) SPECIAL_DESK[id] = SPOT[id]; // especialista que a config ainda não listava
    if (SPECIAL_DESK[id]) {
      c.slot = 'sp-' + id;
      if (!deskBySlot.has(c.slot)) deskBySlot.set(c.slot, makeDesk(SPECIAL_DESK[id]));
    } else {
      const used = new Set([...chars.values()].map((x) => x.slot));
      const fixed = REPO_ORDER.indexOf(id.replace(/^dev-/, ''));
      c.slot = fixed >= 0 && !used.has(fixed) ? fixed : SLOTS.findIndex((_, i) => i >= REPO_ORDER.length && !used.has(i));
      if (c.slot < 0) c.slot = SLOTS.findIndex((_, i) => !used.has(i));
      if (c.slot < 0) c.slot = 0;
      if (!deskBySlot.has(c.slot)) deskBySlot.set(c.slot, makeDesk(SLOTS[c.slot]));
    }
    c.desk = deskBySlot.get(c.slot);
    c.home.copy(homeOf(c));
    if (booted) { c.pos.copy(DOOR); c.path = [c.home.clone()]; c.mode = 'walking'; c.after = 'home'; }
    else c.pos.copy(c.home); // já estava trabalhando quando a página abriu
  } else {
    c.home.copy(homeOf(c)); c.pos.copy(c.home);
  }
  c.g.position.copy(c.pos);
  chars.set(id, c);
  return c;
}
function aprender(id, motivo = 'as novas instruções') {
  const c = chars.get(id); if (!c) return false;
  c.aprendendo = true; c.podeVoltar = false; c.foraMs = 3500; c.speed = 1.6;
  say(c, { kind: 'servico', text: `vou aprender ${motivo} e já volto` }, 3000);
  c.mode = 'walking'; c.after = 'aprender'; c.path = [new THREE.Vector3(c.pos.x, 0, c.pos.z + (c.isBoss ? 2.2 : 0.8)), DOOR.clone()];
  return true;
}
function removeChar(c) {
  if (c.aprendendo) return;
  c.leaving = true; c.path = [DOOR.clone()]; c.mode = 'walking'; c.after = 'gone';
}

// ---------------- interações -> animação ----------------
function playInteraction(e, tries = 0) {
  if (e.from === 'voce') { const t = chars.get(e.to); if (t) { say(t, e, 4500); t.attentionUntil = 0; } return; }
  if (e.kind === 'wait') { const b = chars.get(e.from); if (b && b.mode === 'home') say(b, e, 2500); return; }
  if (e.kind === 'approve') { const t = chars.get(e.to); if (t) setTimeout(() => (t.hopT = 1.2), 2200); }
  if (e.kind === 'ronda') { const t = chars.get(e.to); if (t) say(t, e, 3500); return; }
  if (e.kind === 'servico') { toast({ ...e, from: 'voce' }); return; }
  if (['alert', 'pipefail', 'pipeok', 'qafail'].includes(e.kind)) { toast(e); const f = chars.get(e.from); if (f) { f.speed = 2.2; f.alarm = e.kind !== 'pipeok'; } }
  let from = chars.get(e.from), to = chars.get(e.to);
  if ((!from || !to) && tries < 12) return setTimeout(() => playInteraction(e, tries + 1), 500);
  if (!from) return;
  from.queue.push({ to, e });
  if (from.mode === 'home') nextVisit(from);
}
function nextVisit(c) {
  const job = c.queue.shift();
  if (!job) return;
  const { to, e } = job;
  if (!to || to === c || to.leaving) { say(c, e, 3500); return setTimeout(() => nextVisit(c), 3600); }
  c.job = job;
  const p = visitPoint(to);
  c.path = [new THREE.Vector3(c.pos.x, 0, c.pos.z + (c.isBoss ? 2.2 : 0.8)), p];
  c.mode = 'walking'; c.after = 'talk';
}
function think(c, text) {
  if (c.mode !== 'home') return;
  if (!c.thought) { c.thought = document.createElement('div'); c.thought.className = 'think'; labelsLayer.appendChild(c.thought); }
  c.thought.textContent = text; c.thought.style.display = 'block'; c.thoughtUntil = performance.now() + 3200;
}
function toast(e) {
  const box = document.getElementById('toasts'), k = KIND[e.kind] || {};
  const nm = (id) => (id === 'boss' ? 'Boss' : SPECIAL[id]?.title || (id ? parseId(id).title : '?'));
  const el = document.createElement('div'); el.className = 'toast'; el.style.setProperty('--k', k.css || 'var(--accent)');
  el.innerHTML = `<b>${esc(k.label || e.kind)} · ${esc(nm(e.from))}</b>${esc(e.text || '')}`;
  box.prepend(el); setTimeout(() => el.classList.add('out'), 9000); setTimeout(() => el.remove(), 9600);
  try { if (e.kind !== 'pipeok' && 'Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification('Orquestra · ' + (k.label || e.kind), { body: (e.text || '').slice(0, 140) }); } catch {}
}
function say(c, e, ms) {
  if (!c.bubble) { c.bubble = document.createElement('div'); c.bubble.className = 'bubble'; labelsLayer.appendChild(c.bubble); }
  const k = KIND[e.kind] || { label: e.kind, css: 'var(--accent)' };
  c.bubble.style.setProperty('--k', k.css);
  c.bubble.innerHTML = `<small>${esc(k.label)}</small>${esc(clip(e.text || '', 220))}`;
  c.bubble.style.display = 'block';
  c.bubbleUntil = performance.now() + ms;
}

// ---------------- loop ----------------
const clock = new THREE.Clock();
const v = new THREE.Vector3();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime, now = performance.now();
  const d = new Date();
  hand.parent.rotation.z = 0;
  hand.rotation.z = -((d.getHours() % 12) / 12) * Math.PI * 2; hand.position.set(Math.sin(-hand.rotation.z) * 0.3, Math.cos(hand.rotation.z) * 0.3, 0.02);
  hand2.rotation.z = -(d.getMinutes() / 60) * Math.PI * 2; hand2.position.set(Math.sin(-hand2.rotation.z) * 0.22, Math.cos(hand2.rotation.z) * 0.22, 0.03);

  for (const c of [...chars.values()]) {
    if (c.mode === 'fora' && now > c.voltaEm && c.podeVoltar !== false) { c.g.visible = true; c.label.style.opacity = ''; c.mode = 'walking'; c.after = 'home'; c.path = [c.home.clone()]; c.aprendendo = false; say(c, { kind: 'servico', text: 'voltei — já com as novas instruções ✓' }, 4000); setTimeout(() => (c.hopT = 1.2), 2600); }
    // movimento
    if (c.mode === 'walking') {
      const target = c.path[0];
      v.subVectors(target, c.pos); v.y = 0;
      const dist = v.length(), step = 5 * (c.speed || 1) * dt;
      if (dist <= step) {
        c.pos.copy(target); c.path.shift();
        if (!c.path.length) {
          if (c.after === 'talk') {
            c.mode = 'talking'; say(c, c.job.e, 3800);
            c.talkUntil = now + 3800;
            const tgt = c.job.to; if (tgt) tgt.attentionUntil = now + 3800;
          } else if (c.after === 'aprender') {
            c.mode = 'fora'; c.g.visible = false; c.label.style.opacity = '.35'; c.voltaEm = now + (c.foraMs || 3500);
          } else if (c.after === 'gone' && S.agents[c.id]) {
            c.leaving = false; c.after = 'home'; c.path = [c.home.clone()]; continue;
          } else if (c.after === 'gone') {
            scene.remove(c.g); c.label.remove(); c.bubble?.remove(); chars.delete(c.id); continue;
          } else { c.mode = 'home'; c.speed = 1; c.alarm = false; nextVisit(c); }
        }
      } else {
        v.normalize(); c.pos.addScaledVector(v, step);
        c.g.rotation.y = Math.atan2(v.x, v.z);
      }
      c.walkT += dt * 12;
    } else if (c.mode === 'talking') {
      const tgt = c.job?.to;
      if (tgt) { v.subVectors(tgt.pos, c.pos); c.g.rotation.y = Math.atan2(v.x, v.z); }
      if (now > c.talkUntil) { c.mode = 'walking'; c.after = 'home'; c.path = [new THREE.Vector3(c.home.x, 0, c.home.z + (c.isBoss ? 2.2 : 0.8)), c.home.clone()]; c.job = null; }
    } else {
      // em casa: olha pra mesa (frente = +z) ou pra quem veio falar
      let ry = 0;
      if (c.attentionUntil > now) {
        const visitor = [...chars.values()].find((o) => o.mode === 'talking' && o.job?.to === c);
        if (visitor) { v.subVectors(visitor.pos, c.pos); ry = Math.atan2(v.x, v.z); }
      }
      c.g.rotation.y += (ry - c.g.rotation.y) * Math.min(1, dt * 6);
    }
    c.g.position.set(c.pos.x, 0, c.pos.z);

    // pose por status
    const walking = c.mode === 'walking';
    const swing = walking ? Math.sin(c.walkT) * 0.6 : 0;
    c.legs[0].rotation.x = swing; c.legs[1].rotation.x = -swing;
    c.arms[0].rotation.x = -swing; c.arms[1].rotation.x = swing;
    let y = 0;
    if (!walking && c.mode === 'home') {
      if (c.status === 'working') { y = Math.abs(Math.sin(t * 10)) * 0.06; c.arms[0].rotation.x = -0.9 + Math.sin(t * 18) * 0.15; c.arms[1].rotation.x = -0.9 - Math.sin(t * 18) * 0.15; }
      else if (c.status === 'blocked') { y = Math.abs(Math.sin(t * 6)) * 0.7; c.arms[0].rotation.z = 2.6; c.arms[1].rotation.z = -2.6; }
      if (c.status !== 'blocked') { c.arms[0].rotation.z = 0; c.arms[1].rotation.z = 0; }
      if (c.hopT > 0) { c.hopT -= dt; y = Math.sin((1 - c.hopT / 1.2) * Math.PI * 3) ** 2 * 0.9; c.body.rotation.y = (1 - c.hopT / 1.2) * Math.PI * 2; } else c.body.rotation.y = 0;
    }
    if (c.mode === 'talking') y = Math.abs(Math.sin(t * 5)) * 0.08;
    c.body.position.y = y;
    const dim = c.status === 'idle' && c.mode === 'home' && !c.isBoss;
    c.bodyMat.opacity = dim ? 0.75 : 1; c.bodyMat.transparent = dim;

    // monitor
    if (c.desk) {
      const m = c.desk.screenMat;
      const col = { working: 0x3d7dff, blocked: 0xff3b3b, done: 0x2fbf71, idle: 0x334455 }[c.status] ?? 0x334455;
      m.emissive.setHex(col);
      m.emissiveIntensity = c.status === 'working' ? 0.7 + Math.sin(t * 6) * 0.3 : c.status === 'blocked' ? 0.6 + Math.abs(Math.sin(t * 8)) * 0.6 : 0.5;
    }

    // rótulos
    project(c, 2.9 * (c.isBoss ? 1.6 : 1.3) + y, c.label, 0);
    if (c.thought && c.thought.style.display !== 'none') {
      if (now > c.thoughtUntil || c.mode !== 'home' || (c.bubble && c.bubble.style.display !== 'none')) c.thought.style.display = 'none';
      else project(c, 2.9 * (c.isBoss ? 1.6 : 1.3) + y, c.thought, 24);
    }
    if (c.alarm) c.body.rotation.z = Math.sin(t * 30) * 0.08; else c.body.rotation.z = 0;
    if (c.bubble && c.bubble.style.display !== 'none') {
      if (now > c.bubbleUntil) c.bubble.style.display = 'none';
      else project(c, 2.9 * (c.isBoss ? 1.6 : 1.3) + y, c.bubble, 30);
    }
  }
  for (const d of doors) { pv.copy(d.pos).project(camera); d.label.style.left = ((pv.x + 1) / 2) * host.clientWidth + 'px'; d.label.style.top = ((1 - pv.y) / 2) * host.clientHeight + 'px'; d.panel.material.emissiveIntensity = d.room.blocked ? 0.35 + Math.abs(Math.sin(t * 4)) * 0.4 : 0.15; }
  if (window.__office !== false) renderer.render(scene, camera); // no Painel a cena 3D não é desenhada (economiza CPU/GPU)
  requestAnimationFrame(tick);
}
const pv = new THREE.Vector3();
function project(c, h, el, extra) {
  pv.set(c.pos.x, h, c.pos.z).project(camera);
  el.style.left = ((pv.x + 1) / 2) * host.clientWidth + 'px';
  el.style.top = ((1 - pv.y) / 2) * host.clientHeight - extra + 'px';
}

// câmera: arrastar gira, roda dá zoom
let drag = null;
let downX = 0;
renderer.domElement.addEventListener('pointerdown', (e) => { drag = e.clientX; downX = e.clientX; renderer.domElement.style.cursor = 'grabbing'; });
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
renderer.domElement.addEventListener('click', (e) => {
  if (Math.abs(e.clientX - downX) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const dh = ray.intersectObjects(doors.map((d) => d.group), true)[0];
  if (dh) { const d = doors.find((x) => { let o = dh.object; while (o) { if (o === x.group) return true; o = o.parent; } return false; }); if (d) return goRoom(d.room.id); }
  const hit = ray.intersectObjects([...chars.values()].map((c) => c.g), true)[0];
  if (!hit) { if (ray.intersectObject(quadroInfo, true)[0]) mostrarInfoAndar(); return; }
  for (const c of chars.values()) { let o = hit.object; while (o) { if (o === c.g) { if (S.agents[c.id]?.status === 'blocked') return abrirResposta(c.id); if (S.agents[c.id]?.pergunta) return abrirConversa(c.id); if (selected === c.id) return openScreen(c.id); return select(c.id); } o = o.parent; } }
});
addEventListener('pointerup', () => { drag = null; renderer.domElement.style.cursor = 'grab'; });
addEventListener('pointermove', (e) => { if (drag == null) return; az -= (e.clientX - drag) * 0.006; drag = e.clientX; placeCamera(); });
renderer.domElement.addEventListener('wheel', (e) => { e.preventDefault(); zoom = Math.min(2.6, Math.max(0.6, zoom * (e.deltaY > 0 ? 0.92 : 1.08))); resize(); }, { passive: false });

// ---------------- UI ----------------
function syncChars() {
  const live = new Set(Object.keys(S.agents));
  for (const id of live) {
    const c = ensureChar(id), a = S.agents[id];
    if (c.leaving && !c.aprendendo) { c.leaving = false; c.g.visible = true; c.mode = 'walking'; c.after = 'home'; c.path = [c.home.clone()]; }
    if (a.status === 'done' && c.prevStatus !== 'done' && c.prevStatus) c.hopT = 1.2;
    c.prevStatus = c.status; c.status = a.status;
    if (a.status === 'blocked' && c.prevStatus && c.prevStatus !== 'blocked') avisaBloqueio(id);
    const { title } = parseId(id);
    const st = a.status;
    const pq = st !== 'blocked' && a.pergunta;
    c.label.className = 'label' + (st === 'blocked' ? ' blocked' : pq ? ' pergunta' : '');
    c.label.dataset.id = id;
    const lh = `${pq ? '<b class="excl">!</b>' : st === 'blocked' ? '<b class="excl red">!</b>' : ''}<span class="dot" style="background:${hex(colorFor(id))}"></span>${esc(title)}${st === 'blocked' ? ' · precisa de você' : pq ? ' · quer falar com você' : st === 'done' ? ' ✓' : ''}`;
    if (c.label.dataset.h !== lh) { c.label.dataset.h = lh; c.label.innerHTML = lh; }
    if (pq && c.perguntaTs !== a.pergunta.ts) { if (c.perguntaTs !== undefined) avisaPergunta(id, a.pergunta); c.hopT = 1.2; }
    c.perguntaTs = pq ? a.pergunta.ts : null;
  }
  for (const c of chars.values()) { if (c.aprendendo && live.has(c.id) && c.mode === 'fora' && c.saiuDoAr) c.podeVoltar = true; if (c.aprendendo && !live.has(c.id)) c.saiuDoAr = true; if (!live.has(c.id) && !c.leaving) removeChar(c); }
  document.getElementById('empty').style.display = S.hcOk && !live.has('boss') ? 'block' : 'none';
  faixaBloqueio();
}

const ORDER = (id) => {
  if (id === 'boss') return 0;
  if (SPECIAL[id]) return 1;
  const i = REPO_ORDER.findIndex((r) => id === 'dev-' + r || id.startsWith('dev-' + r + '-'));
  return 2 + (i < 0 ? 99 : i);
};
const byOrder = (a, b) => ORDER(a) - ORDER(b) || a.localeCompare(b);
let selected = null;
function select(id) {
  selected = id;
  const sel = document.getElementById('to');
  if (sel) sel.value = id;
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', c.dataset.id === id));
  document.getElementById('msg')?.focus();
}
function renderComposer() {
  const sel = document.getElementById('to');
  const ids = Object.keys(S.agents).sort(byOrder);
  const cur = selected && S.agents[selected] ? selected : ids[0] || '';
  sel.innerHTML = ids.map((id) => `<option value="${esc(id)}">${esc(id === 'boss' ? 'Boss' : SPECIAL[id]?.title || id)}</option>`).join('');
  sel.value = cur; selected = cur || null;
}
async function sendMsg() {
  const to = document.getElementById('to').value, ta = document.getElementById('msg'), st = document.getElementById('sendSt');
  const text = ta.value.trim();
  if (!to || !text) return;
  st.textContent = 'enviando…';
  try {
    const r = await fetch('/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': S.token || '' }, body: JSON.stringify({ project: PROJECT, agent: to, text }) });
    if (r.status === 409 && r.headers.get('X-Orq') === 'bloqueado') { st.textContent = ''; return abrirResposta(to, text); }
    if (!r.ok) throw new Error(await r.text());
    ta.value = ''; st.textContent = 'enviado para ' + (to === 'boss' ? 'Boss' : SPECIAL[to]?.title || to);
  } catch (err) { st.textContent = 'não enviado'; avisa('Mensagem não enviada', err.message); }
}
document.getElementById('send').addEventListener('click', sendMsg);
document.getElementById('notif').addEventListener('click', async () => { try { const r = await Notification.requestPermission(); document.getElementById('sendSt').textContent = r === 'granted' ? 'avisos do Mac ligados' : 'avisos não permitidos'; } catch {} });
document.getElementById('msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendMsg(); });
document.getElementById('to').addEventListener('change', (e) => select(e.target.value));
document.getElementById('cards').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-ag]');
  if (b) {
    e.stopPropagation();
    const ag = b.dataset.agent, action = b.dataset.ag, nm = ag === 'boss' ? 'Boss' : SPECIAL[ag]?.title || LABEL(parseId(ag).repo) || ag;
    if (action === 'stop' && !(await confirma(`Dispensar ${nm}?`, 'Ele sai do escritório. O que estiver fazendo agora é interrompido.', true, 'Dispensar'))) return;
    if (action === 'restart' && !(await confirma(`Reiniciar ${nm}?`, 'Ele sai pelo elevador e volta com o contexto limpo (as instruções e a mesa continuam as mesmas).', false, 'Reiniciar'))) return;
    if (action === 'ok') { b.disabled = true; await post('/agent', { agent: ag, action: 'ok' }); return; }
    if (action === 'herdr') return abrirNoHerdr(ag, document.getElementById('sendSt'));
    if (action === 'responder') return abrirResposta(ag);
    if (action === 'falar') return abrirConversa(ag);
    if (action === 'interromper') { b.disabled = true; const r = await post('/agent', { agent: ag, action }).catch((er) => ({ ok: false, out: er.message })); document.getElementById('sendSt').textContent = r.out || ''; if (!r.ok) avisa('Não deu certo', r.out || 'falhou'); return; }
    if (action === 'restart') { aprender(ag, 'um contexto novo'); const c0 = chars.get(ag); if (c0) setTimeout(() => { c0.saiuDoAr = true; c0.podeVoltar = true; }, 7000); }
    const st = document.getElementById('sendSt'); st.textContent = (action === 'start' ? 'chamando ' : action === 'stop' ? 'dispensando ' : 'reiniciando ') + nm + '…';
    b.disabled = true;
    try {
      const r = await fetch('/agent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': S.token || '' }, body: JSON.stringify({ project: PROJECT, agent: ag, action }) });
      const j = await r.json().catch(() => ({}));
      st.textContent = r.ok ? (action === 'start' ? `${nm} está vindo` : action === 'stop' ? `${nm} dispensado` : `${nm} reiniciado`) : (j.out || 'falhou');
      if (!r.ok) avisa('Não deu certo', j.out || 'falhou');
    } catch (err) { st.textContent = 'erro: ' + err.message; }
    b.disabled = false;
    return;
  }
  const cf = e.target.closest('[data-cfg]'); if (cf) { e.stopPropagation(); return openScreen(cf.dataset.cfg, 'instr'); }
  const sc = e.target.closest('[data-screen]'); if (sc) { e.stopPropagation(); return openScreen(sc.dataset.screen); }
  const c = e.target.closest('.card'); if (c) select(c.dataset.id);
});
let screenTimer = null, viewAgent = null, viewTab = 'chat';
const chatCache = {};
const nmOf = (id) => (id === 'boss' ? 'Boss' : id === 'voce' ? 'Você' : SPECIAL[id]?.title || (id ? parseId(id).title : ''));
function mdLite(t) {
  return esc(t).replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.replace(/^\w*\n/, '')}</pre>`).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
}
function chatHtml(items) {
  if (!items.length) return '<div class="note" style="padding:12px">Nada ainda nesta sessão.</div>';
  return items.map((it) => {
    const t = new Date(it.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (it.kind === 'tool') return `<div class="cm tool"><span>${t}</span>${esc(it.text)}</div>`;
    if (it.role === 'user') return `<div class="cm user"><small>${esc(it.from ? nmOf(it.from) === it.from ? it.from : nmOf(it.from) : 'Você / Boss')} · ${t}</small>${mdLite(it.text)}</div>`;
    return `<div class="cm agent"><small>${esc(nmOf(viewAgent))} · ${t}</small>${mdLite(it.text)}</div>`;
  }).join('');
}
function renderChat() {
  const box = document.getElementById('scrChat');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.innerHTML = chatHtml(chatCache[viewAgent] || []);
  if (atBottom) box.scrollTop = box.scrollHeight;
}
async function loadChat(id) {
  try { chatCache[id] = await fetch('/chat?p=' + encodeURIComponent(PROJECT) + '&agent=' + encodeURIComponent(id), { cache: 'no-store' }).then((r) => r.json()); } catch { chatCache[id] = chatCache[id] || []; }
  if (viewAgent === id) { renderChat(); const b = document.getElementById('scrChat'); b.scrollTop = b.scrollHeight; }
}
async function loadScreen(id) {
  const pre = document.getElementById('scrText');
  try {
    const r = await fetch('/screen?p=' + encodeURIComponent(PROJECT) + '&agent=' + encodeURIComponent(id), { cache: 'no-store' });
    const t = await r.text();
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    pre.textContent = t.replace(/\s+$/, '');
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  } catch (err) { pre.textContent = 'erro: ' + err.message; }
}
function setViewTab(tabName) {
  viewTab = tabName;
  document.querySelectorAll('#screen [data-vt]').forEach((b) => b.classList.toggle('on', b.dataset.vt === tabName));
  document.getElementById('scrChat').style.display = tabName === 'chat' ? 'block' : 'none';
  document.getElementById('scrText').style.display = tabName === 'tela' ? 'block' : 'none';
  document.getElementById('scrSess').style.display = tabName === 'sess' ? 'block' : 'none';
  document.getElementById('scrSkills').style.display = tabName === 'skills' ? 'block' : 'none';
  document.getElementById('scrInstr').style.display = tabName === 'instr' ? 'block' : 'none';
  if (tabName === 'sess') loadSess(viewAgent);
  if (tabName === 'skills') loadSkills(viewAgent);
  if (tabName === 'instr') loadInstr(viewAgent);
  clearInterval(screenTimer);
  if (tabName === 'tela') { loadScreen(viewAgent); screenTimer = setInterval(() => loadScreen(viewAgent), 2000); }
}
function openScreen(id, tabName = 'chat') {
  const qk = document.getElementById('scrQuick'); if (qk && qk.dataset.agent !== id) qk.remove();
  if (S.agents?.[id]?.pergunta) setTimeout(() => { if (viewAgent === id && !document.getElementById('scrQuick')) respostasRapidas(id, S.agents[id]?.pergunta); }, 0);
  if (viewAgent !== id) { citacao = null; const q = document.getElementById('scrQuote'); if (q) q.style.display = 'none'; }
  viewAgent = id; setTimeout(() => montaVia(id, !!citacao), 0);
  document.getElementById('scrTitle').textContent = nmOf(id);
  document.getElementById('screen').style.display = 'flex'; select(id);
  loadChat(id); setViewTab(tabName);
}
document.getElementById('screen').addEventListener('click', (e) => { const b = e.target.closest('[data-vt]'); if (b) setViewTab(b.dataset.vt); });
document.getElementById('scrClose').addEventListener('click', () => { document.getElementById('screen').style.display = 'none'; clearInterval(screenTimer); viewAgent = null; });
// ---------------- sessões do agente: renovar contexto, salvar/ver .md, retomar ----------------
const fmtDt = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const durTxt = (a, b) => { const m = Math.round((b - a) / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': S.token || '' }, body: JSON.stringify({ project: PROJECT, ...body }) }).then(async (r) => ({ ok: r.ok, ...(await r.json().catch(() => ({}))) }));
let sessData = null, sessView = null;
async function loadSess(id) {
  const box = document.getElementById('scrSess'); if (!sessData || sessData.agent !== id) box.innerHTML = '<div class="note">carregando sessões…</div>';
  try { sessData = { agent: id, ...(await fetch('/sessions?p=' + encodeURIComponent(PROJECT) + '&agent=' + encodeURIComponent(id), { cache: 'no-store' }).then((r) => r.json())) }; } catch (e) { box.innerHTML = '<div class="note">erro: ' + esc(e.message) + '</div>'; return; }
  renderSess();
}
function renderSess() {
  const d = sessData, id = d.agent, vivo = !!S.agents[id], box = document.getElementById('scrSess');
  const mem = d.memoria;
  box.innerHTML = `<div class="ssAct">
      <button class="sb pri" data-ss="renovar" ${!vivo || d.renovando ? 'disabled' : ''} title="Ele resume o trabalho em memoria.md, limpa o contexto e relê o resumo">${d.renovando ? 'renovando…' : '↻ Renovar contexto'}</button>
      <button class="sb" data-ss="salvar" ${d.sessoes.length ? '' : 'disabled'}>💾 Salvar sessão atual em .md</button>
      <p class="note">As sessões também são salvas sozinhas em .md 15 min depois da última mensagem, em <code>${esc(tidy(d.pasta))}</code>.</p></div>
    <details class="mem" ${mem ? '' : 'open'}><summary><b>Memória</b> ${mem ? '· atualizada ' + fmtDt(mem.at) : '· ainda não existe'}</summary>${mem ? `<pre>${esc(mem.text)}</pre>` : '<p class="note">Use “Renovar contexto” para ele escrever o resumo. Quando começar uma sessão nova, ele lê esse arquivo.</p>'}</details>
    ${d.sessoes.length ? '' : '<div class="note">Nenhuma sessão registrada ainda.</div>'}
    ${d.sessoes.map((x) => `<div class="srow"><div><b>${fmtDt(x.start)}</b> → ${fmtDt(x.end)}${x.atual ? '<span class="bdg on">atual</span>' : ''}${x.salva ? '<span class="bdg">.md</span>' : ''}
        <div class="sm">${durTxt(x.start, x.end)} · ${x.n} mensagens${x.conta ? ' · ' + esc(x.conta) : ''}</div></div>
      <div class="bt"><button class="sb" data-ss="ver" data-sid="${x.sid}">ver</button><a class="sb" href="/session.md?p=${encodeURIComponent(PROJECT)}&agent=${encodeURIComponent(id)}&sid=${x.sid}&dl=1" style="text-decoration:none">baixar .md</a>${x.salva ? '' : `<button class="sb" data-ss="salvar" data-sid="${x.sid}">salvar</button>`}${x.atual ? '' : `<button class="sb" data-ss="retomar" data-sid="${x.sid}">retomar</button>`}</div>
      ${sessView?.sid === x.sid ? `<div class="mdview" style="grid-column:1/-1">${mdLite(sessView.text).replace(/(^|<br>)#{1,3} ([^<]*)/g, '$1<b style="display:block;margin-top:10px;color:var(--accent)">$2</b>')}</div>` : ''}</div>`).join('')}`;
}
document.getElementById('scrSess').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-ss]'); if (!b) return;
  const id = viewAgent, act = b.dataset.ss, sid = b.dataset.sid, nm = nmOf(id);
  if (act === 'ver') {
    if (sessView?.sid === sid) { sessView = null; return renderSess(); }
    b.textContent = 'abrindo…';
    const t = await fetch(`/session.md?p=${encodeURIComponent(PROJECT)}&agent=${encodeURIComponent(id)}&sid=${sid}`, { cache: 'no-store' }).then((r) => r.text()).catch((er) => 'erro: ' + er.message);
    sessView = { sid, text: t.length > 60000 ? t.slice(0, 60000) + '\n\n… (cortado — use “baixar .md” para ver tudo)' : t }; return renderSess();
  }
  if (act === 'renovar' && !(await confirma(`Renovar o contexto de ${nm}?`, 'A sessão atual é salva em .md. Ele escreve um resumo em memoria.md, o contexto é limpo e ele relê só o resumo — continua sabendo o essencial gastando bem menos.', false, 'Renovar'))) return;
  if (act === 'retomar' && !(await confirma(`Retomar essa sessão de ${nm}?`, id === 'boss' ? 'O Boss troca para essa conversa antiga (comando /resume).' : 'Ele sai e volta com essa conversa antiga carregada. O que estiver fazendo agora é interrompido.', false, 'Retomar'))) return;
  b.disabled = true;
  const r = await post('/sessao', { agent: id, action: act, sid }).catch((er) => ({ ok: false, out: er.message }));
  if (!r.ok) avisa('Não deu certo', r.out || 'falhou'); else document.getElementById('sendSt').textContent = r.out || 'ok';
  setTimeout(() => loadSess(id), act === 'retomar' ? 4000 : 400);
});
setInterval(() => { if (viewAgent && viewTab === 'sess' && sessData?.renovando) loadSess(viewAgent); }, 4000);

// ---------------- skills de cada agente ----------------
let skData = null;
const qs = (o) => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
async function loadSkills(id) {
  const box = document.getElementById('scrSkills'); if (!skData || skData.agente?.id !== id) box.innerHTML = '<div class="note">carregando skills…</div>';
  try { skData = await fetch('/skills?' + qs({ p: PROJECT, agent: id }), { cache: 'no-store' }).then((r) => r.json()); } catch (e) { box.innerHTML = '<div class="note">erro: ' + esc(e.message) + '</div>'; return; }
  renderSkills();
}
const haQuanto = (ms) => { if (!ms) return 'nunca'; const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? 'agora há pouco' : s < 3600 ? `há ${Math.round(s / 60)} min` : s < 86400 ? `há ${Math.round(s / 3600)} h` : new Date(ms).toLocaleString('pt-BR'); };
function caixaMotor(m, tipo) {
  if (!m) return '';
  const s = m.sync;
  return `<div class="motorBox"><b class="t">🔄 ${esc(nmOf(viewAgent))} roda no ${esc(m.nome || m.id)} — recebe as mesmas regras e skills da equipe</b>
    ${tipo === 'skills' ? `As skills abaixo são <b>copiadas</b> para <code>${esc(m.pasta || '.agents/skills')}</code> na pasta dele. Codex, Gemini, Cursor e Copilot seguem o mesmo padrão de skills (pasta com SKILL.md) e carregam de lá sozinhos.
    <ul><li>Bloqueadas nas permissões dele não são copiadas, a não ser que você libere (abaixo).</li><li>Criar, editar, ativar ou remover aqui sincroniza na hora. Alguns motores só percebem ao reiniciar o agente.</li><li>A pasta fica fora do git (nunca entra em commit).</li></ul>
    <span class="note" style="margin:0">Última sincronização: ${s ? `${haQuanto(s.quando)} · ${s.n} skill(s)` : 'ainda não sincronizado'}</span><br>
    <button class="sb" data-sk="sync">Sincronizar agora</button> <button class="sb" data-sk="sync-todos" title="Todos os agentes deste andar que rodam em outros motores">Sincronizar todos os motores do andar</button>`
    : `Ao subir, ele recebe por escrito:<ul><li><b>Regras do projeto</b>: os CLAUDE.md/AGENTS.md da pasta dele e das pastas acima.</li><li><b>PROIBIDO</b>: as mesmas regras de bloqueio da equipe (arquivos sensíveis, comandos, outros andares). Push, merge e deploy só com a sua autorização via Boss.</li><li><b>Skills</b>: as mesmas da equipe, sincronizadas em <code>.agents/skills</code> (aba Skills).</li></ul>
    Ele também roda no modo que pede aprovação antes de executar comandos (você aprova pela aba Tela).
    <span class="note" style="margin:4px 0 0;display:block">Atenção: no Claude as proibições são bloqueio técnico. Nos outros motores são orientação + aprovação manual. Para o que é crítico (push, merge, segredos), prefira agentes Claude.</span>`}</div>`;
}
function renderSkills() {
  const d = skData, box = document.getElementById('scrSkills'); if (!d?.fontes) { box.innerHTML = '<div class="note">' + esc(d?.erro || 'sem dados') + '</div>'; return; }
  const total = d.fontes.reduce((n, f) => n + f.skills.filter((x) => !x.bloqueada).length, 0);
  const linha = (f, x) => `<div class="sk ${x.desativada || x.bloqueada ? 'off' : ''}"><div><b>${esc(x.plugin ? x.plugin + ':' + x.nome : x.nome)}</b>${x.desativada ? '<span class="bdg">desativada</span>' : ''}${x.bloqueada ? '<span class="bdg bad" title="Bloqueada pelas regras de permissão deste agente/projeto">bloqueada</span>' : ''}${x.liberada ? '<span class="bdg on" title="Bloqueada pelas regras do projeto, mas você liberou para este agente">liberada por você</span>' : ''}${x.plugin && !x.ativo ? '<span class="bdg">plugin desligado</span>' : ''}
      <div class="sm">${esc(x.descricao || '(sem descrição)')}</div></div>
    <div class="bt"><button class="sb" data-sk="ver" data-arq="${esc(x.arquivo)}">ver</button>${x.bloqueada && d.agente.id !== 'boss' ? `<button class="sb" data-sk="liberar" data-skn="${esc(x.plugin ? x.plugin + ':' + x.nome : x.nome)}" title="Libera só para este agente">liberar</button>` : ''}${x.liberada ? `<button class="sb" data-sk="bloquear" data-skn="${esc(x.plugin ? x.plugin + ':' + x.nome : x.nome)}">bloquear de novo</button>` : ''}${f.editavel ? `${x.desativada ? '' : `<button class="sb" data-sk="editar" data-arq="${esc(x.arquivo)}" data-esc="${f.escopo}" data-nome="${esc(x.pasta)}">editar</button>`}<button class="sb" data-sk="${x.desativada ? 'ativar' : 'desativar'}" data-esc="${f.escopo}" data-nome="${esc(x.pasta)}">${x.desativada ? 'ativar' : 'desativar'}</button><button class="sb" data-sk="remover" data-esc="${f.escopo}" data-nome="${esc(x.pasta)}">remover</button>` : `<button class="sb" data-sk="copiar" data-arq="${esc(x.arquivo)}" data-nome="${esc(x.pasta || x.nome)}" title="Copia para as skills só deste agente (aí dá para editar)">copiar p/ este agente</button>`}</div></div>`;
  const blq = [...new Set(d.fontes.flatMap((f) => f.skills.filter((x) => x.bloqueada).map((x) => x.plugin ? x.plugin + ':' + x.nome : x.nome)))], lib = [...new Set(d.fontes.flatMap((f) => f.skills.filter((x) => x.liberada).map((x) => x.nome)))];
  const avisoBlq = blq.length || lib.length ? `<div class="motorBox" style="border-color:var(--blocked)"><b class="t">${blq.length ? `🔒 ${blq.length} skill(s) bloqueada(s) para ${esc(nmOf(d.agente.id))}${lib.length ? ` · ${lib.length} liberada(s) por você` : ''}` : `🔓 ${lib.length} skill(s) liberada(s) por você para ${esc(nmOf(d.agente.id))}`}</b>
    ${blq.length ? `Bloqueadas pelas regras de permissão do projeto (geralmente por segurança): ${blq.map((n) => `<code>${esc(n)}</code>`).join(' ')}.` : ''}
    ${!blq.length ? '' : d.agente.id === 'boss' ? 'O Boss sempre segue as regras do projeto.' : `${d.agente.motor ? 'Elas não são copiadas para o motor dele. ' : ''}Se quiser, use <b>liberar</b> na skill: vale só para este agente, os outros continuam bloqueados.`}${lib.length ? `${blq.length ? '<br>' : ''}Liberadas (estavam bloqueadas pelas regras do projeto): ${lib.map((n) => `<code>${esc(n)}</code>`).join(' ')}. Use <b>bloquear de novo</b> na skill para desfazer.` : ''}</div>` : '';
  box.innerHTML = caixaMotor(d.agente.motor, 'skills') + avisoBlq + `<div class="ssAct"><button class="sb pri" data-sk="nova" data-esc="agente">＋ Nova skill só deste agente</button><button class="sb" data-sk="nova" data-esc="equipe">＋ Nova skill para a equipe toda</button>
      <p class="note">${total} skill(s) disponível(is) para ${esc(nmOf(d.agente.id))} (${d.agente.motor ? 'motor' : 'conta'} ${esc(d.agente.conta)}).${d.agente.motor ? '' : ' Criar, editar ou ativar vale nas próximas mensagens, sem reiniciar.'}</p></div>
    ${d.fontes.map((f, i) => { const itens = [...f.skills, ...(f.desativadas || [])]; return `<details class="fonte" ${i < 2 || itens.length < 8 ? 'open' : ''}><summary><b>${esc(f.rotulo)}</b><span class="note">${itens.length} · <code title="${esc(f.pasta)}">${esc(tidy(f.pasta))}</code></span></summary>
      ${itens.length ? itens.map((x) => linha(f, x)).join('') : '<div class="sk"><div class="sm">nenhuma ainda</div></div>'}</details>`; }).join('')}`;
}
function skillEditor({ titulo, esc: escopo, nome = '', descricao = '', conteudo = '', travarNome = false }) {
  const bg = document.createElement('div'); bg.className = 'mbg';
  bg.innerHTML = `<div class="mdl wide frm" role="dialog" aria-modal="true"><h4>${esc(titulo)}</h4>
    <div class="lin"><div><label>Nome (vira /nome)</label><input id="skN" value="${esc(nome)}" ${travarNome ? 'readonly' : ''} placeholder="ex.: revisar-sql"></div>
    <div><label>Para quem</label><select id="skE"><option value="agente" ${escopo !== 'equipe' ? 'selected' : ''}>só ${esc(nmOf(viewAgent))}</option><option value="equipe" ${escopo === 'equipe' ? 'selected' : ''}>a equipe toda deste andar</option></select></div></div>
    <label>Quando usar (descrição — o agente decide usar a skill por ela)</label><input id="skD" value="${esc(descricao)}" placeholder="ex.: Use ao revisar migrations ou consultas SQL do backend">
    <label>Instruções da skill (Markdown)</label><textarea id="skC" rows="16" placeholder="Passo a passo, regras, comandos, exemplos…">${esc(conteudo)}</textarea>
    <small>Dica: uma skill boa diz quando usar, os passos e o que NÃO fazer. Pode colar um SKILL.md inteiro (com --- no topo).</small>
    <div class="mact"><button class="mc">Cancelar</button><button class="mo">Salvar skill</button></div></div>`;
  const fim = () => { bg.classList.add('out'); setTimeout(() => bg.remove(), 150); };
  bg.addEventListener('click', async (e) => {
    if (e.target === bg || e.target.classList.contains('mc')) return fim();
    if (!e.target.classList.contains('mo')) return;
    const r = await post('/skills', { agent: viewAgent, action: 'salvar', escopo: bg.querySelector('#skE').value, nome: bg.querySelector('#skN').value.trim(), descricao: bg.querySelector('#skD').value, conteudo: bg.querySelector('#skC').value }).catch((er) => ({ ok: false, out: er.message }));
    if (!r.ok) return avisa('Não salvou', r.out || 'falhou');
    fim(); document.getElementById('sendSt').textContent = r.out; loadSkills(viewAgent);
    const quem = bg.querySelector('#skE').value === 'equipe' ? null : viewAgent; if (quem && chars.get(quem)) { const c = chars.get(quem); say(c, { kind: 'servico', text: 'aprendi a skill ' + bg.querySelector('#skN').value.trim() + ' ✓' }, 3500); c.hopT = 1.2; }
  });
  document.body.appendChild(bg); setTimeout(() => bg.querySelector(travarNome ? '#skD' : '#skN').focus(), 30);
}
const separaSkill = (t) => { const m = t.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/); if (!m) return { descricao: '', corpo: t }; const d = (m[1].match(/^description:\s*(.*)$/m) || [])[1] || ''; const outros = m[1].split('\n').filter((l) => !/^(name|description):/.test(l)).join('\n').trim(); return { descricao: d.replace(/^["']|["']$/g, ''), corpo: outros ? `---\n${m[1]}\n---\n${m[2]}` : m[2].replace(/^\n+/, '') }; };
document.getElementById('scrSkills').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-sk]'); if (!b) return;
  const act = b.dataset.sk, arq = b.dataset.arq, escopo = b.dataset.esc, nome = b.dataset.nome;
  const ler = () => fetch('/skill?' + qs({ p: PROJECT, agent: viewAgent, arquivo: arq }), { cache: 'no-store' }).then((r) => r.text());
  if (act === 'liberar' || act === 'bloquear') {
    const sk = b.dataset.skn;
    if (act === 'liberar' && !(await confirma(`Liberar a skill ${sk} para ${nmOf(viewAgent)}?`, `Ela está bloqueada pelas regras de permissão do projeto, normalmente por segurança. Liberando, só ${nmOf(viewAgent)} passa a poder usá-la${skData?.agente?.motor ? ' (e ela é copiada para o motor dele)' : ''}; os outros agentes continuam bloqueados. Vale quando ele reiniciar. Dá para bloquear de novo a qualquer momento.`, true, 'Liberar'))) return;
    const r = await post('/skills', { agent: viewAgent, action: act, nome: sk }).catch((er) => ({ ok: false, out: er.message }));
    if (!r.ok) avisa('Não deu certo', r.out || 'falhou'); else document.getElementById('sendSt').textContent = r.out; return loadSkills(viewAgent);
  }
  if (act === 'sync' || act === 'sync-todos') { b.disabled = true; b.textContent = 'sincronizando…'; const r = await post('/skills', { agent: viewAgent, action: 'sincronizar', todos: act === 'sync-todos' }).catch((er) => ({ ok: false, out: er.message })); if (!r.ok) avisa('Não sincronizou', r.out || 'falhou'); else document.getElementById('sendSt').textContent = r.out; return loadSkills(viewAgent); }
  if (act === 'nova') return skillEditor({ titulo: 'Nova skill', esc: escopo });
  if (act === 'ver') { const t = await ler(); return modal({ title: nome || 'SKILL.md', text: t.length > 6000 ? t.slice(0, 6000) + '\n…' : t, info: true }); }
  if (act === 'editar') { const t = await ler(), sp = separaSkill(t); return skillEditor({ titulo: 'Editar skill', esc: escopo, nome, descricao: sp.descricao, conteudo: sp.corpo, travarNome: true }); }
  if (act === 'remover' && !(await confirma(`Remover a skill ${nome}?`, 'Ela sai deste agente (fica guardada em .orquestra/skills/.lixeira).', true, 'Remover'))) return;
  const body = { agent: viewAgent, action: act, escopo: escopo || 'agente', nome };
  if (act === 'copiar') { body.de = arq; body.escopo = 'agente'; }
  const r = await post('/skills', body).catch((er) => ({ ok: false, out: er.message }));
  if (!r.ok) avisa('Não deu certo', r.out || 'falhou'); else document.getElementById('sendSt').textContent = r.out;
  loadSkills(viewAgent);
});

// ---------------- instruções de cada agente ----------------
async function loadInstr(id) {
  const box = document.getElementById('scrInstr'); box.innerHTML = '<div class="note">carregando…</div>';
  let d; try { d = await fetch('/agente?' + qs({ p: PROJECT, agent: id }), { cache: 'no-store' }).then((r) => r.json()); } catch (e) { box.innerHTML = 'erro: ' + esc(e.message); return; }
  const a = d.agente; if (!a) { box.innerHTML = '<div class="note">Este agente não está na equipe deste andar (dev extra, por exemplo).</div>'; return; }
  setTimeout(() => { const sel = document.getElementById('inC'); if (sel) sel.onchange = () => { document.getElementById('inML').innerHTML = modelosDe(d.contas, sel.value).map((m) => `<option value="${esc(m)}">`).join(''); document.getElementById('inM').value = ''; }; }, 0);
  const dica = a.tipo === 'boss' ? 'É o CLAUDE.md do Boss: o que ele sabe do projeto, o fluxo e as regras. Vale ao reiniciar o Boss ou renovar o contexto.' : a.tipo === 'dev' ? 'Instruções EXTRAS deste dev, além do protocolo de todos os devs (ex.: padrões do repo, cuidados, o que nunca mexer). Vale quando ele reiniciar.' : 'É o CLAUDE.md deste especialista: o que ele faz, como, quando avisar quem. Vale quando ele reiniciar ou renovar o contexto.';
  box.innerHTML = caixaMotor(a.motor ? { id: a.motor, nome: a.motorNome || a.motor, sync: a.sync } : null, 'instr') + `<div class="frm"><div class="lin" style="margin-bottom:10px"><div><label style="margin-top:0">${a.tipo === 'boss' ? 'Conta do Claude' : 'Conta / motor de IA'}</label><select id="inC">${opcoesConta(d.contas, a.conta, a.tipo === 'boss')}</select></div>
      <div><label style="margin-top:0">Modelo <span class="note" style="margin:0">(vazio = padrão)</span></label><input id="inM" list="inML" value="${esc(a.modelo || '')}" placeholder="padrão do motor"><datalist id="inML">${modelosDe(d.contas, a.conta).map((m) => `<option value="${esc(m)}">`).join('')}</datalist></div>
      <div style="flex:none;align-self:end"><button class="sb" data-in="conta">Salvar e aplicar</button></div></div>
    <p class="note" style="margin:0 0 8px">${esc(dica)}<br><code>${esc(a.arquivo)}</code></p>
    <textarea id="inT" rows="24" placeholder="${a.tipo === 'dev' ? 'ex.: Neste repo use sempre os componentes de src/ui; nunca altere as migrations antigas…' : ''}">${esc(a.instrucoes)}</textarea>
    <div class="mact" style="margin-top:10px"><button class="sb" data-in="salvar" title="Só grava — vale da próxima vez que ele subir">Só salvar</button><button class="sb pri" data-in="reiniciar">Salvar e aplicar agora</button></div></div>`;
}
document.getElementById('scrInstr').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-in]'); if (!b) return;
  if (b.dataset.in === 'conta') { const r0 = await post('/agente', { agent: viewAgent, action: 'conta-modelo', conta: document.getElementById('inC').value, modelo: document.getElementById('inM').value }).catch((er) => ({ ok: false, out: er.message })); if (!r0.ok) return avisa('Não salvou', r0.out); return aplicarAprendizado(viewAgent, 'a nova conta/modelo'); }
  const r = await post('/agente', { agent: viewAgent, action: 'instrucoes', texto: document.getElementById('inT').value }).catch((er) => ({ ok: false, out: er.message }));
  if (!r.ok) return avisa('Não salvou', r.out || 'falhou');
  document.getElementById('sendSt').textContent = r.out;
  if (b.dataset.in === 'reiniciar') await aplicarAprendizado(viewAgent, 'as novas instruções');
});

// aplicar instruções/skills: avisa, o boneco sai pela porta, o agente reinicia e volta
async function aplicarAprendizado(id, motivo) {
  const nm = nmOf(id), vivo = !!S.agents[id];
  if (!vivo) { document.getElementById('sendSt').textContent = `${nm} está fora do ar — vale quando ele for chamado`; return; }
  if (S.agents[id].status === 'working' && !(await confirma(`${nm} está trabalhando agora`, 'Aplicar agora interrompe o que ele está fazendo. Continuar?', true, 'Aplicar agora'))) return;
  await modal({ title: `${nm} vai aprender ${motivo}`, text: `Ele sai da sala por um instante para carregar ${motivo} e já volta para a mesa.${id === 'boss' ? ' (O Boss reinicia no terminal do andar.)' : ''}`, info: true });
  document.getElementById('screen').style.display = 'none'; clearInterval(screenTimer); viewAgent = null;
  aprender(id, motivo);
  const r = await post('/agent', { agent: id, action: 'restart' }).catch((er) => ({ ok: false, out: er.message }));
  const c = chars.get(id); if (c) { c.saiuDoAr = true; setTimeout(() => { c.podeVoltar = true; }, 6000); }
  document.getElementById('sendSt').textContent = r.ok ? `${nm} voltou com ${motivo}` : (r.out || 'não reiniciou');
  if (!r.ok) { if (c) c.podeVoltar = true; avisa('Não deu para aplicar agora', r.out || 'falhou'); }
}

// ---------------- novo agente ----------------
document.getElementById('cards').addEventListener('click', async (e) => {
  if (e.target.id !== 'novoAg') return; e.stopPropagation();
  let d = { repos: [] }; try { d = await fetch('/agente?' + qs({ p: PROJECT }), { cache: 'no-store' }).then((r) => r.json()); } catch {}
  const livres = d.repos.filter((r) => !r.temDev);
  const bg = document.createElement('div'); bg.className = 'mbg';
  bg.innerHTML = `<div class="mdl wide frm" role="dialog" aria-modal="true"><h4>Novo agente · ${esc(UI.title || PROJECT)}</h4>
    <label>Tipo</label><select id="naT"><option value="especialista">Especialista — faz um papel (segurança, documentação, banco, performance…) e não altera código</option>${livres.length ? '<option value="dev">Dev residente de um repositório — recebe tarefas do Boss e altera código na mesa dele</option>' : ''}</select>
    <div id="naEsp"><div class="lin"><div><label>Nome (curto, sem espaço)</label><input id="naN" placeholder="ex.: seguranca"></div><div><label>Título</label><input id="naTi" placeholder="ex.: Segurança"></div><div style="flex:.4"><label>Cor</label><input id="naC" type="color" value="#a78bfa" style="height:34px;padding:2px"></div></div>
      <label>Descrição curta (aparece no card)</label><input id="naD" placeholder="ex.: revisa vulnerabilidades e dados sensíveis"></div>
    <div id="naDev" style="display:none"><label>Repositório</label><select id="naR">${livres.map((r) => `<option>${esc(r.nome)}</option>`).join('')}</select></div>
    <label>O que ele deve fazer, como e quando (as instruções dele)</label>
    <textarea id="naI" rows="11" placeholder="Ex.: Você é o especialista em segurança. Quando o Boss pedir, revise o diff da tarefa procurando: segredos no código, SQL injection, XSS, dados pessoais em log, permissões faltando. Responda com uma lista por gravidade (alta/média/baixa), arquivo e linha, e a correção sugerida. Nunca rode scanners que façam requisições para fora."></textarea>
    <div class="lin"><div><label>Conta / motor de IA</label><select id="naCo">${opcoesConta(d.contas, (d.contas || []).some((c) => c.n === '2') ? '2' : '1')}</select></div><div><label>Modelo <span class="note" style="margin:0">(vazio = padrão)</span></label><input id="naM" list="naML" value="sonnet"><datalist id="naML">${modelosDe(d.contas, '2').map((m) => `<option value="${esc(m)}">`).join('')}</datalist></div></div>
    <div class="ck" id="naQaW"><input type="checkbox" id="naQa"><label for="naQa" style="margin:0">Pode pedir validação ao QA</label></div>
    <div class="ck"><input type="checkbox" id="naS" checked><label for="naS" style="margin:0">Já chamar para o escritório</label></div>
    <small>O Boss fica sabendo do novo agente. Depois dá para ajustar as instruções e as skills dele no card (Conversa → Instruções / Skills).</small>
    <div class="mact"><button class="mc">Cancelar</button><button class="mo">Criar agente</button></div></div>`;
  const $ = (x) => bg.querySelector(x);
  const tipo = () => $('#naT').value;
  $('#naCo').onchange = () => { const ms = modelosDe(d.contas, $('#naCo').value); $('#naML').innerHTML = ms.map((m) => `<option value="${esc(m)}">`).join(''); $('#naM').value = ms[0] || ''; };
  $('#naT').onchange = () => { const dev = tipo() === 'dev'; $('#naEsp').style.display = dev ? 'none' : ''; $('#naDev').style.display = dev ? '' : 'none'; $('#naQaW').style.display = dev ? 'none' : ''; $('#naI').placeholder = dev ? 'Ex.: Neste repo siga o padrão de pastas por feature, use os componentes de src/ui e sempre rode npm test antes de passar ao QA.' : $('#naI').placeholder; };
  $('#naN').oninput = () => { if (!$('#naTi').dataset.mexeu) $('#naTi').value = $('#naN').value.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()); };
  $('#naTi').oninput = () => { $('#naTi').dataset.mexeu = 1; };
  const fim = () => { bg.classList.add('out'); setTimeout(() => bg.remove(), 150); };
  bg.addEventListener('click', async (ev) => {
    if (ev.target === bg || ev.target.classList.contains('mc')) return fim();
    if (!ev.target.classList.contains('mo')) return;
    ev.target.disabled = true; ev.target.textContent = 'criando…';
    const r = await post('/agente', { action: 'novo', tipo: tipo(), nome: $('#naN').value.trim(), titulo: $('#naTi').value, descricao: $('#naD').value, cor: $('#naC').value, repo: $('#naR')?.value, instrucoes: $('#naI').value, conta: $('#naCo').value, modelo: $('#naM').value, qa: $('#naQa').checked, subir: $('#naS').checked }).catch((er) => ({ ok: false, out: er.message }));
    ev.target.disabled = false; ev.target.textContent = 'Criar agente';
    if (!r.ok) return avisa('Não criei o agente', r.out || 'falhou');
    fim(); await avisa('Agente criado', r.out + '\n\nA sala vai recarregar para ele ganhar uma mesa.'); location.reload();
  });
  document.body.appendChild(bg); setTimeout(() => $('#naN').focus(), 30);
}, true);

// ---------------- configurações das sessões (por projeto) ----------------
document.getElementById('cfgBtn')?.addEventListener('click', async () => {
  let st = {}; try { st = await fetch('/settings?p=' + encodeURIComponent(PROJECT), { cache: 'no-store' }).then((r) => r.json()); } catch {}
  const opt = (v) => `<option value="nova" ${v !== 'continuar' ? 'selected' : ''}>Começar sessão nova (lê a memória .md, se tiver)</option><option value="continuar" ${v === 'continuar' ? 'selected' : ''}>Continuar a última sessão</option>`;
  const bg = document.createElement('div'); bg.className = 'mbg';
  bg.innerHTML = `<div class="mdl cfg" role="dialog" aria-modal="true"><h4>Configurações das sessões · ${esc(UI.title || PROJECT)}</h4>
    <label>Boss, ao rodar o atalho no terminal</label><select id="cfBoss">${opt(st.boss)}</select>
    <label>Equipe, ao subir</label><select id="cfEq">${opt(st.equipe)}</select><small>Continuar mantém tudo, mas o contexto cresce e cada mensagem fica mais cara.</small>
    <div class="ck"><input type="checkbox" id="cfMem" ${st.memoria !== false ? 'checked' : ''}><label for="cfMem" style="margin:0">Na sessão nova, ler a memória (<code>memoria.md</code>) do agente</label></div>
    <p class="note" style="margin-top:12px">Vale a partir da próxima vez que cada um subir. Os .md das sessões ficam em <code>.orquestra/relatorios/&lt;agente&gt;/sessoes</code>.</p>
    <div class="mact"><button class="mc">Cancelar</button><button class="mo">Salvar</button></div></div>`;
  const fim = () => { bg.classList.add('out'); setTimeout(() => bg.remove(), 150); };
  bg.addEventListener('click', async (e) => {
    if (e.target === bg || e.target.classList.contains('mc')) return fim();
    if (!e.target.classList.contains('mo')) return;
    const r = await post('/settings', { settings: { boss: bg.querySelector('#cfBoss').value, equipe: bg.querySelector('#cfEq').value, memoria: bg.querySelector('#cfMem').checked } }).catch((er) => ({ ok: false, out: er.message }));
    fim(); document.getElementById('sendSt').textContent = r.ok ? 'configurações salvas' : 'não salvou: ' + (r.out || '');
  });
  document.body.appendChild(bg);
});

function onActivity(a) {
  (chatCache[a.agent] ||= []).push(a);
  if (chatCache[a.agent].length > 150) chatCache[a.agent].shift();
  if (viewAgent === a.agent && viewTab === 'chat') renderChat();
  const c = chars.get(a.agent);
  if (!c) return;
  if (a.kind === 'tool') think(c, a.text);
  else if (a.role === 'agent' && c.mode === 'home') say(c, { kind: 'fala', text: a.text.replace(/\s+/g, ' ').slice(0, 170) + (a.text.length > 170 ? '…' : '') }, 7000);
}

function renderSide() {
  // equipe inteira (equipe.conf) + quem estiver vivo: quem caiu continua na lista, apagado, com o botão "chamar"
  const ids = [...new Set([...(S.team || []), ...Object.keys(S.agents)])].sort(byOrder);
  const side = document.getElementById('cards');
  if (!ids.length) { side.innerHTML = `<div class="sub" style="color:var(--muted)">Nenhum agente configurado.</div>`; return; }
  const grupos = [['lideranca', 'Liderança', ids.filter((i) => i === 'boss')], ['esp', 'Especialistas', ids.filter((i) => SPECIAL[i] || ['taiga', 'logs', 'qa', 'gitlab', 'github'].includes(i))], ['devs', 'Devs', ids.filter((i) => i !== 'boss' && !SPECIAL[i] && !['taiga', 'logs', 'qa', 'gitlab', 'github'].includes(i))]];
  const offCard = (id) => {
    const sp = SPECIAL[id], { repo } = parseId(id);
    const nm = id === 'boss' ? 'Boss' : sp ? sp.title : LABEL(repo);
    return `<div class="card off mini" data-id="${esc(id)}"><div class="top"><div class="sw" style="background:${hex(colorFor(id))};opacity:.35"></div>
      <div class="tt"><div class="nm" style="opacity:.6" title="${esc(nm)}">${esc(nm)}</div></div><span class="pill st-off">fora do ar</span>
      ${id === 'boss' ? `<button class="ab" data-cfg="boss" title="Instruções e skills">ajustar</button><button class="ab go" data-ag="start" data-agent="boss" title="Sobe o Boss no terminal do andar (com a equipe e os serviços). No Herdr: ${esc(UI.atalho || PROJECT)}">chamar</button>` : `<button class="ab" data-cfg="${esc(id)}" title="Instruções e skills">ajustar</button><button class="ab go" data-ag="start" data-agent="${esc(id)}">chamar</button>`}</div></div>`;
  };
  const card = (id) => {
    if (!S.agents[id]) return offCard(id);
    const a = S.agents[id], u = S.usage[id] || {}, { repo, slug } = parseId(id);
    const sp = SPECIAL[id];
    const nm = id === 'boss' ? 'Boss' : sp ? sp.title : LABEL(repo);
    const sub = id === 'boss' ? 'orquestra, divide e revisa' : sp ? sp.sub : slug ? 'extra · ' + slug : 'dev residente';
    const open = selected === id || a.status === 'working' || a.status === 'blocked';
    const acc = ACCTS.find((x) => x.id === (a.conta || u.conta));
    const conta = acc ? (acc.nome || (acc.email ? acc.email.split('@')[0] : acc.id)) : a.conta || u.conta || '';
    return `<div class="card ${a.status} ${selected === id ? 'sel' : ''} ${open ? '' : 'mini'}" data-id="${esc(id)}">
      <div class="top"><div class="sw" style="background:${hex(colorFor(id))}"></div>
        <div class="tt"><div class="nm" title="${esc(nm)}">${esc(nm)}</div>${open ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
        ${open ? '' : `<button class="ab" data-cfg="${esc(id)}" title="Instruções e skills">ajustar</button>`}${a.status === 'done' ? `<button class="pill st-done okp" data-ag="ok" data-agent="${esc(id)}" title="Clique para dar ok — volta para aguardando">terminou · ✓ ok</button>` : (a.pergunta && a.status !== 'blocked' ? `<button class="pill st-pergunta" data-ag="falar" data-agent="${esc(id)}" title="Ele terminou com uma pergunta para você — abrir a conversa">❗ quer falar com você</button>` : a.status === 'blocked' ? `<button class="pill st-blocked" data-ag="responder" data-agent="${esc(id)}" title="Ver a pergunta e responder">precisa de você · responder</button>` : `<span class="pill st-${a.status}">${STATUS_TXT[a.status] || a.status}</span>`)}</div>
      ${open ? `${a.title ? `<div class="task" title="${esc(a.title)}">${esc(clip(a.title, 90))}</div>` : ''}
      <div class="chips"><span class="chip tela" data-screen="${esc(id)}">conversa</span><span class="chip tela" data-cfg="${esc(id)}" title="Instruções e skills">ajustar</span>${conta ? `<span class="chip" title="${esc(acc?.email || '')}">${esc(conta)}</span>` : ''}${a.model || u.model ? `<span class="chip">${esc(String(a.model || u.model).replace('claude-', ''))}</span>` : ''}${a.ctx != null ? `<span class="chip" title="contexto usado">ctx ${a.ctx}%</span>` : ''}${id !== 'boss' && S.rework[id] ? `<span class="chip">${S.rework[id]} ajuste(s)</span>` : ''}</div>
      ${id === 'boss' ? `<div class="acts">${a.status === 'starting' ? `<button class="ab stop" data-ag="interromper" data-agent="boss" title="Manda Ctrl-C no terminal do andar: para a subida travada e descarta o que foi digitado nele">parar subida (Ctrl-C)</button>` : ''}<button class="ab" data-ag="herdr" data-agent="boss" title="Abre o terminal do Boss no app Herdr">Herdr</button><button class="ab" data-ag="restart" data-agent="boss" title="/exit e sobe de novo (contexto conforme ⚙)">reiniciar</button><button class="ab stop" data-ag="stop" data-agent="boss" title="/exit no Boss">dispensar</button></div>` : `<div class="acts"><button class="ab" data-ag="herdr" data-agent="${esc(id)}" title="Abre o terminal deste agente no app Herdr">Herdr</button><button class="ab" data-ag="restart" data-agent="${esc(id)}" title="encerra e sobe de novo com contexto limpo">reiniciar</button><button class="ab stop" data-ag="stop" data-agent="${esc(id)}">dispensar</button></div>`}
      ${!u.msgs ? '' : `<div class="stats"><div>Hoje<b>${fmtUsd(u.today?.cost)}</b></div><div>Tokens hoje<b>${fmtTok((u.today?.in || 0) + (u.today?.out || 0))}</b></div><div>Turnos<b>${a.turn}</b></div></div>`}` : ''}
    </div>`;
  };
  let html = grupos.filter(([, , l]) => l.length).map(([k, t, l]) => {
    const ativos = l.filter((i) => ['working', 'blocked'].includes(S.agents[i]?.status)).length;
    const fora = l.filter((i) => !S.agents[i]).length;
    return groupHead('side-' + k, t, `${l.length}${ativos ? ` · ${ativos} ativo(s)` : ''}${fora ? ` · ${fora} fora do ar` : ''}`) + (isFolded('side-' + k) ? '' : l.map(card).join(''));
  }).join('');
  html = `<button id="novoAg" title="Criar um agente novo neste andar">＋ Novo agente</button>` + html;
  if (html !== side.dataset.h) { side.dataset.h = html; side.innerHTML = html; }
}

// clicar numa mensagem: abre a conversa de quem falou, mostra a mensagem inteira e deixa responder (direto ou pelo Boss)
document.getElementById('feed').addEventListener('click', (ev) => {
  const it = ev.target.closest('[data-fi]'); if (!it) return; const e = feed[+it.dataset.fi]; if (!e) return;
  abrirMensagem(e);
});
let citacao = null;
async function abrirMensagem(e) {
  const quem = e.from === 'voce' ? (e.to || 'boss') : e.from;
  openScreen(quem, 'chat');
  citacao = e;
  const q = document.getElementById('scrQuote'), k = KIND[e.kind] || { label: e.kind, css: 'var(--accent)' };
  const hora = new Date(e.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const pinta = (t) => { q.style.display = 'block'; q.style.setProperty('--k', k.css); q.innerHTML = `<div class="qh"><span>${hora} · ${esc(nmOf(e.from))} → ${esc(nmOf(e.to))} · <b style="color:${k.css}">${esc(k.label)}</b></span><button id="qX" title="tirar a citação">✕</button></div><div class="qt">${mdLite(t)}</div>`; };
  pinta(e.text || '');
  montaVia(quem, true);
  document.getElementById('scrMsg').focus();
  // o feed guarda um resumo; a mensagem inteira está na conversa de quem recebeu
  try { const r = await fetch(`/mensagem?${qs({ p: PROJECT, para: e.to || 'boss', de: e.from || '', texto: (e.text || '').slice(0, 120) })}`, { cache: 'no-store' }).then((x) => x.json()); if (r.texto && citacao === e) pinta(r.texto); } catch {}
}
function montaVia(quem, comCitacao = false) {
  const sel = document.getElementById('scrVia'); if (!sel) return;
  const nm = nmOf(quem), vivo = !!S.agents[quem];
  sel.innerHTML = quem === 'boss' ? `<option value="boss">para o Boss</option>`
    : `<option value="direto">direto para ${esc(nm)}${vivo ? '' : ' (fora do ar)'}</option><option value="boss" ${vivo ? '' : 'selected'}>pelo Boss (ele analisa e fala com ${esc(nm)})</option>`;
  document.getElementById('scrMsg').placeholder = comCitacao ? `Responder sobre esta mensagem… (⌘+Enter envia)` : `Mensagem para ${nm}… (⌘+Enter envia)`;
}
async function enviaDoPainel() {
  const box = document.getElementById('scrMsg'), txt = box.value.trim(), quem = viewAgent; if (!txt || !quem) return;
  const via = document.getElementById('scrVia').value, nm = nmOf(quem), c = citacao;
  const ctx = c ? `Sobre a mensagem de ${nmOf(c.from)} para ${nmOf(c.to)} (${new Date(c.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}): "${(document.querySelector('#scrQuote .qt')?.innerText || c.text || '').slice(0, 1500)}"\n\n` : '';
  let alvo = quem, texto = ctx ? ctx + txt : txt;
  if (via === 'boss' && quem !== 'boss') { alvo = 'boss'; texto = `${ctx}O usuário quer falar com ${quem} (${nm}): ${txt}\n\nAnalise o pedido e, se fizer sentido, fale com ${quem} usando ../bin/hcp.sh send ${quem} "<mensagem>" — depois me dê um retorno curto.`; }
  const st = document.getElementById('sendSt');
  const r = await fetch('/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': S.token || '' }, body: JSON.stringify({ project: PROJECT, agent: alvo, text: texto }) });
  if (r.status === 409 && r.headers.get('X-Orq') === 'bloqueado') return abrirResposta(alvo, texto);
  if (!r.ok) { const m = await r.text(); if (r.status === 404 && alvo !== 'boss') { if (await confirma(`${nm} está fora do ar`, 'Quer mandar pelo Boss? Ele analisa e fala com ele (ou chama o agente).', false, 'Mandar pelo Boss')) { document.getElementById('scrVia').value = 'boss'; return enviaDoPainel(); } return; } return avisa('Não enviou', m); }
  box.value = ''; st.textContent = alvo === 'boss' && quem !== 'boss' ? `enviado ao Boss — ele vai falar com ${nm}` : `enviado para ${nmOf(alvo)}`;
  if (alvo === 'boss' && quem !== 'boss') { citacao = null; document.getElementById('scrQuote').style.display = 'none'; openScreen('boss', 'chat'); montaVia('boss'); }
}
document.getElementById('scrSend').addEventListener('click', enviaDoPainel);
document.getElementById('scrMsg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) enviaDoPainel(); });
document.getElementById('screen').addEventListener('click', (e) => { if (e.target.id === 'qX') { citacao = null; document.getElementById('scrQuote').style.display = 'none'; montaVia(viewAgent); } });

function renderFeed() {
  const el = document.getElementById('feed');
  const shown = feed.filter((e) => e.kind !== 'wait');
  const head = groupHead('feed', 'Mensagens da equipe', `${shown.length} · últimas 4`, false);
  if (isFolded('feed', false)) { el.innerHTML = head; return; }
  el.innerHTML = head + shown.slice(-4).map((e) => {
    const k = KIND[e.kind] || { label: e.kind, css: 'var(--accent)' };
    const nm = (id) => (id === 'boss' ? 'Boss' : id ? parseId(id).title : '?');
    const time = new Date(e.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `<div class="fi" style="--k:${k.css}" data-fi="${feed.indexOf(e)}" title="clique para abrir a conversa e responder"><div class="h">${time} · ${esc(nm(e.from))} → ${esc(nm(e.to))} · <b>${esc(k.label)}</b></div><div class="ft">${esc(clip(e.text, 140))}</div></div>`;
  }).join('');
}

// ---------------- servidores e portas ----------------
let srvOpen = false;
function renderSrv() {
  const el = document.getElementById('srvPanel');
  if (!srvOpen) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const defs = S.svcDefs || [], ports = S.ports || [], sv = S.services || {};
  const rodando = ports.length > 0 || Object.values(sv).some((x) => x.live);
  const html = `<div class="bar"><b>Servidores · ${esc(UI.brand || '')}</b><span class="note">${rodando ? `<span class="dot ok"></span>rodando` : '<span class="dot"></span>parado'}</span>
      <button data-sa="start" data-sn="*">Subir tudo</button><button data-sa="stop" data-sn="*">Parar tudo</button><button id="srvClose">fechar</button></div>
    <div class="sv">${defs.map((d) => { const live = sv[d.short]?.live; return `<div class="svr"><span class="dot ${live ? 'ok' : ''}"></span><b>${esc(d.short)}</b>${d.manual ? '<span class="chip">manual</span>' : ''}<code>${esc(d.cmd)}</code>
        <span class="act">${live ? `<button data-sa="restart" data-sn="${esc(d.name)}">reiniciar</button><button data-sa="stop" data-sn="${esc(d.name)}">parar</button>` : `<button data-sa="start" data-sn="${esc(d.name)}">subir</button>${d.stop ? `<button data-sa="stop" data-sn="${esc(d.name)}" title="roda o comando de parar (ex.: docker compose down)">derrubar</button>` : ''}`}</span></div>`; }).join('') || '<div class="note">Nenhum serviço em servicos.conf.</div>'}</div>
    <div class="bar" style="border-top:1px solid var(--line)"><b>Portas em uso</b><span class="note">processos e containers rodando dentro da pasta do projeto</span></div>
    <div class="sv">${(() => {
      if (!ports.length) return '<div class="note">Nenhuma porta aberta por este projeto.</div>';
      const grupos = {};
      for (const x of ports) { const k = x.kind === 'docker' ? 'd:' + (x.compose || x.name) : 'p:' + x.pid; (grupos[k] ||= []).push(x); }
      return Object.entries(grupos).map(([k, l]) => {
        const x0 = l[0], portas = l.map((x) => `<a href="http://localhost:${x.port}" target="_blank">:${x.port}</a>`).join(' ');
        if (k.startsWith('d:')) {
          const conts = [...new Map(l.map((x) => [x.id, x])).values()];
          return `<div class="pg"><div class="svr"><span class="chip">docker</span><b>${esc(x0.compose || x0.name)}</b><span class="note" style="margin:0">${esc(x0.where)}</span>
              <span class="act"><button data-pa="compose" data-pt="${esc(x0.compose)}" title="docker compose down: derruba o grupo inteiro">derrubar grupo</button></span></div>
            ${conts.map((c) => `<div class="svr sub2">${l.filter((x) => x.id === c.id).map((x) => `<a href="http://localhost:${x.port}" target="_blank">:${x.port}</a>`).join(' ')}<span>${esc(c.name)}</span><span class="act"><button data-pa="container" data-pt="${esc(c.id)}">parar</button></span></div>`).join('')}</div>`;
        }
        return `<div class="pg"><div class="svr"><span class="chip">processo</span>${portas}<b>${esc(x0.name)}</b><span class="note" style="margin:0">${esc(x0.where)} · pid ${x0.pid}</span><span class="act"><button data-pa="proc" data-pt="${x0.pid}">encerrar</button></span></div></div>`;
      }).join('');
    })()}</div>
    <div id="srvOut" class="note"></div>`;
  if (html !== el.dataset.h) { el.dataset.h = html; const out = document.getElementById('srvOut')?.textContent || ''; el.innerHTML = html; document.getElementById('srvOut').textContent = out; }
}
document.getElementById('srvPanel').addEventListener('click', async (e) => {
  if (e.target.id === 'srvClose') { srvOpen = false; renderSrv(); return; }
  const pb = e.target.closest('[data-pa]');
  if (pb) {
    const act = pb.dataset.pa, tg = pb.dataset.pt;
    const txt = act === 'compose' ? `Derrubar o grupo Docker "${tg}" inteiro (docker compose down)?` : act === 'container' ? 'Parar este container?' : `Encerrar o processo ${tg}?`;
    if (!(await confirma(act === 'compose' ? 'Derrubar grupo Docker' : act === 'container' ? 'Parar container' : 'Encerrar processo', txt, true, act === 'compose' ? 'Derrubar' : act === 'container' ? 'Parar' : 'Encerrar'))) return;
    const out = document.getElementById('srvOut'); out.textContent = '…'; pb.disabled = true;
    try { const r = await fetch('/port', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': S.token || '' }, body: JSON.stringify({ project: PROJECT, action: act, target: tg }) }); const j = await r.json().catch(() => ({})); out.textContent = j.out || (r.ok ? 'ok' : 'falhou'); } catch (err) { out.textContent = 'erro: ' + err.message; }
    pb.disabled = false; return;
  }
  const b = e.target.closest('[data-sa]'); if (!b) return;
  const action = b.dataset.sa, name = b.dataset.sn;
  const alvo = name === '*' ? 'TODOS os serviços' : name.replace(/^srv-/, '');
  if (action !== 'start' && !(await confirma(`${action === 'stop' ? 'Parar' : 'Reiniciar'} ${alvo}?`, action === 'stop' ? 'Roda o comando de parar configurado (ex.: docker compose down) e fecha o terminal do serviço.' : 'Para e sobe de novo.', action === 'stop', action === 'stop' ? 'Parar' : 'Reiniciar'))) return;
  const out = document.getElementById('srvOut'); out.textContent = '…';
  try {
    const r = await fetch('/service', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': S.token || '' }, body: JSON.stringify({ project: PROJECT, name, action }) });
    const j = await r.json().catch(async () => ({ out: await r.text() }));
    out.textContent = j.out || 'ok';
  } catch (err) { out.textContent = 'erro: ' + err.message; }
});
document.getElementById('srv').addEventListener('click', () => { srvOpen = !srvOpen; renderSrv(); });

// na sala, custo e nº de agentes ficam no Painel (o topo mostra as contas)
['kCost', 'kActive'].forEach((k) => { const e = document.getElementById(k); if (e) e.parentElement.style.display = 'none'; });
function renderAccounts() {
  const el = document.getElementById('accts'); if (!el) return;
  const usadas = new Set(Object.values(S.agents || {}).map((a) => a.conta).filter(Boolean));
  const html = contasUnicas().filter((a) => a.ids.some((i) => usadas.has(i)) || a.users.some((u) => u.project === PROJECT)).map((a) => `<span class="acct" data-go-uso="1" title="${esc(a.email || a.id)} — clique para ver o uso">${esc(a.nome || (a.email ? a.email.split('@')[0] : a.id))} <i class="mb"><i style="width:${Math.min(100, a.h5 || 0)}%;background:${corUso(a.h5 || 0)}"></i></i> ${a.h5 ?? '–'}%</span>`).join('');
  if (html !== el.dataset.h) { el.dataset.h = html; el.innerHTML = html; }
}
document.getElementById('accts')?.addEventListener('click', () => { subTab = 'uso'; try { localStorage.setItem('estudio.sub', 'uso'); } catch {} document.querySelector('.tabs button[data-tab="panel"]')?.click(); });

function renderHeader() {
  const today = Object.values(S.usage).reduce((s, u) => s + (u.today?.cost || 0), 0);
  document.getElementById('kCost').textContent = fmtUsd(today);
  document.getElementById('kActive').textContent = Object.keys(S.agents).length;
  const sv = S.services || {};
  const ports = S.ports || [];
  document.getElementById('srv').innerHTML = `<button class="srvbtn" title="Servidores e portas"><span class="dot ${ports.length || Object.values(sv).some((x) => x.live) ? 'ok' : ''}"></span>servidores${ports.length ? ' · ' + ports.slice(0, 4).map((x) => ':' + x.port).join(' ') + (ports.length > 4 ? ' …' : '') : ''}</button>`;
  renderSrv();
  document.getElementById('hcDot').className = 'dot ' + (S.hcOk ? 'ok' : 'bad');
  document.getElementById('hcTxt').textContent = S.hcOk ? 'Herdr conectado' : 'sem Herdr (hc)';
}

let subTab = (() => { try { return localStorage.getItem('estudio.sub') || 'uso'; } catch { return 'uso'; } })();
const hhmm = (t) => (t ? new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '–');
const falta = (t) => { if (!t) return ''; const m = Math.max(0, Math.round((t - Date.now()) / 60000)); return m >= 1440 ? `faltam ${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `faltam ${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `faltam ${m} min`; };
const corUso = (v) => (v >= 90 ? 'var(--blocked)' : v >= 70 ? '#f2c14e' : 'var(--done)');
const nmA = (id) => (id === 'boss' ? 'Boss' : SPECIAL[id]?.title || (id ? parseId(id).title : '?'));
function contasUnicas() {
  const g = {};
  for (const a of ACCTS) { const k = a.email || a.id; if (!g[k]) g[k] = { ...a, ids: [a.id], users: [...a.users] }; else { g[k].ids.push(a.id); g[k].users.push(...a.users); g[k].tokToday += a.tokToday || 0; if ((a.metersAt || 0) > (g[k].metersAt || 0)) Object.assign(g[k], { h5: a.h5, d7: a.d7, metersAt: a.metersAt }); g[k].reset5 = g[k].reset5 || a.reset5; g[k].reset7 = g[k].reset7 || a.reset7; } }
  return Object.values(g);
}
const rotConta = (c) => c.provedor && c.provedor !== 'claude' ? `${c.nome || c.nomeProvedor || c.provedor}` : `${c.nome || 'Claude conta ' + c.n}${c.email ? ' — ' + c.email : ' (sem login)'}`;
function opcoesConta(contas, atual, soClaude = false) { const lista = [...(contas || [])]; if (atual && !/^\d+$/.test(String(atual)) && !lista.some((c) => c.id === String(atual))) lista.push({ id: String(atual), provedor: String(atual), nomeProvedor: String(atual) + ' (conta não cadastrada — adicione em Painel → Uso)' }); return lista.filter((c) => !soClaude || c.provedor === 'claude').map((c) => { const v = c.provedor === 'claude' ? c.n : c.id; return `<option value="${esc(v)}" ${String(atual) === String(v) ? 'selected' : ''}>${esc(rotConta(c))}</option>`; }).join(''); }
function modelosDe(contas, v) { const c = (contas || []).find((x) => (x.provedor === 'claude' ? x.n : x.id) === String(v)); return c?.modelos || ['sonnet', 'haiku', 'opus']; }
async function carregaContasClaude() {
  const el = document.getElementById('gContasClaude'); if (!el) return;
  let R0 = { contas: [] }; try { R0 = await fetch('/contas', { cache: 'no-store' }).then((r) => r.json()); } catch { return; }
  const C = R0.contas || (Array.isArray(R0) ? R0 : []); window.__motoresDisp = R0.disponiveis || [];
  const emails = C.map((c) => c.email).filter(Boolean), dup = emails.filter((e, i) => emails.indexOf(e) !== i);
  el.innerHTML = `<h3>Contas e motores de IA <span class="note" style="font-weight:400">quem está logado em cada um e quem usa</span></h3>
    <table><tr><th>Conta</th><th>Login</th><th>Pasta</th><th>Quem usa</th><th></th></tr>${C.map((c) => `<tr>
      <td><b>${esc(c.nome || (c.provedor === 'claude' ? `Claude · conta ${c.n}` : c.nomeProvedor || c.id))}</b> <button class="sb" data-cc="renomear" data-id="${esc(c.id)}" data-nome="${esc(c.nome || '')}" title="dar um nome a esta conta" style="padding:1px 6px">✎</button>${c.nome ? `<div class="note" style="margin:0">${esc(c.provedor === 'claude' ? 'Claude · conta ' + c.n : c.nomeProvedor || c.id)}</div>` : ''}${c.instalado === false ? '<div class="note" style="margin:0;color:var(--blocked)">não instalado</div>' : ''}</td>
      <td>${c.provedor !== 'claude' ? (c.logada ? '<span style="color:#4fd18b">logado ✓</span>' : '<span style="color:var(--blocked)">sem login</span>') : c.logada ? `${esc(c.email)}${dup.includes(c.email) ? ' <span class="bdg bad" title="outra conta está logada no mesmo e-mail">repetida</span>' : ''}${c.org ? `<div class="note" style="margin:0">${esc(c.org)}</div>` : ''}` : '<span style="color:var(--blocked)">sem login</span>'}</td>
      <td><code>${esc(c.pasta)}</code></td>
      <td style="max-width:320px">${c.uso.length ? esc([...new Set(c.uso.map((u) => u.projeto))].map((pj) => `${pj}: ${c.uso.filter((u) => u.projeto === pj).length}`).join(' · ')) : '<span class="note">ninguém</span>'}</td>
      <td style="white-space:nowrap">${c.instalado === false && c.provedor !== 'claude' ? `<button class="sb pri" data-cc="instalar" data-id="${esc(c.id)}">instalar</button>` : `<button class="sb pri" data-cc="login" data-n="${esc(c.id)}">${c.logada ? 'trocar login' : 'entrar'}</button>`}${c.id !== 'conta1' ? ` <button class="sb" data-cc="remover" data-id="${esc(c.id)}">remover</button>` : ''}</td></tr>`).join('')}</table>
    <div class="gbar" style="margin-top:8px"><button class="sb" data-cc="adicionar">＋ Adicionar conta / motor</button><span class="note" style="margin:0">Para mudar qual conta/modelo um agente usa: abra o agente → <b>ajustar</b> → Instruções.</span></div>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cc]'); if (!b) return;
  const a = b.dataset.cc;
  if (a === 'login') return abrirLoginConta(b.dataset.n);
  if (a === 'renomear') {
    const bg = document.createElement('div'); bg.className = 'mbg';
    bg.innerHTML = `<div class="mdl frm" role="dialog" aria-modal="true"><h4>Nome da conta</h4><label>Como você quer chamar esta conta</label><input id="rnN" maxlength="30" value="${esc(b.dataset.nome)}" placeholder="ex.: Pessoal, Trabalho, Cliente"><small>Aparece no topo, no painel e na escolha de conta dos agentes.</small><div class="mact"><button class="mc">Cancelar</button><button class="mo">Salvar</button></div></div>`;
    const nome = await new Promise((res) => { bg.addEventListener('click', (ev) => { if (ev.target === bg || ev.target.classList.contains('mc')) { bg.remove(); res(null); } if (ev.target.classList.contains('mo')) { const v = bg.querySelector('#rnN').value; bg.remove(); res(v); } }); document.body.appendChild(bg); setTimeout(() => bg.querySelector('#rnN').select(), 30); });
    if (nome === null) return;
    const r = await post('/contas', { action: 'renomear', id: b.dataset.id, nome }); document.getElementById('sendSt').textContent = r.out || ''; return carregaContasClaude();
  }
  if (a === 'medir') { b.disabled = true; b.textContent = 'medindo… (~15 s)'; const r = await post('/contas', { action: 'medir', id: b.dataset.id }).catch((er) => ({ ok: false, out: er.message })); b.disabled = false; b.textContent = 'medir agora'; if (!r.ok) avisa('Não deu para medir', r.out); else document.getElementById('sendSt').textContent = r.out; return; }
  if (a === 'adicionar') {
    const disp = window.__motoresDisp || [];
    const bg = document.createElement('div'); bg.className = 'mbg';
    bg.innerHTML = `<div class="mdl" role="dialog" aria-modal="true"><h4>Adicionar conta ou motor de IA</h4>
      <p class="note" style="margin:0 0 8px">Os agentes podem usar outra assinatura do Claude ou outro motor. O <b>Boss</b> é sempre Claude (é ele quem aplica as regras); devs e especialistas podem usar qualquer um.</p>
      <div style="display:flex;flex-direction:column;gap:6px"><button class="sb" data-mt="claude">Claude — outra assinatura (nova conta)</button>${disp.map((d) => `<button class="sb" data-mt="${esc(d.id)}">${esc(d.nome)}</button>`).join('')}</div>
      <p class="note" style="margin:10px 0 0">Nos outros motores, o Orquestra passa as <b>mesmas regras do projeto, a lista do que é proibido e as mesmas skills</b> (sincronizadas em <code>.agents/skills</code>, padrão que todos eles leem). Como o bloqueio técnico do Claude Code não vale lá, eles também rodam pedindo aprovação antes de executar comandos — você aprova pela aba Tela do agente.</p>
      <div class="mact"><button class="mc">Cancelar</button></div></div>`;
    const esc2 = await new Promise((res) => { bg.addEventListener('click', (ev) => { if (ev.target === bg || ev.target.classList.contains('mc')) { bg.remove(); res(null); } const m = ev.target.closest('[data-mt]'); if (m) { bg.remove(); res(m.dataset.mt); } }); document.body.appendChild(bg); });
    if (!esc2) return;
    const r = await post('/contas', { action: 'adicionar', provedor: esc2 }).catch((er) => ({ ok: false, out: er.message }));
    await avisa(r.ok ? 'Pronto' : 'Não deu', r.out); return carregaContasClaude();
  }
  if (a === 'instalar') { b.disabled = true; b.textContent = 'instalando…'; }
  if (a === 'remover' && !(await confirma('Remover esta conta da lista?', 'A pasta dela não é apagada. Só dá para remover se nenhum agente estiver usando.', true, 'Remover'))) return;
  const r = await post('/contas', { action: a, id: b.dataset.id }).catch((er) => ({ ok: false, out: er.message }));
  await avisa(r.ok ? 'Pronto' : 'Não deu', r.out); carregaContasClaude();
});
async function abrirLoginConta(n) {
  try { await termLib(); } catch { return avisa('Erro', 'não consegui carregar o terminal'); }
  const bg = document.createElement('div'); bg.className = 'mbg';
  bg.innerHTML = `<div class="mdl wide" role="dialog" aria-modal="true" style="width:min(900px,96vw)"><h4>${/^conta\d+$/.test(n) ? `Entrar na conta ${esc(n.replace('conta', ''))} do Claude` : `Entrar: ${esc(n)}`}</h4>
    <p class="note" style="margin:0 0 8px">${/^conta\d+$/.test(n) ? `Este é o Claude Code usando a pasta desta conta. Clique em <b>/login</b> e escolha a conta (abre o navegador para confirmar). <b>/status</b> mostra quem está logado. Depois, <code>/exit</code> e feche esta janela.` : 'O login deste motor roda abaixo — siga as instruções (pode abrir o navegador). Ao terminar, feche esta janela.'}</p>
    <div id="lgBox" style="height:420px;background:#0b0908;border:1px solid var(--line);border-radius:10px;padding:6px"></div>
    <div class="mact">${/^conta\d+$/.test(n) ? '<button class="sb" data-lg="status">/status</button><button class="sb" data-lg="login">/login</button>' : ''}<button class="mo">Fechar</button></div></div>`;
  document.body.appendChild(bg);
  const t = new XT({ fontFamily: 'Menlo, "SF Mono", Monaco, Consolas, monospace', fontSize: 13, cursorBlink: true, theme: { background: '#0b0908', foreground: '#e9e2da', cursor: '#e8875a' } });
  const f = new window.FitAddon.FitAddon(); t.loadAddon(f); t.open(bg.querySelector('#lgBox')); f.fit();
  const ws = new WebSocket(`ws://${location.host}/term?w=login&conta=${encodeURIComponent(n)}&p=${encodeURIComponent(PROJECT)}&t=${S.token || ''}&c=${t.cols}&r=${t.rows}`); ws.binaryType = 'arraybuffer';
  ws.onmessage = (m) => t.write(typeof m.data === 'string' ? m.data : new Uint8Array(m.data));
  t.onData((d) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'i', d })));
  setTimeout(() => t.focus(), 200);
  bg.addEventListener('click', (e) => {
    const lg = e.target.closest('[data-lg]')?.dataset.lg; if (lg && ws.readyState === 1) { ws.send(JSON.stringify({ t: 'i', d: '/' + lg })); setTimeout(() => ws.send(JSON.stringify({ t: 'i', d: '\r' })), 150); t.focus(); return; }
    if (e.target.classList.contains('mo') || e.target === bg) { try { ws.close(); } catch {} t.dispose(); bg.remove(); setTimeout(carregaContasClaude, 500); }
  });
}
function painelUso() {
  if (!ACCTS.length) return '<div class="note">Sem dados de conta ainda.</div>';
  const unicas = contasUnicas();
  const dup = unicas.filter((a) => a.ids.length > 1);
  const aviso = dup.length ? `<div class="box warn"><b>Atenção:</b> ${dup.map((a) => `as configurações <b>${a.ids.join(' e ')}</b> estão logadas na <b>mesma conta</b> (${esc(a.email)})`).join('; ')}. Na prática todos os agentes estão gastando o mesmo limite. Para usar a outra conta: <code>CLAUDE_CONFIG_DIR=~/.claude-conta2 claude</code> → <code>/login</code> com o outro e-mail → <code>/status</code> para conferir.</div>` : '';
  return aviso + `<div class="usage">${unicas.map((a) => {
    const meus = a.users.filter((u) => u.project === PROJECT).map((u) => nmA(u.agent));
    const outros = a.users.filter((u) => u.project !== PROJECT).length;
    const medido = a.metersAt ? `${a.fonte === 'usage' ? 'medido pelo /usage da própria conta' : 'medido pela sessão do Herdr (plugin)'} às ${hhmm(a.metersAt)}` : 'sem medição ainda';
    const linha = (rot, v, reset, quando) => `<div class="um"><div class="ut"><b>${rot}</b><span>${v == null ? '–' : v + '% usado'}</span></div>
      <div class="ub"><i style="width:${Math.min(100, v || 0)}%;background:${corUso(v || 0)}"></i></div>
      <div class="note" style="margin:4px 0 0">${reset ? `renova ${quando} · ${falta(reset)} (estimado)` : 'renovação: sem dados suficientes'}</div></div>`;
    const linhaReal = (rot, v, txt) => `<div class="um"><div class="ut"><b>${rot}</b><span>${v == null ? '–' : v + '% usado'}</span></div><div class="ub"><i style="width:${Math.min(100, v || 0)}%;background:${corUso(v || 0)}"></i></div><div class="note" style="margin:4px 0 0">renova ${esc(txt)}</div></div>`;
    return `<div class="box uc"><h3>${esc(a.nome || a.email || a.id)} <span class="note" style="font-weight:400">${a.nome ? esc(a.email || '') + ' · ' : ''}${esc(a.org || '')} · ${a.ids.join(' + ')}</span> <button class="sb" data-cc="medir" data-id="${esc(a.ids[0])}" style="float:right">medir agora</button></h3>
      ${a.reset5Txt ? linhaReal('Sessão atual (5 horas)', a.h5, a.reset5Txt) : linha('Sessão atual (5 horas)', a.h5, a.reset5, 'às ' + hhmm(a.reset5))}
      ${a.reset7Txt ? linhaReal('Semana (7 dias)', a.d7, a.reset7Txt) : ''}${a.reset7Txt ? '' : linha('Semana (7 dias)', a.d7, a.reset7, a.reset7 ? new Date(a.reset7).toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')}
      <div class="ux"><span>Agentes desta sala: <b>${meus.join(', ') || '—'}</b>${outros ? ` · +${outros} em outra sala` : ''}</span><span>Tokens hoje: <b>${fmtTok(a.tokToday)}</b></span></div>
      <div class="note">${medido}</div></div>`;
  }).join('')}</div>
  <div class="box" id="gContasClaude"><h3>Contas do Claude <span class="note" style="font-weight:400">quem está logado em cada uma e quem usa</span></h3><div class="note">carregando…</div></div>
  <div class="note">Mesma informação do <code>/usage</code> do Claude: % medido pela própria sessão (session-bar). Horários de renovação são estimados pelo histórico de mensagens. Trocou de conta com <code>/login</code>? Aparece aqui em até 30 s e o contexto dos agentes continua.</div>`;
}
function painelAgentes() {
  const U = S.usage || {};
  const time = new Set([...(S.team || []), ...Object.keys(S.agents || {})]);
  const ids = [...time].sort(byOrder);
  const agg = {}; // uso de devs extras (worktrees antigos/temporários) entra na linha do dev do repo
  for (const [k, u] of Object.entries(U)) {
    let alvo = k; if (!time.has(k)) { const { repo } = parseId(k); alvo = repo && time.has('dev-' + repo) ? 'dev-' + repo : null; }
    if (!alvo) continue; const a = (agg[alvo] ||= { today: { in: 0, out: 0, cost: 0 }, conta: u.conta, model: u.model });
    a.today.in += u.today?.in || 0; a.today.out += u.today?.out || 0; a.today.cost += u.today?.cost || 0; if (k === alvo) { a.conta = u.conta; a.model = u.model; }
  }
  const hoje = new Date().toDateString();
  const cont = (id, f) => feed.filter((e) => (e.from === id || e.to === id) && f(e)).length;
  const rows = ids.map((id) => {
    const a = S.agents[id] || {}, u = agg[id] || {};
    const tarefas = feed.filter((e) => e.to === id && (e.kind === 'delegate' || e.kind === 'ask')).length;
    const qaRep = feed.filter((e) => e.from === 'qa' && e.kind === 'qafail' && (e.text || '').includes(id.replace(/^dev-/, ''))).length;
    return `<tr><td><span class="dot" style="background:${hex(colorFor(id))}"></span>${esc(nmA(id))}</td>
      <td><span class="pill st-${a.status || 'idle'}" style="margin:0">${a.status ? STATUS_TXT[a.status] || a.status : 'fora do ar'}</span></td>
      <td>${esc(a.conta || u.conta || '')}</td><td>${esc((a.model || u.model || '').replace('claude-', ''))}</td>
      <td class="n">${a.ctx != null ? a.ctx + '%' : '–'}</td>
      <td class="n">${cont(id, (e) => new Date(e.ts).toDateString() === hoje)}</td><td class="n">${cont(id, () => true)}</td>
      <td class="n">${tarefas || ''}</td><td class="n">${S.rework[id] || ''}</td><td class="n">${qaRep || ''}</td>
      <td class="n">${fmtTok((u.today?.in || 0) + (u.today?.out || 0))}</td><td class="n">${fmtUsd(u.today?.cost)}</td></tr>`;
  }).join('');
  return `<div class="box"><h3>Agentes</h3><table><tr><th>Agente</th><th>Status</th><th>Conta</th><th>Modelo</th><th class="n">Contexto</th><th class="n">Interações hoje</th><th class="n">Interações (total)</th><th class="n">Tarefas</th><th class="n">Ajustes</th><th class="n">QA reprovou</th><th class="n">Tokens hoje</th><th class="n">Custo hoje</th></tr>${rows || '<tr><td colspan="12" class="note">Sem dados.</td></tr>'}</table>
    <div class="note">Interações = mensagens trocadas na equipe (delegações, relatórios, revisões, passagens para o QA). Contexto = quanto da janela da sessão o agente já ocupou (cada tarefa nova começa limpa).</div></div>`;
}
function painelCustos() {
  const U = S.usage || {};
  const sum = (f) => Object.values(U).reduce((s, u) => s + f(u), 0);
  const days = []; for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d.toLocaleDateString('sv')); }
  const perDay = days.map((d) => sum((u) => u.byDay?.[d] || 0)), max = Math.max(0.01, ...perDay);
  const byConta = {};
  for (const u of Object.values(U)) { const k = u.conta || '?'; (byConta[k] ||= { cost: 0, today: 0, tok: 0 }); byConta[k].cost += u.cost; byConta[k].today += u.today?.cost || 0; byConta[k].tok += (u.today?.in || 0) + (u.today?.out || 0); }
  return `<div class="tiles"><div class="tile"><div class="l">Custo hoje (equiv. API)</div><div class="v">${fmtUsd(sum((u) => u.today?.cost || 0))}</div></div>
      <div class="tile"><div class="l">Tokens hoje</div><div class="v">${fmtTok(sum((u) => (u.today?.in || 0) + (u.today?.out || 0)))}</div></div>
      <div class="tile"><div class="l">Custo total registrado</div><div class="v">${fmtUsd(sum((u) => u.cost || 0))}</div></div></div>
    <div class="grid2"><div class="box"><h3>Custo por dia (14 dias)</h3><div class="bars" style="margin-bottom:20px">${perDay.map((v, i) => `<div title="${days[i]}: ${fmtUsd(v)}" style="height:${(v / max) * 100}%"><span>${days[i].slice(8)}</span></div>`).join('')}</div></div>
    <div class="box"><h3>Por conta</h3><table><tr><th>Conta</th><th class="n">Tokens hoje</th><th class="n">Hoje</th><th class="n">Total</th></tr>${Object.entries(byConta).map(([k, c]) => `<tr><td>${esc(k)}</td><td class="n">${fmtTok(c.tok)}</td><td class="n">${fmtUsd(c.today)}</td><td class="n">${fmtUsd(c.cost)}</td></tr>`).join('') || '<tr><td colspan="4" class="note">—</td></tr>'}</table>
    <div class="note">Equivalente de API (estimativa). Na assinatura não se paga por token — serve para comparar quem consome mais.</div></div></div>`;
}
function painelAtividade() {
  return `<div class="box"><h3>Últimas interações</h3>${feed.slice(-40).reverse().map((e) => { const k = KIND[e.kind] || {}; return `<div class="fi" style="--k:${k.css};margin-bottom:6px"><div class="h">${new Date(e.ts).toLocaleString('pt-BR', { day: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${esc(nmA(e.from) )} → ${esc(e.to ? nmA(e.to) : '—')} · <b>${esc(k.label || e.kind)}</b></div><div class="ft">${esc(clip(e.text, 300))}</div></div>`; }).join('') || '<div class="note">Nenhuma ainda.</div>'}</div>`;
}
function renderPanel() {
  const el = document.getElementById('panel');
  const tabs = [['uso', 'Uso do Claude'], ['agentes', 'Agentes'], ['custos', 'Custos'], ['atividade', 'Atividade']];
  const body = subTab === 'agentes' ? painelAgentes() : subTab === 'custos' ? painelCustos() : subTab === 'atividade' ? painelAtividade() : painelUso();
  el.innerHTML = `<div class="subtabs">${tabs.map(([k, t]) => `<button data-sub="${k}" class="${k === subTab ? 'on' : ''}">${t}</button>`).join('')}</div>${body}`;
  if (subTab === 'uso' || !['agentes', 'custos', 'atividade'].includes(subTab)) carregaContasClaude();
}
document.getElementById('panel').addEventListener('click', (e) => { const b = e.target.closest('[data-sub]'); if (!b) return; subTab = b.dataset.sub; try { localStorage.setItem('estudio.sub', subTab); } catch {} renderPanel(); });

// ---------------- fluxo: pedido → delegação → trabalho → relatório → revisão → aprovado ----------------
const STAGES = ['delegado', 'trabalhando', 'reportou', 'revisando', 'QA', 'aprovado'];
function buildFlow() {
  const pedidos = [];
  let cur = null;
  const DONE = STAGES.length - 1;
  const openTask = (agent) => cur && [...cur.tasks].reverse().find((t) => t.agent === agent && t.stage !== DONE);
  for (const e of feed) {
    if (e.from === 'voce' && e.to === 'boss') { cur = { text: e.text, ts: e.ts, tasks: [] }; pedidos.push(cur); continue; }
    if (!cur) { cur = { text: '(antes do Estúdio)', ts: e.ts, tasks: [] }; pedidos.push(cur); }
    if (e.from === 'boss' && e.to === 'qa' && /VALIDAR/i.test(e.text || '')) {
      const slug = (e.text.match(/VALIDAR\s+\S+\s+([\w-]+)/i) || [])[1];
      const t = [...cur.tasks].reverse().find((x) => x.stage < DONE && x.agent.startsWith('dev-') && (!slug || (x.text || '').includes(slug)));
      if (t) { t.stage = 4; continue; }
    }
    if (e.from === 'qa' && (e.kind === 'qaok' || e.kind === 'qafail')) {
      const t = [...cur.tasks].reverse().find((x) => x.stage === 4);
      if (t) { if (e.kind === 'qafail') { t.stage = 1; t.rework++; } else t.qaok = true; continue; }
    }
    if (e.from === 'boss' && (e.kind === 'delegate' || e.kind === 'ask')) { cur.tasks.push({ agent: e.to, text: e.text, stage: 0, rework: 0, ts: e.ts }); continue; }
    const tgt = e.from === 'boss' ? e.to : e.from;
    const t = tgt && openTask(tgt);
    if (!t) continue;
    if (e.from === 'boss' && e.kind === 'send') { t.rework++; t.stage = 1; }
    else if (e.kind === 'report') t.stage = Math.max(t.stage, 2);
    else if (e.kind === 'review' || e.kind === 'inspect') t.stage = Math.max(t.stage, t.stage >= 2 ? 3 : 1);
    else if (e.kind === 'approve') t.stage = DONE;
  }
  for (const pd of pedidos) for (const t of pd.tasks) if (t.stage === 0 && S.agents[t.agent]?.status === 'working') t.stage = 1;
  return pedidos.filter((p) => p.tasks.length || p.text !== '(antes do Estúdio)').slice(-2);
}
function renderFlow() {
  const el = document.getElementById('flow');
  const pedidos = buildFlow();
  if (!pedidos.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const nm = (id) => (id === 'boss' ? 'Boss' : SPECIAL[id]?.title || parseId(id).title);
  const last = pedidos[pedidos.length - 1];
  const head = groupHead('flow', 'Fluxo', last ? esc(clip(last.text, 60)) : '', false);
  if (isFolded('flow', false)) { el.innerHTML = head; return; }
  el.innerHTML = head + pedidos.reverse().map((pd) => {
    const done = pd.tasks.length && pd.tasks.every((t) => t.stage === STAGES.length - 1);
    return `<div class="pd"><div class="pt" title="${esc(pd.text)}">${done ? '✓ ' : ''}${esc(clip(pd.text, 110))}</div>` +
      (pd.tasks.length ? pd.tasks.map((t) => `<div class="tk"><span class="ag"><span class="dot" style="background:${hex(colorFor(t.agent))}"></span>${esc(nm(t.agent))}</span>
        <span class="steps">${STAGES.map((st, i) => `<i class="${i < t.stage ? 'ok' : i === t.stage ? (i === STAGES.length - 1 ? 'ok' : 'now') : ''}">${st}</i>`).join('')}</span>${t.rework ? `<span class="rw">${t.rework}× ajuste</span>` : ''}</div>`).join('')
        : '<div class="tk muted">o Boss ainda não delegou…</div>') + '</div>';
  }).join('');
}

function renderAll() { syncChars(); renderSide(); renderComposer(); renderHeader(); renderAccounts(); renderFeed(); renderFlow(); if (tab === 'panel') renderPanel(); }

let tab = 'office';
document.querySelectorAll('.tabs button[data-tab]').forEach((b) => b.addEventListener('click', () => {
  tab = b.dataset.tab; window.__office = tab === 'office';
  document.querySelectorAll('.tabs button[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
  document.getElementById('office').style.display = tab === 'office' ? 'block' : 'none';
  document.getElementById('panel').style.display = tab === 'panel' ? 'block' : 'none';
  document.getElementById('term').style.display = tab === 'term' ? 'flex' : 'none';
  document.getElementById('git').style.display = tab === 'git' ? 'flex' : 'none';
  if (tab === 'git') gitAbrir();
  if (tab === 'term') termAbrir(); else termFit();
  if (tab === 'office') resize(); else if (tab === 'panel') renderPanel();
}));

// ---------------- terminal do andar (xterm.js + WebSocket) ----------------
let XT = null, term = null, fit = null, tws = null, termQual = null;
const loadScript = (src) => new Promise((ok, err) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = err; document.head.appendChild(s); });
async function termLib() {
  if (XT) return XT;
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/vendor/xterm.css'; document.head.appendChild(l);
  await loadScript('/vendor/xterm.js'); await loadScript('/vendor/addon-fit.js');
  return (XT = window.Terminal);
}
function termStatus() {
  const vivo = !!S.agents?.boss;
  const bt = document.getElementById('termBoss'); if (bt) { bt.style.display = vivo ? 'none' : ''; bt.textContent = `▶ Iniciar Boss (= ${UI.atalho || PROJECT})`; bt.title = `O mesmo que digitar ${UI.atalho || PROJECT} num terminal do Herdr`; }
  document.querySelectorAll('#term [data-tw]').forEach((b) => b.classList.toggle('on', b.dataset.tw === termQual));
}
function termFit() { if (term && fit && tab === 'term') { try { fit.fit(); } catch {} if (tws?.readyState === 1) tws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows })); } }
async function termAbrir(qual) {
  qual = qual || termQual || (S.agents?.boss ? 'boss' : 'andar');
  const st = document.getElementById('termSt');
  if (tws && termQual === qual && tws.readyState <= 1) { termStatus(); termFit(); term?.focus(); return; }
  termQual = qual; termStatus();
  try { await termLib(); } catch { st.textContent = 'não consegui carregar o terminal'; return; }
  if (!term) {
    term = new XT({ fontFamily: 'Menlo, "SF Mono", Monaco, Consolas, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: true,
      theme: { background: '#0b0908', foreground: '#e9e2da', cursor: '#e8875a', selectionBackground: '#5a3b2a' } });
    fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); term.open(document.getElementById('termBox'));
    term.onData((d) => { if (tws?.readyState === 1) tws.send(JSON.stringify({ t: 'i', d })); });
    new ResizeObserver(() => termFit()).observe(document.getElementById('termBox'));
  }
  try { tws?.close(); } catch {}
  term.reset(); fit.fit();
  st.textContent = qual === 'boss' ? 'conectando ao Boss…' : 'abrindo o terminal do andar…';
  const ws = new WebSocket(`ws://${location.host}/term?p=${encodeURIComponent(PROJECT)}&w=${qual}&t=${S.token || ''}&c=${term.cols}&r=${term.rows}`);
  ws.binaryType = 'arraybuffer'; tws = ws;
  ws.onopen = () => { st.textContent = qual === 'boss' ? 'Boss — /exit encerra; o terminal continua no Herdr' : 'terminal do andar (na pasta do projeto, dentro do Herdr)'; term.focus(); };
  ws.onmessage = (m) => term.write(typeof m.data === 'string' ? m.data : new Uint8Array(m.data));
  ws.onclose = () => { if (tws === ws) { st.textContent = 'desconectado — clique em reconectar'; tws = null; } };
}
document.getElementById('term')?.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tw]'); if (b) { tws?.close(); tws = null; return termAbrir(b.dataset.tw); }
  if (e.target.id === 'termRe') { tws?.close(); tws = null; return termAbrir(termQual); }
  if (e.target.id === 'termBoss') {
    e.target.disabled = true;
    const r = await fetch('/terminal', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': S.token || '' }, body: JSON.stringify({ project: PROJECT, action: 'iniciar-boss' }) }).then((x) => x.json()).catch((er) => ({ ok: false, out: er.message }));
    e.target.disabled = false;
    if (!r.ok) return avisa('Não deu para iniciar o Boss', r.out || 'falhou');
    tws?.close(); tws = null; termAbrir('andar'); // o Boss sobe dentro do terminal do andar
  }
});

// ---------------- Git: adicionar, commitar, enviar e abrir MR/PR (com as regras do sistema) ----------------
let GIT = { lista: [], sel: null, det: null, arq: null };
const gfetch = (u) => fetch(u, { cache: 'no-store' }).then((r) => r.json());
async function gitAbrir() {
  const box = document.getElementById('gitList'); if (!GIT.lista.length) box.innerHTML = '<div class="note">lendo os repositórios…</div>';
  try { const d = await gfetch('/git?p=' + encodeURIComponent(PROJECT)); GIT.lista = d.repos; GIT.prot = d.protegidas; } catch (e) { box.innerHTML = 'erro: ' + esc(e.message); return; }
  const item = (r) => `<div class="gr ${GIT.sel === r.id ? 'on' : ''}" data-gr="${esc(r.id)}"><b>${esc(r.tipo === 'mesa' ? r.nome + ' (mesa)' : r.nome)}</b><div class="sm">${r.erro ? 'erro' : `${esc(r.branch || 'sem branch')}${r.protegida ? ' 🔒' : ''}${r.ahead ? ' · ↑' + r.ahead : ''}${r.behind ? ' · ↓' + r.behind : ''}`}${r.alterados ? ` · <span style="color:#f2c14e">${r.alterados} alterado(s)</span>` : ''}</div></div>`;
  const repos = GIT.lista.filter((r) => r.tipo === 'repo'), mesas = GIT.lista.filter((r) => r.tipo === 'mesa');
  box.innerHTML = `<div id="gContas"><h5>Contas</h5><div class="note">verificando…</div></div><h5>Repositórios (pasta original)</h5>${repos.map(item).join('') || '<div class="note">nenhum</div>'}${mesas.length ? `<h5>Mesas dos devs</h5>${mesas.map(item).join('')}` : ''}`;
  if (!GIT.sel && GIT.lista.length) GIT.sel = (GIT.lista.find((r) => r.alterados) || GIT.lista[0]).id;
  if (GIT.sel) gitDetalhe();
  gitContas();
}
// ---------- padrões: tipos (Conventional Commits) + gitmoji, nomes de branch ----------
const TIPOS = [
  ['feat', '✨', 'funcionalidade nova', 'feature'], ['fix', '🐛', 'correção de bug', 'fix'], ['hotfix', '🚑️', 'correção urgente em produção', 'hotfix'],
  ['docs', '📝', 'documentação', 'docs'], ['refactor', '♻️', 'refatoração (sem mudar comportamento)', 'refactor'], ['perf', '⚡️', 'desempenho', 'perf'],
  ['test', '✅', 'testes', 'test'], ['style', '💄', 'visual / estilo / UI', 'style'], ['chore', '🔧', 'configuração, manutenção', 'chore'],
  ['build', '📦️', 'build e dependências', 'build'], ['ci', '👷', 'pipeline / CI', 'ci'], ['security', '🔒️', 'segurança', 'security'], ['revert', '⏪️', 'reverte algo', 'revert'],
];
const EMO = /^(\p{Extended_Pictographic}|:[a-z_]+:)/u, CONV = /^(?:(?:\p{Extended_Pictographic}|:[a-z_]+:)️?\s*)?([a-z]+)(\([^)]+\))?!?:\s/u;
function estiloDoRepo(d) {
  const ms = (d.commits || []).map((c) => c.m);
  const gitmoji = ms.filter((m) => EMO.test(m)).length >= Math.max(1, ms.length / 4);
  const conv = ms.filter((m) => CONV.test(m)).length >= Math.max(1, ms.length / 4);
  // prefixo das branches: feature/ ou feat/? (o que o time já usa)
  const pref = {}; for (const b of d.branchesRemotas || []) { const m = b.match(/^([a-z]+)\//); if (m) pref[m[1]] = (pref[m[1]] || 0) + 1; }
  const usaFeature = (pref.feature || 0) >= (pref.feat || 0);
  const ticket = (d.branchesRemotas || []).map((b) => (b.match(/\/([A-Za-z]+-\d+)/) || [])[1]).find(Boolean) || '';
  return { gitmoji, conv, usaFeature, pref, exemploTicket: ticket };
}
const slugBr = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
function tipoDaBranch(br) { const p = (br || '').split('/')[0]; return (TIPOS.find((t) => t[0] === p || t[3] === p || (p === 'bugfix' && t[0] === 'fix')) || [])[0] || ''; }
let gitmojiOn = (() => { try { const v = localStorage.getItem('orq.gitmoji'); return v == null ? null : v === '1'; } catch { return null; } })();
function commitComposer(d) {
  const e = estiloDoRepo(d), usaEmoji = gitmojiOn ?? e.gitmoji, tipo = tipoDaBranch(d.branch) || 'feat';
  return `<div class="lin"><div style="flex:1.2"><label style="margin-top:0">Tipo</label><select id="gTipo">${TIPOS.map((t) => `<option value="${t[0]}" ${t[0] === tipo ? 'selected' : ''}>${t[1]} ${t[0]} — ${t[2]}</option>`).join('')}</select></div>
      <div style="flex:.8"><label style="margin-top:0">Escopo (opcional)</label><input id="gEsc" placeholder="ex.: auth, checkout"></div>
      <div style="flex:none;align-self:end"><div class="ck" style="margin:0 0 8px"><input type="checkbox" id="gEmo" ${usaEmoji ? 'checked' : ''}><label for="gEmo" style="margin:0" title="Coloca o emoji do gitmoji.dev no começo">gitmoji</label></div></div></div>
    <label>Resumo (imperativo, curto)</label><input id="gRes" maxlength="100" placeholder="ex.: corrige logout entre sistemas">
    <label>Detalhes (opcional)</label><textarea id="gMsg" rows="3" placeholder="Por quê, o que muda, como testar…"></textarea>
    <div class="note" style="margin:6px 0 0">Vai ficar: <code id="gPrev"></code> ${e.conv || e.gitmoji ? `<span title="detectado pelos últimos commits">· padrão do repo: ${[e.gitmoji ? 'gitmoji' : '', e.conv ? 'conventional commits' : ''].filter(Boolean).join(' + ')}</span>` : ''}</div>`;
}
function mensagemCommit() {
  const t = TIPOS.find((x) => x[0] === document.getElementById('gTipo')?.value) || TIPOS[0];
  const esc2 = (document.getElementById('gEsc')?.value || '').trim().toLowerCase().replace(/[^a-z0-9._/-]+/g, '-');
  const res = (document.getElementById('gRes')?.value || '').trim();
  const head = `${document.getElementById('gEmo')?.checked ? t[1] + ' ' : ''}${t[0]}${esc2 ? `(${esc2})` : ''}: ${res}`;
  const corpo = (document.getElementById('gMsg')?.value || '').trim();
  return { head, res, msg: corpo ? head + '\n\n' + corpo : head };
}
document.addEventListener('input', (e) => { if (e.target.closest?.('.gcommit')) { const p = document.getElementById('gPrev'); if (p) p.textContent = mensagemCommit().head; } });
document.addEventListener('change', (e) => { if (e.target.id === 'gEmo') { gitmojiOn = e.target.checked; try { localStorage.setItem('orq.gitmoji', gitmojiOn ? '1' : '0'); } catch {} } if (e.target.closest?.('.gcommit')) { const p = document.getElementById('gPrev'); if (p) p.textContent = mensagemCommit().head; } });
function nomeBranchForm(d) {
  const e = estiloDoRepo(d);
  return `<div class="lin"><div><label style="margin-top:0">Tipo</label><select name="tipo" id="nbT">${TIPOS.map((t) => `<option value="${t[0]}">${t[1]} ${t[0]} — ${t[2]}</option>`).join('')}</select></div>
      <div style="flex:.6"><label style="margin-top:0">Card / issue (opcional)</label><input name="ticket" id="nbK" placeholder="${esc(e.exemploTicket || 'ex.: TG-512 ou 123')}"></div></div>
    <label>Do que se trata</label><input name="desc" id="nbD" placeholder="ex.: logout entre sistemas">
    <div class="ck"><input type="checkbox" id="nbF" ${e.usaFeature ? 'checked' : ''}><label for="nbF" style="margin:0">usar <code>feature/</code> em vez de <code>feat/</code> para funcionalidade</label></div>
    <label>Nome da branch</label><input name="branch" id="nbN" placeholder="gerado automaticamente — pode editar">
    <small>Sai de ${esc(d.branch || 'HEAD')}; as alterações não commitadas vão junto. ${Object.keys(e.pref).length ? 'Prefixos já usados no remoto: ' + Object.entries(e.pref).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${esc(k)}/ (${n})`).join(', ') : ''}</small>`;
}
function nomeBranchGera(root) {
  const t = TIPOS.find((x) => x[0] === root.querySelector('#nbT').value) || TIPOS[0];
  const pre = t[0] === 'feat' ? (root.querySelector('#nbF').checked ? 'feature' : 'feat') : t[3];
  const k = slugBr(root.querySelector('#nbK').value), d = slugBr(root.querySelector('#nbD').value);
  return `${pre}/${[k, d].filter(Boolean).join('-')}`.replace(/\/$/, '/');
}

// contas do GitHub/GitLab: o Orquestra faz o login (gh / glab)
async function gitContas() {
  const el = document.getElementById('gContas'); if (!el) return;
  let c = []; try { c = await gfetch('/git/contas?p=' + encodeURIComponent(PROJECT)); } catch {}
  GIT.contas = c;
  el.innerHTML = `<h5>Contas</h5>` + (c.map((x) => `<div class="gr" style="cursor:default"><b>${x.plat === 'github' ? 'GitHub' : 'GitLab'} ${x.logado ? '<span style="color:#4fd18b">✓</span>' : '<span style="color:var(--blocked)">✗</span>'}</b><div class="sm" title="${esc(x.detalhe)}">${esc(x.host)}${x.conta ? ' · ' + esc(x.conta) : ''}</div>
    <div style="margin-top:6px"><button class="sb ${x.logado ? '' : 'pri'}" data-glogin="${esc(x.host)}">${!x.instalado ? 'instalar ' + x.cli : x.logado ? 'trocar conta' : 'entrar'}</button></div></div>`).join('') || '<div class="note">nenhum remoto do GitHub/GitLab</div>');
}
function gitLogin(host) {
  const x = (GIT.contas || []).find((c) => c.host === host); if (!x) return;
  const nome = x.plat === 'github' ? 'GitHub' : 'GitLab';
  const bg = document.createElement('div'); bg.className = 'mbg';
  const fim = () => { clearInterval(bg._t); bg.classList.add('out'); setTimeout(() => bg.remove(), 150); };
  const corpo = () => !x.instalado ? `<p>O Orquestra usa o <b>${x.cli}</b> para abrir ${x.plat === 'github' ? 'PRs' : 'MRs'} — ele ainda não está instalado neste computador.</p><div class="mact"><button class="mc">Fechar</button><button class="mo" data-gl="instalar">Instalar o ${x.cli}</button></div>`
    : `${x.plat === 'github' ? `<p><b>Pelo navegador (mais fácil):</b> o Orquestra mostra um código, você confirma no site do GitHub e pronto.</p><div class="gbar"><button class="sb pri" data-gl="web">Entrar pelo navegador</button></div><div id="glWeb"></div><hr style="border:0;border-top:1px solid var(--line);margin:14px 0">` : ''}
      <p><b>Com um token${x.plat === 'github' ? ' (alternativa)' : ''}:</b> 1) <a href="${esc(x.token)}" target="_blank">crie um token em ${esc(host)}</a> — a página já abre com as permissões certas (${x.plat === 'github' ? 'repo, workflow' : 'api, write_repository'}); 2) cole aqui:</p>
      <input id="glTk" type="password" autocomplete="off" placeholder="cole o token" style="width:100%;box-sizing:border-box">
      <small>O token vai direto para o ${x.cli} (que guarda no ${navigator.platform.includes('Mac') ? 'Keychain do Mac' : 'cofre do sistema'}); o Orquestra não salva nem mostra.</small>
      <div class="mact"><button class="mc">Fechar</button><button class="mo" data-gl="token">Entrar com o token</button></div>`;
  bg.innerHTML = `<div class="mdl wide frm" role="dialog" aria-modal="true"><h4>Entrar no ${nome} · ${esc(host)}</h4>${x.logado ? `<p class="note">Já está logado${x.conta ? ' como <b>' + esc(x.conta) + '</b>' : ''}. Entrar de novo troca a conta.</p>` : ''}<div id="glC">${corpo()}</div></div>`;
  const pronto = (msg) => { fim(); document.getElementById('sendSt').textContent = msg; gitContas(); };
  bg.addEventListener('click', async (e) => {
    if (e.target === bg || e.target.classList.contains('mc')) return fim();
    const a = e.target.closest('[data-gl]')?.dataset.gl; if (!a) return;
    e.target.disabled = true;
    if (a === 'instalar') { e.target.textContent = 'instalando… (pode levar 1–2 min)'; const r = await post('/git/instalar', { plat: x.plat, host }).catch((er) => ({ ok: false, out: er.message })); e.target.disabled = false; if (!r.ok) return avisa('Não instalou', r.out); x.instalado = true; bg.querySelector('#glC').innerHTML = corpo(); return; }
    if (a === 'token') { const tk = bg.querySelector('#glTk').value.trim(); const r = await post('/git/login', { plat: x.plat, host, modo: 'token', token: tk }).catch((er) => ({ ok: false, out: er.message })); e.target.disabled = false; return r.ok ? pronto(r.out) : avisa('Não entrou', r.out); }
    if (a === 'web') {
      const r = await post('/git/login', { plat: x.plat, host, modo: 'web' }).catch((er) => ({ ok: false, out: er.message })); if (!r.ok) { e.target.disabled = false; return avisa('Não deu', r.out); }
      const box = bg.querySelector('#glWeb'); box.innerHTML = '<p class="note">gerando o código…</p>'; let abriu = false;
      bg._t = setInterval(async () => {
        const l = await gfetch('/git/login?s=' + r.sessao).catch(() => null); if (!l) return;
        if (l.codigo) { box.innerHTML = `<p>Seu código: <b style="font-size:22px;letter-spacing:2px;color:var(--accent)">${esc(l.codigo)}</b> <button class="sb" onclick="navigator.clipboard.writeText('${esc(l.codigo)}')">copiar</button></p><p>Confirme em <a href="${esc(l.url)}" target="_blank">${esc(l.url)}</a> (já abrimos a página) e autorize. Esta janela fecha sozinha.</p>`; if (!abriu) { abriu = true; window.open(l.url, '_blank'); } }
        if (l.fim) { clearInterval(bg._t); if (l.ok) pronto('pronto — logado no GitHub'); else { box.innerHTML = `<p style="color:var(--blocked)">Não completou.</p><pre style="white-space:pre-wrap;font-size:11px">${esc(l.saida)}</pre>`; e.target.disabled = false; } }
      }, 1200);
    }
  });
  document.body.appendChild(bg);
}
async function gitDetalhe() {
  const el = document.getElementById('gitDet'); let d;
  try { d = await gfetch(`/git/repo?p=${encodeURIComponent(PROJECT)}&r=${encodeURIComponent(GIT.sel)}`); } catch (e) { el.innerHTML = 'erro: ' + esc(e.message); return; }
  GIT.det = d; document.querySelectorAll('#gitList .gr').forEach((x) => x.classList.toggle('on', x.dataset.gr === GIT.sel));
  if (d.erro) { el.innerHTML = '<div class="note">' + esc(d.erro) + '</div>'; return; }
  const st = d.arquivos.filter((a) => a.staged), nao = d.arquivos.filter((a) => !a.staged || a.mudado);
  const letra = (a, staged) => { const c = staged ? a.x : a.novo ? 'U' : a.y; return `<span class="x ${c === '?' ? 'U' : c}">${c === '?' ? 'U' : c}</span>`; };
  const linha = (a, staged) => `<div class="gf ${GIT.arq?.f === a.f && GIT.arq?.staged === staged ? 'sel' : ''}" data-gf="${esc(a.f)}" data-st="${staged ? 1 : 0}" data-novo="${a.novo ? 1 : 0}">${letra(a, staged)}<span class="nm" title="${esc(a.f)}">${esc(a.de ? a.de + ' → ' + a.f : a.f)}</span>${a.bloqueio ? `<span class="bl" title="${esc(a.bloqueio)}">🔒 ${esc(a.bloqueio.split(' ')[0])}</span>` : `<button class="sb" data-ga="${staged ? 'unstage' : 'stage'}" data-f="${esc(a.f)}">${staged ? '−' : '+'}</button>`}</div>`;
  const prot = d.protegida, plat = d.plataforma === 'github' ? 'PR' : 'MR';
  el.innerHTML = `<div class="gbar"><span class="br">⎇ ${esc(d.branch || '(sem branch)')}</span>${prot ? '<span class="bdg bad">protegida</span>' : ''}<span class="sm">${d.upstream ? '↔ ' + esc(d.upstream) : 'sem branch remota'}${d.ahead ? ' · ↑' + d.ahead + ' para enviar' : ''}${d.behind ? ' · ↓' + d.behind + ' para puxar' : ''}</span>
      <span style="margin-left:auto"></span><button class="sb" data-ga="fetch">atualizar</button>${d.behind ? '<button class="sb" data-ga="pull">puxar (sem merge)</button>' : ''}<button class="sb" data-ga="branch">nova branch</button></div>
    ${prot ? `<div class="gregras" style="border-color:var(--blocked)">Você está em <b>${esc(d.branch)}</b>, que é protegida: aqui não se commita nem se envia. Crie uma branch (<b>nova branch</b>) — suas alterações vão junto.</div>` : ''}
    <div class="gfiles"><h6>Alterações (${nao.length})${nao.some((a) => !a.bloqueio) ? '<button class="sb" data-ga="stage-todos">+ adicionar todas</button>' : ''}</h6>${nao.map((a) => linha(a, false)).join('') || '<div class="gf" style="cursor:default;color:var(--muted)">nada alterado</div>'}</div>
    <div class="gfiles"><h6>No próximo commit (${st.length})${st.length ? '<button class="sb" data-ga="unstage-todos">− tirar todas</button>' : ''}</h6>${st.map((a) => linha(a, true)).join('') || '<div class="gf" style="cursor:default;color:var(--muted)">adicione arquivos com +</div>'}</div>
    <div id="gDiff"></div>
    <div class="gcommit frm">${commitComposer(d)}
      <div class="gbar"><button class="sb pri" data-ga="commit" ${!st.length || prot ? 'disabled' : ''}>Commitar ${st.length} arquivo(s)</button><button class="sb" data-ga="push" ${prot || !d.branch || (!d.ahead && d.upstream) ? 'disabled' : ''}>Enviar (push)${d.ahead ? ' ↑' + d.ahead : ''}</button><button class="sb" data-ga="mr" ${prot || !d.branch ? 'disabled' : ''}>Abrir ${plat}${d.plataforma ? '' : ' (?)'}</button><button class="sb" data-ga="merge" ${prot || !d.branch || !d.upstream ? 'disabled' : ''} title="Merge (squash) do ${plat} desta branch — decisão sua">Merge do ${plat}…</button></div></div>
    <div class="gregras">Regras: nada de commit/push em ${esc((GIT.prot || []).join(', '))}; sem force push; submódulos e arquivos sensíveis (.env, chaves) nunca entram; merge só pelo ${plat} — quem aprova é você.</div>
    <div class="glog"><b style="font-size:12px">Últimos commits</b>${d.commits.slice(0, 8).map((c) => `<div><code>${esc(c.h)}</code> ${esc(c.m)} <span class="note" style="margin:0">— ${esc(c.a)}, ${esc(c.q)}</span></div>`).join('')}</div>`;
  if (GIT.arq) gitDiff();
}
async function gitDiff() {
  const a = GIT.arq, box = document.getElementById('gDiff'); if (!a || !box) return;
  const t = await fetch(`/git/diff?p=${encodeURIComponent(PROJECT)}&r=${encodeURIComponent(GIT.sel)}&f=${encodeURIComponent(a.f)}&staged=${a.staged ? 1 : 0}&novo=${a.novo ? 1 : 0}`, { cache: 'no-store' }).then((r) => r.text()).catch((e) => 'erro: ' + e.message);
  box.innerHTML = `<div class="gdiff">${esc(t).split('\n').map((l) => /^(\+\+\+|---)/.test(l) ? `<span class="h">${l}</span>` : l.startsWith('+') ? `<span class="a">${l}</span>` : l.startsWith('-') ? `<span class="r">${l}</span>` : l.startsWith('@@') ? `<span class="h">${l}</span>` : l).join('\n')}</div>`;
}
const gpost = (body) => post('/git', { repo: GIT.sel, ...body }).catch((e) => ({ ok: false, out: e.message }));
function gitForm(titulo, campos, ok, prep) {
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'mbg';
    bg.innerHTML = `<div class="mdl wide frm" role="dialog" aria-modal="true"><h4>${esc(titulo)}</h4>${campos}<div class="mact"><button class="mc">Cancelar</button><button class="mo">${esc(ok)}</button></div></div>`;
    const fim = (v) => { bg.classList.add('out'); setTimeout(() => bg.remove(), 150); resolve(v); };
    bg.addEventListener('click', (e) => { if (e.target === bg || e.target.classList.contains('mc')) fim(null); if (e.target.classList.contains('mo')) fim(Object.fromEntries([...bg.querySelectorAll('[name]')].map((x) => [x.name, x.value]))); });
    document.body.appendChild(bg); if (prep) prep(bg); else setTimeout(() => bg.querySelector('[name]')?.focus(), 30);
  });
}
document.getElementById('git').addEventListener('click', async (e) => {
  const gl = e.target.closest('[data-glogin]'); if (gl) { e.stopPropagation(); return gitLogin(gl.dataset.glogin); }
  const gr = e.target.closest('[data-gr]'); if (gr) { GIT.sel = gr.dataset.gr; GIT.arq = null; return gitDetalhe(); }
  const b = e.target.closest('[data-ga]');
  if (!b) { const f = e.target.closest('[data-gf]'); if (f) { GIT.arq = { f: f.dataset.gf, staged: f.dataset.st === '1', novo: f.dataset.novo === '1' }; document.querySelectorAll('#gitDet .gf').forEach((x) => x.classList.toggle('sel', x === f)); gitDiff(); } return; }
  e.stopPropagation();
  const d = GIT.det, act = b.dataset.ga, plat = d?.plataforma === 'github' ? 'PR' : 'MR', stt = document.getElementById('sendSt');
  let r;
  if (act === 'stage' || act === 'unstage') r = await gpost({ action: act, files: [b.dataset.f] });
  else if (act === 'stage-todos') r = await gpost({ action: 'stage', files: d.arquivos.filter((a) => (!a.staged || a.mudado) && !a.bloqueio).map((a) => a.f) });
  else if (act === 'unstage-todos') r = await gpost({ action: 'unstage', files: d.arquivos.filter((a) => a.staged).map((a) => a.f) });
  else if (act === 'fetch' || act === 'pull') { b.disabled = true; b.textContent = '…'; r = await gpost({ action: act }); }
  else if (act === 'branch') {
    const v = await gitForm('Nova branch', nomeBranchForm(d), 'Criar branch', (root) => { const n = root.querySelector('#nbN'); const auto = () => { if (!n.dataset.mexeu) n.value = nomeBranchGera(root); }; root.querySelectorAll('#nbT,#nbK,#nbD,#nbF').forEach((x) => x.addEventListener('input', auto)); root.querySelectorAll('#nbT,#nbF').forEach((x) => x.addEventListener('change', auto)); n.addEventListener('input', () => (n.dataset.mexeu = 1)); auto(); setTimeout(() => root.querySelector('#nbD').focus(), 40); }); if (!v) return;
    if (!/\/[a-z0-9]/.test(v.branch || '')) return avisa('Falta o nome', 'Diga do que se trata (ou o número do card) para gerar o nome da branch.');
    r = await gpost({ action: 'branch', branch: v.branch });
  } else if (act === 'commit') {
    const mc = mensagemCommit(), msg = mc.msg; if (mc.res.length < 3) return avisa('Falta o resumo', 'Escreva o resumo do commit (ex.: corrige logout entre sistemas).');
    const st = d.arquivos.filter((a) => a.staged).map((a) => a.f);
    if (!(await confirma(`Commitar em ${d.branch}?`, `${msg}\n\n${st.length} arquivo(s):\n${st.slice(0, 12).join('\n')}${st.length > 12 ? '\n…' : ''}`, false, 'Commitar'))) return;
    r = await gpost({ action: 'commit', mensagem: msg });
  } else if (act === 'push') {
    if (!(await confirma(`Enviar ${d.branch} para o remoto?`, `git push -u origin ${d.branch}${d.ahead ? ` (${d.ahead} commit(s))` : ''}. Sem force push.`, false, 'Enviar'))) return;
    b.disabled = true; b.textContent = 'enviando…'; r = await gpost({ action: 'push' });
  } else if (act === 'mr') {
    const ult = d.commits[0]?.m || '';
    const v = await gitForm(`Abrir ${plat} de ${d.branch}`, `<label>Destino</label><input name="alvo" value="${esc(d.alvo)}"><small>Pela regra do projeto: develop (ou main quando o repo não tem develop).</small>
      <label>Título</label><input name="titulo" value="${esc(ult)}"><label>Descrição</label><textarea name="descricao" rows="8" placeholder="O que mudou, por quê, como testar…"></textarea>
      <small>Se a branch ainda não foi enviada, ela é enviada antes. O ${plat} só abre — o merge continua sendo decisão sua, lá no ${d.plataforma === 'github' ? 'GitHub' : 'GitLab'}.</small>`, `Abrir ${plat}`); if (!v) return;
    b.disabled = true; b.textContent = 'abrindo…'; r = await gpost({ action: 'mr', ...v });
  } else if (act === 'merge') {
    if (!(await confirma(`Fazer o merge do ${plat} de ${d.branch}?`, `Junta ${d.branch} em ${d.alvo} no ${d.plataforma === 'github' ? 'GitHub' : 'GitLab'} (squash: vira 1 commit) e apaga a branch remota. Depois você volta para ${d.alvo} já atualizado.\n\nÉ a decisão final — os agentes nunca fazem isso sozinhos.`, true, 'Fazer o merge'))) return;
    b.disabled = true; b.textContent = 'fazendo o merge…'; r = await gpost({ action: 'merge' });
  }
  if (!r) return;
  if (!r.ok) { if (r.login) { await avisa('Precisa entrar na conta', r.out + '\n\nVou abrir o login.'); if (!GIT.contas) await gitContas(); gitLogin(r.login); } else avisa('Não deu certo', r.out || 'falhou'); }
  else { stt.textContent = r.out; if (r.link) { const ok = await modal({ title: r.out, text: r.link, ok: 'Abrir no navegador', cancel: 'Fechar' }); if (ok) window.open(r.link, '_blank'); } if (act === 'commit') { ['gMsg', 'gRes', 'gEsc'].forEach((x) => { const m = document.getElementById(x); if (m) m.value = ''; }); } }
  if (act === 'stage' || act === 'unstage' || act === 'stage-todos' || act === 'unstage-todos') gitDetalhe(); else gitAbrir();
});

// ---------------- stream ----------------
function connect() {
  const es = new EventSource('/stream?p=' + encodeURIComponent(PROJECT));
  window.bootStep?.('conectando ao servidor…');
  es.addEventListener('init', (m) => { window.bootStep?.('recebendo a equipe…'); const d = JSON.parse(m.data); feed = d.interactions || []; S = d; ROOMS = d.rooms || []; ACCTS = d.accounts || []; renderAll(); renderRooms(); booted = true; window.bootDone?.().then?.(() => { if (window.__lento) toast({ kind: 'servico', from: 'voce', text: window.__lento }); }); });
  es.addEventListener('rooms', (m) => { ROOMS = JSON.parse(m.data); renderRooms(); });
  es.addEventListener('atualizou', () => mostraAtualizou());
  es.addEventListener('init', () => setTimeout(checaVersao, 300));
  es.addEventListener('state', (m) => { S = { ...S, ...JSON.parse(m.data) }; renderAll(); if (tab === 'term') termStatus(); });
  es.addEventListener('activity', (m) => onActivity(JSON.parse(m.data)));
  es.addEventListener('accounts', (m) => { ACCTS = JSON.parse(m.data); renderAccounts(); renderSide(); if (tab === 'panel') renderPanel(); });
  es.addEventListener('interaction', (m) => { const e = JSON.parse(m.data); feed.push(e); if (feed.length > 300) feed.shift(); renderFeed(); renderFlow(); if (tab === 'panel') renderPanel(); playInteraction(e); });
  es.onerror = () => { S.hcOk = false; renderHeader(); };
}

resize();
connect();
tick();

async function abrirNoHerdr(ag, st) {
  const r = await post('/agent', { agent: ag, action: 'herdr' }).catch((er) => ({ ok: false, out: er.message }));
  if (!r.ok) return avisa('Não abriu no Herdr', r.out || 'falhou');
  if (!r.manual) { st.textContent = r.out || ''; return; }
  try { await navigator.clipboard.writeText(r.cmd); } catch {}
  modal({ title: 'Ver este terminal no Herdr', text: `No Herdr, abra um terminal novo e cole (já está copiado):\n\n${r.cmd}\n\nVocê passa a ver e usar o terminal dele ali. Para soltar sem parar o agente: ctrl+\\\n\nDica: rodando só  hc  aparece a lista de todos os terminais para escolher.`, info: true });
}

// Terminal: Ctrl-C e abrir no app Herdr
document.getElementById('termCC')?.addEventListener('click', () => { try { if (tws && tws.readyState === 1) tws.send(JSON.stringify({ t: 'i', d: '\x03' })); else avisa('Terminal desconectado', 'Clique em reconectar e tente de novo.'); } catch {} term?.focus(); });
document.getElementById('termHerdr')?.addEventListener('click', async () => {
  const alvo = termQual === 'boss' ? 'boss' : 'andar';
  await abrirNoHerdr(alvo, document.getElementById('termSt'));
});

// ---------- "precisa de você": faixa no topo, aviso do Mac clicável e janela para responder ----------
function faixaBloqueio() {
  let el = document.getElementById('bloqFaixa');
  const bl = Object.entries(S.agents || {}).filter(([, a]) => a.status === 'blocked').map(([id]) => id);
  const pq = Object.entries(S.agents || {}).filter(([, a]) => a.status !== 'blocked' && a.pergunta).map(([id]) => id);
  if (!bl.length && !pq.length) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'bloqFaixa'; document.getElementById('office').appendChild(el); el.addEventListener('click', (e) => { const b = e.target.closest('[data-resp]'); if (b) return abrirResposta(b.dataset.resp); const f = e.target.closest('[data-fala]'); if (f) abrirConversa(f.dataset.fala); }); }
  const html = (bl.length ? `<b>⚠ ${bl.length === 1 ? esc(nmOf(bl[0])) + ' precisa de você' : bl.length + ' agentes precisam de você'}</b>${bl.map((id) => `<button data-resp="${esc(id)}">${bl.length > 1 ? esc(nmOf(id)) + ' · ' : ''}responder</button>`).join('')}` : '')
    + (pq.length ? `<b class="fq">❗ ${pq.length === 1 ? esc(nmOf(pq[0])) + ' quer falar com você' : pq.length + ' agentes querem falar com você'}</b>${pq.map((id) => `<button class="fq" data-fala="${esc(id)}">${pq.length > 1 ? esc(nmOf(id)) + ' · ' : ''}abrir conversa</button>`).join('')}` : '');
  el.classList.toggle('so-pergunta', !bl.length);
  if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; }
}
function avisaBloqueio(id) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
      const n = new Notification(`Orquestra · ${UI.title || ''}`, { body: `${nmOf(id)} precisa de você — clique para responder`, tag: 'bloq-' + PROJECT + '-' + id });
      n.onclick = () => { try { window.focus(); } catch {} n.close(); abrirResposta(id); };
    }
  } catch {}
}
async function abrirResposta(id, rascunho = '') {
  document.querySelector('.mbg.resp')?.remove();
  const bg = document.createElement('div'); bg.className = 'mbg resp';
  bg.innerHTML = `<div class="mdl wide frm" role="dialog" aria-modal="true" style="width:min(760px,95vw)"><h4>${esc(nmOf(id))} precisa de você</h4><div class="note">lendo a tela dele…</div></div>`;
  document.body.appendChild(bg);
  const fim = () => { bg.classList.add('out'); setTimeout(() => bg.remove(), 150); };
  let q; try { q = await fetch('/pergunta?' + qs({ p: PROJECT, agent: id }), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : r.text().then((x) => { throw new Error(x); }))); } catch (e) { bg.querySelector('.mdl').innerHTML = `<h4>${esc(nmOf(id))}</h4><p>${esc(e.message)}</p><div class="mact"><button class="mc">Fechar</button></div>`; bg.onclick = (ev) => { if (ev.target === bg || ev.target.classList.contains('mc')) fim(); }; return; }
  const livre = q.opcoes.some((o) => /type something|digite|outro|other/i.test(o.texto));
  const ops = q.opcoes.filter((o) => !/type something/i.test(o.texto));
  bg.querySelector('.mdl').innerHTML = `<h4>${esc(nmOf(id))} precisa de você${q.titulo ? ' — ' + esc(q.titulo) : ''}</h4>
    ${q.pergunta ? `<p style="margin:0 0 10px;font-size:14px">${esc(q.pergunta)}</p>` : ''}
    <details ${q.pergunta ? '' : 'open'}><summary class="note" style="cursor:pointer">o que ele estava fazendo (tela)</summary><pre style="background:#0b0908;border:1px solid var(--line);border-radius:8px;padding:8px;font-size:11.5px;white-space:pre-wrap;max-height:30vh;overflow:auto;margin:6px 0">${esc(q.contexto || '')}</pre></details>
    ${ops.length ? `<div style="display:flex;flex-direction:column;gap:6px;margin:10px 0">${ops.map((o) => `<button class="sb" data-op="${o.n}" style="text-align:left;padding:8px 10px;${o.atual ? 'border-color:var(--accent)' : ''}"><b>${o.n}. ${esc(o.texto)}</b>${o.desc ? `<div class="note" style="margin:2px 0 0">${esc(o.desc)}</div>` : ''}</button>`).join('')}</div>` : '<p class="note">Não achei opções na tela — escreva a resposta abaixo (ou abra a aba Tela/Terminal).</p>'}
    <label>${ops.length ? (livre ? 'Ou escreva a sua resposta' : 'Ou mande um texto') : 'Sua resposta'}</label><textarea id="rpT" rows="3" placeholder="⌘+Enter envia"></textarea>
    <div class="mact"><button class="sb" data-x="esc" title="Esc na tela dele: cancela a pergunta">Cancelar a pergunta</button><button class="sb" data-x="tela">Ver a tela</button><button class="mc">Fechar</button><button class="mo">Enviar texto</button></div>`;
  const manda = async (body) => {
    bg.querySelectorAll('button').forEach((b) => (b.disabled = true));
    const r = await post('/responder', { agent: id, ...body }).catch((er) => ({ ok: false, out: er.message }));
    if (!r.ok) { bg.querySelectorAll('button').forEach((b) => (b.disabled = false)); return avisa('Não respondeu', r.out || 'falhou'); }
    document.getElementById('sendSt').textContent = `${nmOf(id)}: ${r.out}`; fim();
  };
  bg.addEventListener('click', (e) => {
    if (e.target === bg || e.target.classList.contains('mc')) return fim();
    const op = e.target.closest('[data-op]'); if (op) return manda({ opcao: +op.dataset.op });
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'esc') return manda({ esc: true });
    if (x === 'tela') { fim(); return openScreen(id, 'tela'); }
    if (e.target.classList.contains('mo')) { const t = bg.querySelector('#rpT').value.trim(); if (!t) return bg.querySelector('#rpT').focus(); return manda({ texto: t }); }
  });
  if (rascunho) { const ta = bg.querySelector('#rpT'); ta.value = rascunho; bg.querySelector('.mdl h4').insertAdjacentHTML('afterend', '<p class="note" style="margin:0 0 8px">Ele está esperando esta resposta antes de qualquer outra mensagem. Sua mensagem ficou na caixa abaixo — escolha uma opção ou envie o texto como resposta.</p>'); }
  bg.querySelector('#rpT').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); bg.querySelector('.mo').click(); } });
}
// pergunta em texto (o agente terminou perguntando algo): abre a conversa com ele e marca como vista
function abrirConversa(id) {
  const q = S.agents[id]?.pergunta; openScreen(id, 'chat'); respostasRapidas(id, q);
  post('/agent', { agent: id, action: 'visto' }).catch(() => {}); setTimeout(() => document.getElementById('scrMsg')?.focus?.(), 200);
}
// respostas rápidas acima da caixa de mensagem: as opções que o agente deu, ou autorizar / não autorizar
function respostasRapidas(id, q) {
  let el = document.getElementById('scrQuick');
  if (!q || (!q.opcoes?.length && !q.autoriza)) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'scrQuick'; document.getElementById('scrCompose').before(el); }
  el.dataset.agent = id;
  const bts = [...(q.opcoes || []).map((o) => ({ t: `${o.n}. ${o.texto}`, msg: `Opção ${o.n}: ${o.texto}` })), ...(q.autoriza ? [{ t: '✓ Autorizo, pode seguir', msg: 'Autorizo — pode seguir.', cls: 'ok' }, { t: '✕ Não autorizo', msg: 'Não autorizo. Não faça isso; me explique as alternativas.', cls: 'no' }] : [])];
  el.innerHTML = `<div class="qh">${esc(nmOf(id))} está esperando sua resposta — clique numa opção ou escreva abaixo</div><div class="qb">${bts.map((b, i) => `<button class="sb ${b.cls || ''}" data-qi="${i}" title="${esc(b.msg)}">${esc(b.t)}</button>`).join('')}</div>`;
  el.onclick = async (e) => {
    const b = e.target.closest('[data-qi]'); if (!b) return; const m = bts[+b.dataset.qi].msg;
    el.querySelectorAll('button').forEach((x) => (x.disabled = true));
    const r = await fetch('/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': S.token || '' }, body: JSON.stringify({ project: PROJECT, agent: id, text: m }) });
    if (r.status === 409 && r.headers.get('X-Orq') === 'bloqueado') { el.remove(); return abrirResposta(id, m); }
    if (!r.ok) { el.querySelectorAll('button').forEach((x) => (x.disabled = false)); return avisa('Não enviou', await r.text()); }
    el.remove(); document.getElementById('sendSt').textContent = `enviado para ${nmOf(id)}: ${m}`;
  };
}
function avisaPergunta(id, q) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
      const n = new Notification(`Orquestra · ${UI.title || ''}`, { body: `${nmOf(id)} quer falar com você: ${q.trecho.slice(-120)}`, tag: 'perg-' + PROJECT + '-' + id });
      n.onclick = () => { try { window.focus(); } catch {} n.close(); abrirConversa(id); };
    }
  } catch {}
}
labelsLayer.addEventListener('click', (e) => { const l = e.target.closest('.label[data-id]'); if (!l) return; const a = S.agents[l.dataset.id]; if (a?.status === 'blocked') return abrirResposta(l.dataset.id); if (a?.pergunta) return abrirConversa(l.dataset.id); });

// ---------- o Orquestra foi atualizado: avisa e oferece recarregar (o servidor se reinicia sozinho quando o código muda) ----------
let VER_ORQ = null;
async function checaVersao() { try { const h = await fetch('/health', { cache: 'no-store' }).then((r) => r.json()); const v = h.code + ':' + (h.pub || 0); if (VER_ORQ && v !== VER_ORQ) mostraAtualizou(); if (!VER_ORQ) VER_ORQ = v; } catch {} }
function mostraAtualizou() {
  if (document.getElementById('atualizouT')) return;
  const d = document.createElement('div'); d.id = 'atualizouT';
  d.innerHTML = '<span>✨ O Orquestra foi atualizado</span><button>Recarregar</button><button class="x" title="depois">✕</button>';
  d.querySelector('button').onclick = () => location.reload(); d.querySelector('.x').onclick = () => d.remove();
  document.body.appendChild(d);
}
checaVersao();
