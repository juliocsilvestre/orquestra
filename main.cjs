// Orquestra — app de desktop do Orquestra (escritório 3D dos agentes do Herdr/Claude Code).
// Abre o servidor do Orquestra (se ainda não estiver no ar) e mostra a interface numa janela própria.
const { app, BrowserWindow, Menu, shell, dialog, nativeTheme, ipcMain } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

app.setName('Orquestra');
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const HOME = os.homedir();
const PREFS = path.join(app.getPath('userData'), 'preferencias.json');
const prefs = (() => { try { return JSON.parse(fs.readFileSync(PREFS, 'utf8')); } catch { return {}; } })();
const savePrefs = () => { try { fs.mkdirSync(path.dirname(PREFS), { recursive: true }); fs.writeFileSync(PREFS, JSON.stringify(prefs, null, 2)); } catch {} };

// Apps abertos pelo Finder não herdam o PATH do terminal (hc, claude, docker, lsof, node…): pega o do shell de login.
function loadShellPath() {
  if (process.platform === 'win32') return;
  try {
    const sh = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const out = execFileSync(sh, ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { encoding: 'utf8', timeout: 8000 });
    const m = out.match(/__P__(.*)__P__/); if (m && m[1]) process.env.PATH = m[1];
  } catch {}
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local/bin')];
  process.env.PATH = [...new Set([...(process.env.PATH || '').split(':'), ...extra])].filter(Boolean).join(':');
}

// Onde está o servidor: 1) o que você escolheu  2) instalação antiga em ~/Desktop/Developer/.estudio  3) ~/.orquestra (novo-andar.sh)
const BUNDLED = path.join(__dirname, 'server').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
function serverDir() {
  const OH = process.env.ORQUESTRA_HOME || path.join(HOME, '.orquestra');
  const cands = [prefs.serverDir, path.join(HOME, 'Desktop/Developer/.estudio')].filter(Boolean).map((d) => ({ dir: d, config: path.join(d, 'config.json') }));
  cands.push({ dir: path.join(OH, 'server'), config: path.join(OH, 'config.json') }); // instalação padrão (novo-andar.sh)
  for (const c of cands) if (fs.existsSync(path.join(c.dir, 'server.mjs')) && fs.existsSync(c.config)) return c;
  // 1ª vez: cria a configuração em ~/.orquestra e usa o servidor que vem no app — os andares são adicionados pela interface
  const cfg = path.join(OH, 'config.json');
  if (!fs.existsSync(cfg)) {
    try { fs.mkdirSync(path.join(OH, 'data'), { recursive: true }); fs.writeFileSync(cfg, JSON.stringify({ port: 4777, projects: [], accounts: [{ id: 'conta1', dir: '~/.claude' }, ...(fs.existsSync(path.join(HOME, '.claude-conta2')) ? [{ id: 'conta2', dir: '~/.claude-conta2' }] : [])], prices: { opus: { input: 5, output: 25 }, sonnet: { input: 3, output: 15 }, haiku: { input: 1, output: 5 }, default: { input: 3, output: 15 } }, cacheWriteMult: 1.25, cacheReadMult: 0.1 }, null, 2)); } catch { return null; }
  }
  return { dir: BUNDLED, config: cfg };
}
const portOf = (cfgFile) => { try { return Number(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).port) || 4777; } catch { return 4777; } };

