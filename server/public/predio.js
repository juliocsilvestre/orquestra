import * as THREE from './three.module.min.js';

// ======================= Prédio do Estúdio =======================
// Térreo = recepção (recepcionista + diretório). Um andar por projeto, com o escritório visível pelo vidro.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtUsd = (v) => 'US$ ' + (v || 0).toFixed(2).replace('.', ',');
const hexs = (n) => '#' + n.toString(16).padStart(6, '0');
const ST_COLOR = { working: 0x5aa9ff, blocked: 0xff4d4d, done: 0x4fd18b, idle: 0xe9d8c4, unknown: 0x9a8e83 };
function roomColor(r) {
  if (r.accent) return parseInt(r.accent.replace('#', ''), 16);
  let h = 0; for (const c of r.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.55, 0.58).getHex();
}
const roomState = (r) => (r.blocked ? 'blocked' : r.working ? 'working' : r.live ? 'live' : 'off');

window.bootStep?.('montando o prédio…'); document.getElementById('cfgBtn')?.remove();
// ---------- página ----------
document.title = 'Orquestra · Prédio';
document.querySelector('header h1').innerHTML = 'Orquestra <span>Prédio</span>';
document.querySelectorAll('.tabs button[data-tab]').forEach((b) => (b.style.display = 'none'));
document.getElementById('composer').style.display = 'none';
document.getElementById('feed').style.display = 'none';
const host = document.getElementById('office');
const recep = document.createElement('div'); recep.id = 'recep'; host.appendChild(recep);
const style = document.createElement('style');
style.textContent = `
#recep{position:absolute;left:16px;top:16px;width:min(430px,46%);max-height:calc(100% - 32px);overflow:auto;background:rgba(24,20,17,.95);border:1px solid var(--line);border-radius:14px;padding:14px;display:none;box-shadow:0 14px 40px rgba(0,0,0,.5);z-index:4}
#recep .hd{display:flex;align-items:center;gap:10px;margin-bottom:10px}#recep .av{width:34px;height:34px;border-radius:9px;background:#2ec4b6;display:grid;place-items:center;font-weight:700;color:#0d1f1d}
#recep .hd b{font-size:15px}#recep .hd small{display:block;color:var(--muted)}#recep .x{margin-left:auto;background:none;border:1px solid var(--line);color:var(--text);border-radius:7px;padding:3px 9px;cursor:pointer}
#recep .fl{border:1px solid var(--line);border-radius:11px;padding:10px 12px;margin-top:8px;background:var(--panel2)}#recep .fl.blocked{border-color:var(--blocked)}
#recep .fl .t{display:flex;align-items:center;gap:8px}#recep .fl .n{font-weight:600}#recep .fl .num{font-size:11px;color:var(--muted)}
#recep .fl p{margin:6px 0;color:#cfc6bd;font-size:12.5px}#recep .fl .meta{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--muted)}
#recep .fl .meta b{color:var(--text)}#recep .fl button{margin-left:auto;background:var(--accent);border:0;color:#1b1612;font-weight:600;border-radius:8px;padding:5px 12px;cursor:pointer}
#recep .team{display:flex;gap:3px;flex-wrap:wrap;margin-top:6px}#recep .team i{width:9px;height:9px;border-radius:3px;display:inline-block}
.label.floor{pointer-events:none;font-size:12px}.label.hov{border-color:var(--accent);color:#fff}.label.recep{border-color:#2ec4b6}`;
document.head.appendChild(style);

// ---------- cena ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
host.prepend(renderer.domElement);
const scene = new THREE.Scene();
{
  const c = document.createElement('canvas'); c.width = 4; c.height = 256;
  const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#0c1424'); gr.addColorStop(0.55, '#1b1f2e'); gr.addColorStop(1, '#2a1f19');
  g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; scene.background = t;
}
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
let az = Math.PI / 4.3, zoom = 1, targetY = 8, camY = 8, focusX = 0, panX = 0, elev = 30, elevT = 30;
scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x2a1d14, 0.75));
scene.add(new THREE.AmbientLight(0xffffff, 0.15));
const sun = new THREE.DirectionalLight(0xffe0c0, 1.5);
sun.position.set(30, 60, 40); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 80, bottom: -20, far: 200 });
scene.add(sun);

const M = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, ...o });
function box(w, h, d, c, x, y, z, parent = scene, m) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m || M(c));
  mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
