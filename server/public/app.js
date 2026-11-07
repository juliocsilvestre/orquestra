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
const STATUS_TXT = { working: 'trabalhando', blocked: 'precisa de você', done: 'terminou', idle: 'aguardando', unknown: '—' };

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
const SPOT = { taiga: new THREE.Vector3(-16.5, 0, -10.2), logs: new THREE.Vector3(-7.5, 0, -10.2), qa: new THREE.Vector3(-16.5, 0, -2.2), gitlab: new THREE.Vector3(-16.5, 0, 5.2), github: new THREE.Vector3(-16.5, 0, 5.2) };
const SPARE = [new THREE.Vector3(-16.5, 0, 12.2), new THREE.Vector3(-7.5, 0, -3.5), new THREE.Vector3(14.5, 0, -9.8)];
const SPECIAL_DESK = {};
{ const usados = new Set(); const k = (v) => v.x + ',' + v.z;
  const BY_DECOR = { kanban: SPOT.taiga, screen: SPOT.logs, qa: SPOT.qa, gitlab: SPOT.gitlab };
  for (const id of Object.keys(SPECIAL)) { let p = SPOT[id] || BY_DECOR[SPECIAL[id].decor]; if (!p || usados.has(k(p))) p = SPARE.find((x) => !usados.has(k(x))) || SPARE[0]; usados.add(k(p)); SPECIAL_DESK[id] = p; } }