function health(port) {
  return new Promise((ok) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { ok(JSON.parse(b)); } catch { ok(null); } });
    });
    r.on('error', () => ok(null)); r.on('timeout', () => { r.destroy(); ok(null); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sobe o servidor solto do app: ele continua no ar quando a janela fecha (os agentes e os hooks dependem dele).
function startServer(srv, port) {
  const node = (() => { try { return execFileSync('/usr/bin/env', ['which', 'node'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
  const env = { ...process.env, PORT: String(port) };
  env.ORQ_CONFIG = srv.config;
  let cmd = node, args = [path.join(srv.dir, 'server.mjs')];
  if (!node) { cmd = process.execPath; env.ELECTRON_RUN_AS_NODE = '1'; } // sem node instalado: usa o node que vem no próprio app
  const logDir = path.join(path.dirname(srv.config), 'data');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'server.log'), 'a');
  const ch = spawn(cmd, args, { cwd: srv.dir, env, detached: true, stdio: ['ignore', log, log] });
  ch.unref();
}

async function ensureServer(srv, { restart = false } = {}) {
  const port = portOf(srv.config);
  let h = await health(port);
  const codeMtime = (() => { try { return Math.floor(fs.statSync(path.join(srv.dir, 'server.mjs')).mtimeMs); } catch { return 0; } })();
  if (h && (restart || (h.code || 0) < codeMtime - 2000)) {
    // código novo ou pedido de reinício: derruba o que está na porta
    try { const pids = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean); for (const p of pids) try { process.kill(Number(p)); } catch {} } catch {}
    await sleep(600); h = null;
  }
  if (!h) { startServer(srv, port); for (let i = 0; i < 40 && !(h = await health(port)); i++) await sleep(250); }
  return h ? port : null;
}

let win = null;
const LOADING = (msg) => 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#14110f;color:#cfc6bd;font:14px -apple-system,system-ui,sans-serif}
  .b{display:flex;flex-direction:column;align-items:center;gap:12px}.s{width:26px;height:26px;border:3px solid #3a322b;border-top-color:#e8875a;border-radius:50%;animation:g .8s linear infinite}
  @keyframes g{to{transform:rotate(360deg)}} b{color:#f3ece6;font-size:16px}</style><div class="b"><div class="s"></div><b>Orquestra</b><span>${msg}</span></div>`);

async function boot({ restart = false } = {}) {
  win.loadURL(LOADING(restart ? 'reiniciando o servidor…' : 'iniciando o servidor…'));
  let srv = serverDir();
  if (!srv) {
    const r = await dialog.showMessageBox(win, { type: 'question', message: 'Onde está o servidor do Orquestra?', detail: 'Não achei o servidor (server.mjs + config.json). Crie um andar com o novo-andar.sh do repositório (instala em ~/.orquestra) ou escolha a pasta do servidor.', buttons: ['Escolher pasta…', 'Sair'] });
    if (r.response !== 0) return app.quit();
    const f = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'showHiddenFiles'], defaultPath: HOME });
    if (f.canceled || !f.filePaths[0]) return app.quit();
    prefs.serverDir = f.filePaths[0]; savePrefs(); srv = serverDir();
    if (!srv) { await dialog.showMessageBox(win, { type: 'error', message: 'Essa pasta não tem server.mjs e config.json.' }); return boot(); }
  }
  const port = await ensureServer(srv, { restart });
  if (!port) {
    win.loadURL(LOADING('não consegui subir o servidor — veja o server.log na pasta do servidor'));
    return;
  }
  win.loadURL(prefs.lastUrl && prefs.lastUrl.startsWith(`http://localhost:${port}/`) ? prefs.lastUrl : `http://localhost:${port}/`);
}

function createWindow() {
  const b = prefs.bounds || { width: 1440, height: 900 };
  win = new BrowserWindow({
    ...b, minWidth: 900, minHeight: 600, title: 'Orquestra', backgroundColor: '#14110f', show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  if (prefs.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  const keep = () => { if (!win.isMaximized() && !win.isMinimized()) prefs.bounds = win.getBounds(); prefs.maximized = win.isMaximized(); savePrefs(); };
  win.on('resize', keep); win.on('move', keep);
  win.webContents.on('did-navigate', (_e, url) => { if (url.startsWith('http://localhost')) { prefs.lastUrl = url; savePrefs(); } });
  win.webContents.on('did-navigate-in-page', (_e, url) => { if (url.startsWith('http://localhost')) { prefs.lastUrl = url; savePrefs(); } });
  // links para fora (GitLab, GitHub, Taiga…) abrem no navegador
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith('http://localhost')) { shell.openExternal(url); return { action: 'deny' }; } return { action: 'allow' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('http://localhost') && !url.startsWith('data:')) { e.preventDefault(); shell.openExternal(url); } });
  win.on('closed', () => { win = null; });
  boot();
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const url = () => win?.webContents.getURL() || '';
  const base = () => { try { const u = new URL(url()); return `${u.protocol}//${u.host}`; } catch { return null; } };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'Orquestra', submenu: [
      { label: 'Prédio', accelerator: 'CmdOrCtrl+0', click: () => base() && win.loadURL(base() + '/') },
      { type: 'separator' },
      { label: 'Recarregar', accelerator: 'CmdOrCtrl+R', click: () => win?.reload() },
      { label: 'Reiniciar o servidor', click: () => win && boot({ restart: true }) },
      { label: 'Abrir no navegador', click: () => url().startsWith('http') && shell.openExternal(url()) },
      { label: 'Pasta de configuração…', click: () => { const s = serverDir(); if (s) shell.openPath(path.dirname(s.config)); } },
      { label: 'Escolher outra pasta do servidor…', click: async () => { const f = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'showHiddenFiles'] }); if (!f.canceled && f.filePaths[0]) { prefs.serverDir = f.filePaths[0]; savePrefs(); boot({ restart: true }); } } },
      ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Sair' }]),
    ] },
    { role: 'editMenu', label: 'Editar' },
    { label: 'Ver', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools', label: 'Ferramentas de desenvolvedor' }] },
    { role: 'windowMenu', label: 'Janela' },
  ]));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
ipcMain.handle('orq:pasta', async () => { const r = await dialog.showOpenDialog(win, { title: 'Pasta do projeto (a que contém os repositórios)', properties: ['openDirectory', 'createDirectory'], defaultPath: HOME }); return r.canceled ? null : r.filePaths[0]; });
app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  loadShellPath(); buildMenu(); createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); }); // o servidor continua no ar