function textTex(lines, { w = 1024, h = 256, bg = '#111', fg = '#f3ece4', accent = null, sizes = [100, 44], colors = null, align = 'left' } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  if (accent) { g.fillStyle = accent; g.fillRect(0, 0, 16, h); }
  g.textAlign = align; const x = align === 'center' ? w / 2 : 46;
  let y = sizes[0] + (h - sizes.reduce((a, b) => a + b * 1.15, 0)) / 2;
  lines.forEach((l, i) => { g.fillStyle = colors?.[i] || (i ? '#e8875a' : fg); g.font = `${i ? 600 : 'bold'} ${sizes[i] || 40}px -apple-system, Inter, sans-serif`; g.fillText(l, x, y); y += (sizes[i + 1] || 40) * 1.2; });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const plane = (w, h, tex, parent, x, y, z, ry = 0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true })); m.position.set(x, y, z); m.rotation.y = ry; parent.add(m); return m; };

// ---------- personagem (bloquinho) ----------
function mini(color, s = 0.55, parent, x = 0, z = 0, extra = {}) {
  const g = new THREE.Group(); g.position.set(x, 0, z); parent.add(g);
  const m = M(color, { roughness: 0.5, emissive: color, emissiveIntensity: 0.12 });
  box(1.3 * s, 1.2 * s, 1 * s, 0, 0, 1.25 * s, 0, g, m);
  for (const sx of [-1, 1]) { box(0.16 * s, 0.24 * s, 0.05, 0x15121a, sx * 0.28 * s, 1.4 * s, 0.51 * s, g); box(0.3 * s, 0.6 * s, 0.3 * s, 0, sx * 0.35 * s, 0.35 * s, 0, g, m); }
  if (extra.headset) { box(1.45 * s, 0.12 * s, 0.2 * s, 0x222222, 0, 1.92 * s, 0, g); box(0.12 * s, 0.35 * s, 0.25 * s, 0x222222, -0.72 * s, 1.55 * s, 0, g); box(0.35 * s, 0.08 * s, 0.08 * s, 0x222222, -0.6 * s, 1.3 * s, 0.45 * s, g); }
  if (extra.cap) box(0.9 * s, 0.18 * s, 0.9 * s, 0x2b2b2b, 0, 1.95 * s, 0, g);
  g.userData.mat = m; return g;
}

// ---------- praça ----------
const FW = 18, FD = 12, FH = 3.6, LH = 4.8;
box(160, 0.4, 160, 0x1b1714, 0, -0.2, 0).castShadow = false;
box(40, 0.12, 32, 0x3a332d, 0, 0.06, 2).castShadow = false;
box(36, 0.13, 28, 0x463e37, 0, 0.07, 2).castShadow = false;
box(4, 0.14, 9, 0x5b524b, 0, 0.08, FD / 2 + 4.5).castShadow = false; // caminho até a entrada
function tree(x, z, s = 1) {
  box(0.35 * s, 1.6 * s, 0.35 * s, 0x6b4a33, x, 0.8 * s, z);
  const c1 = new THREE.Mesh(new THREE.IcosahedronGeometry(1.4 * s, 0), M(0x3f8f4f, { flatShading: true })); c1.position.set(x, 2.4 * s, z); c1.castShadow = true; scene.add(c1);
  const c2 = new THREE.Mesh(new THREE.IcosahedronGeometry(1 * s, 0), M(0x4fa55d, { flatShading: true })); c2.position.set(x + 0.3 * s, 3.3 * s, z - 0.2 * s); c2.castShadow = true; scene.add(c2);
}
const lamps = [];
function lamp(x, z) { box(0.14, 3.2, 0.14, 0x2b2b2b, x, 1.6, z); const b = box(0.5, 0.5, 0.5, 0, x, 3.35, z, scene, M(0xffe2a8, { emissive: 0xffd28a, emissiveIntensity: 1.2 })); lamps.push(b); }
function bench(x, z, ry = 0) { const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; scene.add(g); box(2.4, 0.15, 0.7, 0x8a5a3a, 0, 0.6, 0, g); box(2.4, 0.6, 0.12, 0x8a5a3a, 0, 1, -0.3, g); box(0.12, 0.6, 0.6, 0x2b2b2b, -1, 0.3, 0, g); box(0.12, 0.6, 0.6, 0x2b2b2b, 1, 0.3, 0, g); }
[[-15, 13], [15, 13], [-15, -9], [15, -9], [-15, 2], [15, 2]].forEach(([x, z], i) => tree(x, z, i % 2 ? 1 : 1.2));
[[-4, 14.5], [4, 14.5], [-12, 8], [12, 8]].forEach(([x, z]) => lamp(x, z));
bench(-8, 13.5); bench(8, 13.5);