const SPECIAL_POS = Object.values(SPECIAL_DESK);
const DOOR = new THREE.Vector3(W / 2 - 1.5, 0, D / 2 - 1.2);
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
    <select id="roomSel">${ROOMS.map((r, i) => `<option value="${esc(r.id)}" ${r.id === PROJECT ? 'selected' : ''}>${i + 1}º · ${esc(r.brand)}${r.blocked ? ' (!)' : r.working ? ' (…)' : ''}</option>`).join('')}</select>`;
  document.getElementById('roomSel').onchange = (e) => e.target.value !== PROJECT && goRoom(e.target.value);
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
function removeChar(c) {
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
  c.bubble.innerHTML = `<small>${esc(k.label)}</small>${esc(e.text || '')}`;
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
  if (!hit) return;
  for (const c of chars.values()) { let o = hit.object; while (o) { if (o === c.g) { if (selected === c.id) return openScreen(c.id); return select(c.id); } o = o.parent; } }
});
addEventListener('pointerup', () => { drag = null; renderer.domElement.style.cursor = 'grab'; });
addEventListener('pointermove', (e) => { if (drag == null) return; az -= (e.clientX - drag) * 0.006; drag = e.clientX; placeCamera(); });
renderer.domElement.addEventListener('wheel', (e) => { e.preventDefault(); zoom = Math.min(2.6, Math.max(0.6, zoom * (e.deltaY > 0 ? 0.92 : 1.08))); resize(); }, { passive: false });

// ---------------- UI ----------------
function syncChars() {
  const live = new Set(Object.keys(S.agents));
  for (const id of live) {
    const c = ensureChar(id), a = S.agents[id];
    if (a.status === 'done' && c.prevStatus !== 'done' && c.prevStatus) c.hopT = 1.2;
    c.prevStatus = c.status; c.status = a.status;
    const { title } = parseId(id);
    const st = a.status;
    c.label.className = 'label' + (st === 'blocked' ? ' blocked' : '');
    c.label.innerHTML = `<span class="dot" style="background:${hex(colorFor(id))}"></span>${esc(title)}${st === 'blocked' ? ' · precisa de você' : st === 'done' ? ' ✓' : ''}`;
  }
  for (const c of chars.values()) if (!live.has(c.id) && !c.leaving) removeChar(c);
  document.getElementById('empty').style.display = S.hcOk && !live.has('boss') ? 'block' : 'none';
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
    if (!r.ok) throw new Error(await r.text());
    ta.value = ''; st.textContent = 'enviado para ' + (to === 'boss' ? 'Boss' : SPECIAL[to]?.title || to);
  } catch (err) { st.textContent = 'erro: ' + err.message; }
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
    if (action === 'restart' && !(await confirma(`Reiniciar ${nm}?`, 'Ele sai e volta com o contexto limpo (as instruções e a mesa continuam as mesmas).', false, 'Reiniciar'))) return;
    const st = document.getElementById('sendSt'); st.textContent = (action === 'start' ? 'chamando ' : action === 'stop' ? 'dispensando ' : 'reiniciando ') + nm + '…';
    b.disabled = true;
    try {
      const r = await fetch('/agent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': S.token || '' }, body: JSON.stringify({ project: PROJECT, agent: ag, action }) });
      const j = await r.json().catch(() => ({}));
      st.textContent = r.ok ? (action === 'start' ? `${nm} está vindo` : action === 'stop' ? `${nm} dispensado` : `${nm} reiniciado`) : (j.out || 'falhou');
      if (!r.ok && ag === 'boss') avisa('Como chamar o Boss', j.out);
    } catch (err) { st.textContent = 'erro: ' + err.message; }
    b.disabled = false;
    return;
  }
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
  if (tabName === 'sess') loadSess(viewAgent);
  clearInterval(screenTimer);
  if (tabName === 'tela') { loadScreen(viewAgent); screenTimer = setInterval(() => loadScreen(viewAgent), 2000); }
}
function openScreen(id, tabName = 'chat') {
  viewAgent = id;
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
      <div class="tt"><div class="nm" style="opacity:.6">${esc(nm)}</div></div><span class="pill st-off">fora do ar</span>
      ${id === 'boss' ? `<button class="ab" data-ag="start" data-agent="boss" title="O Boss roda no seu terminal">como chamar?</button>` : `<button class="ab go" data-ag="start" data-agent="${esc(id)}">chamar</button>`}</div></div>`;
  };
  const card = (id) => {
    if (!S.agents[id]) return offCard(id);
    const a = S.agents[id], u = S.usage[id] || {}, { repo, slug } = parseId(id);
    const sp = SPECIAL[id];
    const nm = id === 'boss' ? 'Boss' : sp ? sp.title : LABEL(repo);
    const sub = id === 'boss' ? 'orquestra, divide e revisa' : sp ? sp.sub : slug ? 'extra · ' + slug : 'dev residente';
    const open = selected === id || a.status === 'working' || a.status === 'blocked';
    const acc = ACCTS.find((x) => x.id === (a.conta || u.conta));
    const conta = acc ? (acc.email ? acc.email.split('@')[0] : acc.id) : a.conta || u.conta || '';
    return `<div class="card ${a.status} ${selected === id ? 'sel' : ''} ${open ? '' : 'mini'}" data-id="${esc(id)}">
      <div class="top"><div class="sw" style="background:${hex(colorFor(id))}"></div>
        <div class="tt"><div class="nm">${esc(nm)}</div>${open ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
        <span class="pill st-${a.status}">${STATUS_TXT[a.status] || a.status}</span></div>
      ${open ? `${a.title ? `<div class="task" title="${esc(a.title)}">${esc(clip(a.title, 90))}</div>` : ''}
      <div class="chips"><span class="chip tela" data-screen="${esc(id)}">conversa</span>${conta ? `<span class="chip" title="${esc(acc?.email || '')}">${esc(conta)}</span>` : ''}${a.model || u.model ? `<span class="chip">${esc(String(a.model || u.model).replace('claude-', ''))}</span>` : ''}${a.ctx != null ? `<span class="chip" title="contexto usado">ctx ${a.ctx}%</span>` : ''}${id !== 'boss' && S.rework[id] ? `<span class="chip">${S.rework[id]} ajuste(s)</span>` : ''}</div>
      ${id === 'boss' ? '' : `<div class="acts"><button class="ab" data-ag="restart" data-agent="${esc(id)}" title="encerra e sobe de novo com contexto limpo">reiniciar</button><button class="ab stop" data-ag="stop" data-agent="${esc(id)}">dispensar</button></div>`}
      ${!u.msgs ? '' : `<div class="stats"><div>Hoje<b>${fmtUsd(u.today?.cost)}</b></div><div>Tokens hoje<b>${fmtTok((u.today?.in || 0) + (u.today?.out || 0))}</b></div><div>Turnos<b>${a.turn}</b></div></div>`}` : ''}
    </div>`;
  };
  const html = grupos.filter(([, , l]) => l.length).map(([k, t, l]) => {
    const ativos = l.filter((i) => ['working', 'blocked'].includes(S.agents[i]?.status)).length;
    const fora = l.filter((i) => !S.agents[i]).length;
    return groupHead('side-' + k, t, `${l.length}${ativos ? ` · ${ativos} ativo(s)` : ''}${fora ? ` · ${fora} fora do ar` : ''}`) + (isFolded('side-' + k) ? '' : l.map(card).join(''));
  }).join('');
  if (html !== side.dataset.h) { side.dataset.h = html; side.innerHTML = html; }
}