// ---------- térreo / recepção ----------
const lobby = new THREE.Group(); scene.add(lobby);
box(FW + 0.6, 0.3, FD + 0.6, 0x6b625a, 0, 0.15, 0, lobby);
box(FW - 0.2, 0.05, FD - 0.2, 0xd8cfc4, 0, 0.32, 0, lobby).castShadow = false; // piso claro
box(FW, LH, 0.3, 0x2b2420, 0, LH / 2, -FD / 2, lobby); // fundo
box(0.3, LH, FD, 0x2b2420, -FW / 2, LH / 2, 0, lobby); // esquerda
for (const [x, z] of [[-FW / 2, -FD / 2], [FW / 2, -FD / 2], [-FW / 2, FD / 2], [FW / 2, FD / 2]]) box(0.6, LH, 0.6, 0x4a423c, x, LH / 2, z, lobby);
const glassL = new THREE.MeshStandardMaterial({ color: 0x9fc4e8, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.18 });
box(FW - 0.6, LH - 0.3, 0.08, 0, 0, LH / 2, FD / 2, lobby, glassL);
box(0.08, LH - 0.3, FD - 0.6, 0, FW / 2, LH / 2, 0, lobby, glassL);
for (let x = -FW / 2 + 1.5; x < FW / 2; x += 3) box(0.1, LH, 0.12, 0x2b2b2b, x, LH / 2, FD / 2, lobby);
box(3.6, 3.2, 0.1, 0, 0, 1.75, FD / 2 + 0.06, lobby, M(0x9fc4e8, { transparent: true, opacity: 0.3, metalness: 0.4 })); // portas
box(7, 0.25, 2.2, 0x3a332d, 0, LH - 0.4, FD / 2 + 1.1, lobby); // marquise
plane(6.6, 0.7, textTex(['ORQUESTRA'], { w: 1024, h: 110, bg: '#1b1714', sizes: [80], align: 'center' }), lobby, 0, LH - 0.4, FD / 2 + 2.22);
// balcão
box(6, 1.1, 1.1, 0xf3ece4, 0, 0.85, -1.2, lobby); box(6.3, 0.12, 1.3, 0x8a5a3a, 0, 1.45, -1.2, lobby);
box(1.1, 1.1, 2.6, 0xf3ece4, -3.4, 0.85, -0.05, lobby).rotation.y = 0.35; box(1.1, 1.1, 2.6, 0xf3ece4, 3.4, 0.85, -0.05, lobby).rotation.y = -0.35;
box(0.8, 0.5, 0.06, 0x111111, 1.2, 1.75, -1.5, lobby, M(0x222831, { emissive: 0x3d7dff, emissiveIntensity: 0.6 }));
const receptionist = mini(0x2ec4b6, 0.75, lobby, 0, -2.6, { headset: true }); receptionist.rotation.y = 0;
// elevadores
for (const x of [-2.2, 2.2]) { box(2, 3.4, 0.15, 0, x, 2, -FD / 2 + 0.25, lobby, M(0xb8bec6, { metalness: 0.7, roughness: 0.3 })); box(2.4, 0.4, 0.2, 0x111111, x, 3.95, -FD / 2 + 0.27, lobby, M(0x111111, { emissive: 0xf2c14e, emissiveIntensity: 0.25 })); }
// plantas
for (const [x, z] of [[-7.5, 4.5], [7.5, 4.5], [-7.5, -4.5]]) { box(1, 1, 1, 0xd46a3a, x, 0.8, z, lobby); const c = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8, 0), M(0x3f8f4f, { flatShading: true })); c.position.set(x, 1.9, z); lobby.add(c); }
// diretório (painel na parede esquerda)
let directory = null;
const lobbyLabel = document.createElement('div'); lobbyLabel.className = 'label recep'; host.appendChild(lobbyLabel);
const recepBubble = document.createElement('div'); recepBubble.className = 'bubble'; recepBubble.style.setProperty('--k', '#2ec4b6'); host.appendChild(recepBubble);

// ---------- andares ----------
let floors = [], roof = null;
const floorBase = (i) => LH + i * FH;
function build(rooms) {
  for (const f of floors) { scene.remove(f.group); f.label.remove(); }
  if (roof) scene.remove(roof);
  floors = [];
  rooms.forEach((r, i) => {
    const y = floorBase(i), col = roomColor(r);
    const g = new THREE.Group(); g.position.y = y; scene.add(g);
    box(FW + 0.8, 0.45, FD + 0.8, 0x6b625a, 0, 0, 0, g); // laje
    box(FW + 0.82, 0.12, FD + 0.82, 0, 0, -0.1, 0, g, M(col, { emissive: col, emissiveIntensity: 0.25 })); // friso na cor do projeto
    box(FW - 0.2, 0.05, FD - 0.2, 0xcbb9a6, 0, 0.25, 0, g, M(0xcbb9a6, { emissive: 0xffe2b0, emissiveIntensity: r.live ? 0.18 : 0.02 })).castShadow = false; // piso
    const wallM = M(0x7a6656, { emissive: 0xffd9a8, emissiveIntensity: r.live ? 0.22 : 0.03 });
    box(FW, FH, 0.3, 0, 0, FH / 2, -FD / 2, g, wallM); box(0.3, FH, FD, 0, -FW / 2, FH / 2, 0, g, wallM);
    for (const [x, z] of [[-FW / 2, -FD / 2], [FW / 2, -FD / 2], [-FW / 2, FD / 2], [FW / 2, FD / 2]]) box(0.55, FH, 0.55, 0x4a423c, x, FH / 2, z, g);
    const lightMat = M(0xfff1d6, { emissive: 0xffe2b0, emissiveIntensity: r.live ? 0.9 : 0.12 });
    box(FW - 3, 0.08, 0.6, 0, 0, FH - 0.15, -1, g, lightMat); box(FW - 3, 0.08, 0.6, 0, 0, FH - 0.15, 2.5, g, lightMat);
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fc4e8, roughness: 0.05, metalness: 0.25, transparent: true, opacity: 0.16, emissive: col, emissiveIntensity: 0 });
    box(FW - 0.5, FH - 0.5, 0.08, 0, 0, FH / 2 + 0.2, FD / 2, g, glassMat);
    box(0.08, FH - 0.5, FD - 0.5, 0, FW / 2, FH / 2 + 0.2, 0, g, glassMat);
    for (let x = -FW / 2 + 1.5; x < FW / 2; x += 1.5) box(0.08, FH, 0.1, 0x2b2b2b, x, FH / 2, FD / 2, g);
    for (let z = -FD / 2 + 1.5; z < FD / 2; z += 1.5) box(0.1, FH, 0.08, 0x2b2b2b, FW / 2, FH / 2, z, g);
    // escritório: uma mesa + bonequinho por membro da equipe
    const team = (r.team && r.team.length ? r.team : (r.statuses || []).map((st, k) => ({ id: k ? 'a' + k : 'boss', status: st })));
    const minis = [];
    const n = team.length, cols = Math.min(6, Math.max(2, Math.ceil(Math.sqrt(n * 1.6)))), rowsN = Math.ceil(n / cols);
    team.forEach((m, k) => {
      const isBoss = m.id === 'boss';
      const cx = isBoss ? -FW / 2 + 2.6 : -FW / 2 + 5.2 + (k - 1) % cols * ((FW - 7) / cols);
      const cz = isBoss ? -FD / 2 + 2.4 : -FD / 2 + 3 + Math.floor((k - 1) / cols) * Math.min(3, (FD - 4) / Math.max(1, rowsN));
      box(1.6, 0.12, 0.8, 0x8a5a3a, cx, 0.95, cz + 0.75, g); box(0.8, 0.5, 0.06, 0x111111, cx, 1.35, cz + 1.0, g);
      const st = m.status || 'off';
      const c = st === 'off' ? 0x5a524b : isBoss ? 0xf2b544 : ST_COLOR[st] || 0x9a8e83;
      const fig = mini(c, isBoss ? 0.85 : 0.7, g, cx, cz, { cap: isBoss });
      fig.userData.status = st; fig.userData.base = 0.3; fig.position.y = 0.3;
      minis.push(fig);
    });
    // placas
    const sign = plane(6.4, 1.6, textTex([r.brand, `${i + 1}º andar`], { accent: hexs(col) }), g, -FW / 2 + 3.6, FH / 2 + 0.3, FD / 2 + 0.12);
    plane(2.2, 1.6, textTex([`${i + 1}º`], { w: 300, h: 220, bg: hexs(col), fg: '#14110f', sizes: [140], align: 'center' }), g, FW / 2 + 0.12, FH / 2 + 0.3, FD / 2 - 1.4, Math.PI / 2);
    const bandMat = M(0xff3b3b, { emissive: 0xff3b3b, emissiveIntensity: 1 });
    const band = new THREE.Group(); g.add(band);
    box(FW + 1, 0.2, 0.2, 0, 0, 0.05, FD / 2 + 0.45, band, bandMat); box(FW + 1, 0.2, 0.2, 0, 0, 0.05, -FD / 2 - 0.45, band, bandMat);
    box(0.2, 0.2, FD + 1, 0, FW / 2 + 0.45, 0.05, 0, band, bandMat); box(0.2, 0.2, FD + 1, 0, -FW / 2 - 0.45, 0.05, 0, band, bandMat);
    band.userData.mat = bandMat;
    const label = document.createElement('div'); label.className = 'label floor'; host.appendChild(label);
    floors.push({ room: r, group: g, glassMat, lightMat, band, label, minis, y, sign });
  });
  // telhado
  const top = floorBase(rooms.length);
  roof = new THREE.Group(); roof.position.y = top; scene.add(roof);
  box(FW + 0.8, 0.45, FD + 0.8, 0x6b625a, 0, 0, 0, roof);
  for (const [w, d, x, z] of [[FW + 0.8, 0.3, 0, FD / 2 + 0.25], [FW + 0.8, 0.3, 0, -FD / 2 - 0.25], [0.3, FD + 0.8, FW / 2 + 0.25, 0], [0.3, FD + 0.8, -FW / 2 - 0.25, 0]]) box(w, 0.9, d, 0x5b524b, x, 0.6, z, roof);
  const heli = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 0.08, 40), M(0x2f3a45)); heli.position.set(3.5, 0.27, 0); roof.add(heli);
  const H = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ map: textTex(['H'], { w: 256, h: 256, bg: null, fg: '#f3ece4', sizes: [200], align: 'center' }), transparent: true }));
  H.rotation.x = -Math.PI / 2; H.position.set(3.5, 0.33, 0); roof.add(H);
  for (const [x, z] of [[-6, -3.5], [-6, 0], [-6, 3.5]]) { box(2.4, 0.6, 1.2, 0x6b4a33, x, 0.5, z, roof); const c = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 0), M(0x4fa55d, { flatShading: true })); c.position.set(x, 1.1, z); roof.add(c); }
  box(0.15, 4, 0.15, 0x999999, -FW / 2 + 1.2, 2.2, -FD / 2 + 1.2, roof);
  roof.userData.beacon = box(0.35, 0.35, 0.35, 0, -FW / 2 + 1.2, 4.3, -FD / 2 + 1.2, roof, M(0xff3b3b, { emissive: 0xff3b3b, emissiveIntensity: 1 }));
  // diretório do térreo
  if (directory) lobby.remove(directory);
  const lines = ['DIRETÓRIO', ...[...rooms].map((r, i) => ({ r, i })).reverse().map(({ r, i }) => `${i + 1}º  ${r.brand}`)];
  directory = plane(3.6, Math.min(4, 0.9 + rooms.length * 0.35), textTex(lines, { w: 512, h: 120 + rooms.length * 70, bg: '#14110f', sizes: [56, ...rooms.map(() => 46)], colors: ['#e8875a', ...rooms.map(() => '#f3ece4')] }), lobby, -FW / 2 + 0.2, 2.6, 2.5, Math.PI / 2);
  fitAll();
}
function fitAll() {
  const top = floorBase(floors.length) + 4;
  targetY = top / 2; focusX = 0;
  zoom = Math.min(1.2, 30 / (top * 0.78 + 14));
  fit();
}
function fit() {
  const w = host.clientWidth, h = host.clientHeight;
  renderer.setSize(w, h);
  const half = 16 / zoom, aspect = w / h;
  const off = panX * half * aspect;
  Object.assign(camera, { left: -half * aspect - off, right: half * aspect - off, top: half, bottom: -half });
  camera.updateProjectionMatrix();
}
function placeCamera() { camera.position.set(focusX + Math.sin(az) * 80, camY + elev, Math.cos(az) * 80); camera.lookAt(focusX, camY, 0); }
addEventListener('resize', fit);