function renderFeed() {
  const el = document.getElementById('feed');
  const shown = feed.filter((e) => e.kind !== 'wait');
  const head = groupHead('feed', 'Mensagens da equipe', `${shown.length} · últimas 4`, false);
  if (isFolded('feed', false)) { el.innerHTML = head; return; }
  el.innerHTML = head + shown.slice(-4).map((e) => {
    const k = KIND[e.kind] || { label: e.kind, css: 'var(--accent)' };
    const nm = (id) => (id === 'boss' ? 'Boss' : id ? parseId(id).title : '?');
    const time = new Date(e.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `<div class="fi" style="--k:${k.css}" title="${esc(tidy(e.text))}"><div class="h">${time} · ${esc(nm(e.from))} → ${esc(nm(e.to))} · <b>${esc(k.label)}</b></div><div class="ft">${esc(clip(e.text, 140))}</div></div>`;
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
  const html = contasUnicas().filter((a) => a.ids.some((i) => usadas.has(i)) || a.users.some((u) => u.project === PROJECT)).map((a) => `<span class="acct" data-go-uso="1" title="${esc(a.email || a.id)} — clique para ver o uso">${esc(a.email ? a.email.split('@')[0] : a.id)} <i class="mb"><i style="width:${Math.min(100, a.h5 || 0)}%;background:${corUso(a.h5 || 0)}"></i></i> ${a.h5 ?? '–'}%</span>`).join('');
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
function painelUso() {
  if (!ACCTS.length) return '<div class="note">Sem dados de conta ainda.</div>';
  const unicas = contasUnicas();
  const dup = unicas.filter((a) => a.ids.length > 1);
  const aviso = dup.length ? `<div class="box warn"><b>Atenção:</b> ${dup.map((a) => `as configurações <b>${a.ids.join(' e ')}</b> estão logadas na <b>mesma conta</b> (${esc(a.email)})`).join('; ')}. Na prática todos os agentes estão gastando o mesmo limite. Para usar a outra conta: <code>CLAUDE_CONFIG_DIR=~/.claude-conta2 claude</code> → <code>/login</code> com o outro e-mail → <code>/status</code> para conferir.</div>` : '';
  return aviso + `<div class="usage">${unicas.map((a) => {
    const meus = a.users.filter((u) => u.project === PROJECT).map((u) => nmA(u.agent));
    const outros = a.users.filter((u) => u.project !== PROJECT).length;
    const medido = a.metersAt ? `medido às ${hhmm(a.metersAt)}` : 'sem medição ainda (abra uma sessão no Herdr)';
    const linha = (rot, v, reset, quando) => `<div class="um"><div class="ut"><b>${rot}</b><span>${v == null ? '–' : v + '% usado'}</span></div>
      <div class="ub"><i style="width:${Math.min(100, v || 0)}%;background:${corUso(v || 0)}"></i></div>
      <div class="note" style="margin:4px 0 0">${reset ? `renova ${quando} · ${falta(reset)} (estimado)` : 'renovação: sem dados suficientes'}</div></div>`;
    return `<div class="box uc"><h3>${esc(a.email || a.id)} <span class="note" style="font-weight:400">${esc(a.org || '')} · ${a.ids.join(' + ')}</span></h3>
      ${linha('Sessão atual (5 horas)', a.h5, a.reset5, 'às ' + hhmm(a.reset5))}
      ${linha('Semana (7 dias)', a.d7, a.reset7, a.reset7 ? new Date(a.reset7).toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')}
      <div class="ux"><span>Agentes desta sala: <b>${meus.join(', ') || '—'}</b>${outros ? ` · +${outros} em outra sala` : ''}</span><span>Tokens hoje: <b>${fmtTok(a.tokToday)}</b></span></div>
      <div class="note">${medido}</div></div>`;
  }).join('')}</div>
  <div class="note">Mesma informação do <code>/usage</code> do Claude: % medido pela própria sessão (session-bar). Horários de renovação são estimados pelo histórico de mensagens. Trocou de conta com <code>/login</code>? Aparece aqui em até 30 s e o contexto dos agentes continua.</div>`;
}
function painelAgentes() {
  const U = S.usage || {};
  const ids = [...new Set([...Object.keys(S.agents || {}), ...Object.keys(U)])].sort(byOrder);
  const hoje = new Date().toDateString();
  const cont = (id, f) => feed.filter((e) => (e.from === id || e.to === id) && f(e)).length;
  const rows = ids.map((id) => {
    const a = S.agents[id] || {}, u = U[id] || {};
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
  if (tab === 'office') resize(); else renderPanel();
}));

// ---------------- stream ----------------
function connect() {
  const es = new EventSource('/stream?p=' + encodeURIComponent(PROJECT));
  window.bootStep?.('conectando ao servidor…');
  es.addEventListener('init', (m) => { window.bootStep?.('recebendo a equipe…'); const d = JSON.parse(m.data); feed = d.interactions || []; S = d; ROOMS = d.rooms || []; ACCTS = d.accounts || []; renderAll(); renderRooms(); booted = true; window.bootDone?.().then?.(() => { if (window.__lento) toast({ kind: 'servico', from: 'voce', text: window.__lento }); }); });
  es.addEventListener('rooms', (m) => { ROOMS = JSON.parse(m.data); renderRooms(); });
  es.addEventListener('state', (m) => { S = { ...S, ...JSON.parse(m.data) }; renderAll(); });
  es.addEventListener('activity', (m) => onActivity(JSON.parse(m.data)));
  es.addEventListener('accounts', (m) => { ACCTS = JSON.parse(m.data); renderAccounts(); renderSide(); if (tab === 'panel') renderPanel(); });
  es.addEventListener('interaction', (m) => { const e = JSON.parse(m.data); feed.push(e); if (feed.length > 300) feed.shift(); renderFeed(); renderFlow(); if (tab === 'panel') renderPanel(); playInteraction(e); });
  es.onerror = () => { S.hcOk = false; renderHeader(); };
}

resize();
connect();
tick();