// ---------- interação ----------
let drag = null, downX = 0, hover = null, hoverRecep = false;
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
const within = (obj, root) => { let o = obj; while (o) { if (o === root) return true; o = o.parent; } return false; };
function pick(e) {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects([lobby, ...floors.map((f) => f.group)], true)[0];
  if (!hit) return null;
  if (within(hit.object, lobby)) return 'lobby';
  return floors.find((f) => within(hit.object, f.group)) || null;
}
renderer.domElement.addEventListener('pointerdown', (e) => { drag = e.clientX; downX = e.clientX; });
addEventListener('pointerup', () => (drag = null));
renderer.domElement.addEventListener('pointermove', (e) => {
  if (drag != null) { az -= (e.clientX - drag) * 0.006; drag = e.clientX; }
  const p = pick(e); hoverRecep = p === 'lobby'; hover = p && p !== 'lobby' ? p : null;
  renderer.domElement.style.cursor = p ? 'pointer' : 'grab';
});
renderer.domElement.addEventListener('click', (e) => {
  if (Math.abs(e.clientX - downX) > 4) return;
  const p = pick(e);
  if (p === 'lobby') openRecep(); else if (p) enter(p.room.id);
});
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoom = Math.min(3, Math.max(0.35, zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
  else targetY = Math.max(3, Math.min(floorBase(floors.length) + 2, targetY - e.deltaY * 0.03));
  fit();
}, { passive: false });

let entering = false;
function enter(id) {
  const f = floors.find((x) => x.room.id === id);
  if (!f || entering) return;
  entering = true; closeRecep(); panX = 0; targetY = f.y + FH / 2;
  setTimeout(() => { document.body.style.transition = 'opacity .35s'; document.body.style.opacity = '0'; }, 550);
  setTimeout(() => location.assign('/?p=' + encodeURIComponent(id)), 900);
  setTimeout(() => { document.body.style.opacity = ''; entering = false; }, 3500);
}

// ---------- recepção ----------
function openRecep() {
  recep.style.display = 'block'; recep.dataset.h = ''; targetY = 1.4; zoom = 2.1; panX = 0.38; elevT = 6; fit(); renderRecep();
}
function closeRecep() { recep.style.display = 'none'; }
recep.addEventListener('click', (e) => {
  if (e.target.closest('.x')) { closeRecep(); panX = 0; elevT = 30; fitAll(); return; }
  const b = e.target.closest('[data-go]'); if (b) enter(b.dataset.go);
});
function teamDots(r) { return (r.team || []).map((m) => `<i title="${esc(m.id)}" style="background:${m.status ? hexs(m.id === 'boss' ? 0xf2b544 : ST_COLOR[m.status] || 0x9a8e83) : '#3a332d'}"></i>`).join(''); }
function renderRecep() {
  if (recep.style.display === 'none') return;
  const bl = ROOMS.filter((r) => r.blocked);
  const html = `<div class="hd"><div class="av">R</div><div><b>Recepção</b><small>${bl.length ? `Atenção: ${bl.map((r) => esc(r.brand)).join(', ')} precisa de você.` : 'Olá! Para qual andar você vai?'}</small></div><button class="x">fechar</button></div>` +
    [...ROOMS].map((r, i) => ({ r, i })).reverse().map(({ r, i }) => `
    <div class="fl ${r.blocked ? 'blocked' : ''}">
      <div class="t"><span class="dot" style="background:${hexs(roomColor(r))}"></span><span class="n">${esc(r.title)}</span><span class="num">${i + 1}º andar</span><button data-go="${esc(r.id)}">Subir ↑</button></div>
      ${r.about ? `<p>${esc(r.about)}</p>` : ''}
      <div class="meta"><span><b>${r.agents}</b>/${r.expected || r.agents} agentes no ar</span>${r.working ? `<span><b>${r.working}</b> trabalhando</span>` : ''}${r.blocked ? `<span style="color:var(--blocked)"><b>${r.blocked}</b> precisa de você</span>` : ''}${(r.servicesConf || []).length ? `<span>servidores: <b>${(r.services || []).filter(Boolean).length}/${r.servicesConf.length}</b></span>` : ''}<span>hoje <b>${fmtUsd(r.today)}</b></span></div>
      <div class="team">${teamDots(r)}</div>
    </div>`).join('');
  if (html !== recep.dataset.h) { recep.dataset.h = html; recep.innerHTML = html; }
}
let tipIdx = 0, tipUntil = 0;
function receptionistTip(now) {
  if (now < tipUntil || !ROOMS.length) return;
  const bl = ROOMS.filter((r) => r.blocked);
  let msg;
  if (bl.length && tipIdx % 2 === 0) msg = `<small>atenção</small>${esc(bl[0].brand)}: ${bl[0].blocked} agente(s) esperando você.`;
  else { const r = ROOMS[tipIdx % ROOMS.length]; msg = `<small>${ROOMS.indexOf(r) + 1}º andar · ${esc(r.brand)}</small>${r.live ? `${r.agents} agentes no ar${r.working ? `, ${r.working} trabalhando` : ''}.` : 'Sala vazia — rode o atalho no Herdr para abrir.'}`; }
  recepBubble.innerHTML = msg; recepBubble.style.display = 'block';
  tipIdx++; tipUntil = now + 5000;
}

// ---------- lista lateral (diretório) ----------
const side = document.getElementById('cards');
side.addEventListener('click', (e) => { if (e.target.closest('[data-recep]')) return openRecep(); const c = e.target.closest('[data-room]'); if (c) enter(c.dataset.room); });
side.addEventListener('mouseover', (e) => { const c = e.target.closest('[data-room]'); hover = c ? floors.find((f) => f.room.id === c.dataset.room) : null; });
function renderSide() {
  const html = `<div class="card" data-recep="1" style="border-color:#2ec4b6"><div class="top"><div class="sw" style="background:#2ec4b6"></div><div><div class="nm">Recepção</div><div class="sub">térreo · informações de cada projeto</div></div></div></div>` +
    [...ROOMS].map((r, i) => ({ r, i })).reverse().map(({ r, i }) => `
    <div class="card ${r.blocked ? 'blocked' : ''}" data-room="${esc(r.id)}">
      <div class="top"><div class="sw" style="background:${hexs(roomColor(r))}"></div>
        <div><div class="nm">${esc(r.brand)}</div><div class="sub">${i + 1}º andar · ${esc(r.title)}</div></div>
        <span class="pill ${r.blocked ? 'st-blocked' : r.working ? 'st-working' : r.live ? 'st-done' : 'st-idle'}">${r.blocked ? r.blocked + ' precisa de você' : r.working ? r.working + ' trabalhando' : r.live ? 'no ar' : 'vazia'}</span></div>
      <div class="stats" style="margin-top:8px"><div>Agentes<b>${r.agents}/${r.expected || r.agents}</b></div><div>Hoje<b>${fmtUsd(r.today)}</b></div><div>Servidores<b>${(r.servicesConf || []).length ? (r.services || []).filter(Boolean).length + '/' + r.servicesConf.length : '—'}</b></div></div>
    </div>`).join('');
  if (html !== side.dataset.h) { side.dataset.h = html; side.innerHTML = html; }
}
function renderHeader() {
  const tot = ROOMS.reduce((s, r) => s + r.agents, 0), cost = ROOMS.reduce((s, r) => s + (r.today || 0), 0), bl = ROOMS.filter((r) => r.blocked).length;
  document.getElementById('kCost').textContent = fmtUsd(cost);
  document.getElementById('kActive').textContent = tot;
  document.getElementById('hcDot').className = 'dot ' + (bl ? 'bad' : 'ok');
  document.getElementById('hcTxt').textContent = bl ? `${bl} sala(s) precisam de você` : `${ROOMS.length} salas`;
  const sel = document.getElementById('rooms');
  const html = `<button data-recep="1">Recepção</button><select id="roomSel"><option value="">Ir para o andar…</option>${[...ROOMS].map((r, i) => ({ r, i })).reverse().map(({ r, i }) => `<option value="${esc(r.id)}">${i + 1}º · ${esc(r.brand)}${r.blocked ? ' (!)' : ''}</option>`).join('')}</select>`;
  if (html === sel.dataset.h) return; sel.dataset.h = html; sel.innerHTML = html;
  sel.querySelector('[data-recep]').onclick = openRecep;
  document.getElementById('roomSel').onchange = (e) => e.target.value && enter(e.target.value);
}

async function renderAccts() {
  const el = document.getElementById('accts'); if (!el) return;
  try {
    const A = await fetch('/accounts', { cache: 'no-store' }).then((r) => r.json());
    const hhmm = (t) => (t ? new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '?');
    const bar = (v) => `<i class="mb"><i style="width:${Math.min(100, v || 0)}%;background:${v >= 90 ? 'var(--blocked)' : v >= 70 ? '#f2c14e' : 'var(--done)'}"></i></i>`;
    el.innerHTML = A.map((a) => `<span class="acct" title="${esc(a.email || a.id)}&#10;5h ${a.h5 ?? '?'}% — renova ~${hhmm(a.reset5)}&#10;7d ${a.d7 ?? '?'}%&#10;agentes: ${a.users.map((u) => u.project + '/' + u.agent).join(', ') || '—'}"><b>${esc(a.email ? a.email.split('@')[0] : a.id)}</b> 5h ${bar(a.h5)} ${a.h5 ?? '–'}%<small>↻${hhmm(a.reset5)}</small> · 7d ${a.d7 ?? '–'}%</span>`).join('');
  } catch {}
}
setInterval(renderAccts, 5000); renderAccts();
let ROOMS = [], sig = '';
async function refresh() {
  try {
    ROOMS = await fetch('/rooms', { cache: 'no-store' }).then((r) => r.json());
    const s = JSON.stringify(ROOMS.map((r) => [r.id, r.brand, (r.team || []).map((m) => m.id + ':' + m.status).join(), r.live]));
    if (s !== sig) { sig = s; build(ROOMS); }
    renderSide(); renderHeader(); renderRecep();
  } catch { document.getElementById('hcDot').className = 'dot bad'; document.getElementById('hcTxt').textContent = 'servidor fora do ar'; }
}

// ---------- loop ----------
const clock = new THREE.Clock(), pv = new THREE.Vector3();
const toScreen = (x, y, z) => { pv.set(x, y, z).project(camera); return [((pv.x + 1) / 2) * host.clientWidth, ((1 - pv.y) / 2) * host.clientHeight]; };
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime, now = performance.now();
  camY += (targetY - camY) * 0.08; elev += (elevT - elev) * 0.08;
  if (entering) { zoom += (2.6 - zoom) * 0.05; fit(); }
  placeCamera();
  for (const l of lamps) l.material.emissiveIntensity = 1 + Math.sin(t * 2 + l.position.x) * 0.08;
  if (roof?.userData.beacon) roof.userData.beacon.material.emissiveIntensity = Math.sin(t * 3) > 0.6 ? 1.6 : 0.15;
  receptionist.position.y = Math.abs(Math.sin(t * 1.5)) * 0.05; receptionist.rotation.y = Math.sin(t * 0.5) * 0.3;
  for (const f of floors) {
    const isH = hover === f, r = f.room;
    f.glassMat.emissiveIntensity = isH ? 0.5 : r.blocked ? 0.15 + Math.abs(Math.sin(t * 3)) * 0.25 : 0;
    f.glassMat.opacity = isH ? 0.32 : 0.16;
    f.band.visible = !!r.blocked;
    if (f.band.visible) f.band.userData.mat.emissiveIntensity = 0.5 + Math.abs(Math.sin(t * 4)) * 0.9;
    for (const m of f.minis) {
      const st = m.userData.status;
      m.position.y = m.userData.base + (st === 'working' ? Math.abs(Math.sin(t * 9 + m.position.x)) * 0.08 : st === 'blocked' ? Math.abs(Math.sin(t * 6)) * 0.45 : 0);
      if (st === 'working') m.userData.mat.emissiveIntensity = 0.3 + Math.sin(t * 6 + m.position.x) * 0.2;
    }
    const [lx, ly] = toScreen(FW / 2 + 1.2, f.y + FH / 2, FD / 2);
    f.label.style.left = lx + 'px'; f.label.style.top = ly + 'px'; f.label.style.transform = 'translate(0,-50%)';
    f.label.className = 'label floor' + (r.blocked ? ' blocked' : '') + (isH ? ' hov' : '');
    f.label.innerHTML = `${esc(r.brand)} · ${r.blocked ? r.blocked + ' precisa de você' : r.working ? r.working + ' trabalhando' : r.live ? r.agents + ' no ar' : 'vazia'}`;
  }
  const [rx, ry] = toScreen(0, 3.2, -2.6);
  lobbyLabel.style.left = rx + 'px'; lobbyLabel.style.top = ry + 'px';
  lobbyLabel.innerHTML = `<span class="dot" style="background:#2ec4b6"></span>Recepção${hoverRecep ? ' · clique para falar' : ''}`;
  receptionistTip(now);
  const [bx, by] = toScreen(0, 4.4, -2.6);
  recepBubble.style.left = bx + 'px'; recepBubble.style.top = by - 30 + 'px';
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
fit(); placeCamera();
await refresh();
setInterval(refresh, 2000);
tick();
