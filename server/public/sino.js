// Sino de notificações: o que os agentes de TODOS os andares esperam de você — ver e responder dali mesmo.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const qs = (o) => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
const AQUI = new URLSearchParams(location.search).get('p') || '';
let token = '', dados = { itens: [], andares: [] }, filtro = localStorage.getItem('orq.sino.filtro') || '', aberto = null, vistos = new Set();
try { vistos = new Set(JSON.parse(localStorage.getItem('orq.sino.vistos') || '[]')); } catch {}
const chave = (it) => `${it.projeto}:${it.agente}:${it.tipo}:${it.ts}`;
const quando = (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? 'agora' : s < 3600 ? `há ${Math.floor(s / 60)} min` : s < 86400 ? `há ${Math.floor(s / 3600)} h` : new Date(ts).toLocaleDateString('pt-BR'); };
const TIPO = { aprovacao: { t: 'precisa de você', c: 'var(--blocked)', i: '!' }, pergunta: { t: 'quer falar com você', c: '#f2b544', i: '?' }, terminou: { t: 'terminou', c: 'var(--done)', i: '✓' } };
const api = async (url, body) => { if (!token) try { token = (await fetch('/token', { cache: 'no-store' }).then((r) => r.json())).token; } catch {}
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token }, body: JSON.stringify(body) });
  const tx = await r.text(); let j = {}; try { j = JSON.parse(tx); } catch { j = { out: tx }; } return { ok: r.ok, status: r.status, bloqueado: r.headers.get('X-Orq') === 'bloqueado', ...j }; };
const md = (t) => esc(t).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');

// ---- botão no cabeçalho + painel ----
const css = document.createElement('style');
css.textContent = `
#sinoBt { position: relative; background: transparent; border: 1px solid var(--line); color: var(--text); border-radius: 10px; width: 36px; height: 32px; cursor: pointer; display: grid; place-items: center; flex: none; }
#sinoBt:hover { background: var(--panel2); } #sinoBt svg { width: 17px; height: 17px; }
#sinoBt .n { position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--blocked); color: #fff; font-size: 11px; font-weight: 800; display: grid; place-items: center; box-shadow: 0 0 0 2px var(--panel); }
#sinoBt .n.am { background: #f2b544; color: #1a120d; } #sinoBt.tem svg { animation: sinoT 2.4s ease-in-out infinite; transform-origin: 50% 10%; }
@keyframes sinoT { 0%, 80%, 100% { transform: rotate(0); } 84% { transform: rotate(14deg); } 88% { transform: rotate(-12deg); } 92% { transform: rotate(8deg); } 96% { transform: rotate(-4deg); } }
#sinoP { position: fixed; top: 54px; right: 14px; width: min(440px, calc(100vw - 28px)); max-height: calc(100vh - 72px); z-index: 70; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,.6); display: flex; flex-direction: column; overflow: hidden; }
#sinoP .sh { display: flex; align-items: center; gap: 8px; padding: 12px 14px 10px; border-bottom: 1px solid var(--line); } #sinoP .sh b { flex: 1; font-size: 14px; }
#sinoP .sh select { background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; font: inherit; font-size: 12px; }
#sinoP .sl { overflow: auto; padding: 6px; } #sinoP .vz { padding: 34px 16px; text-align: center; color: var(--muted); font-size: 13px; }
#sinoP .it { border: 1px solid transparent; border-radius: 10px; padding: 10px; display: grid; grid-template-columns: 28px 1fr; gap: 10px; cursor: pointer; } #sinoP .it:hover { background: var(--panel2); } #sinoP .it.ab { background: var(--panel2); border-color: var(--line); cursor: default; }
#sinoP .ic { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 900; font-size: 13px; color: #1a120d; }
#sinoP .tt { font-size: 13px; line-height: 1.35; } #sinoP .tt small { display: block; color: var(--muted); font-size: 11.5px; margin-top: 2px; } #sinoP .tt .tr { color: #cfc6bd; font-size: 12.5px; margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
#sinoP .it.novo .tt > b::after { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin-left: 6px; vertical-align: middle; }
#sinoP .rp { grid-column: 1 / -1; margin-top: 4px; } #sinoP .rp .txt { background: #0f0c0b; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 12.5px; line-height: 1.5; max-height: 220px; overflow: auto; color: #ddd4cb; }
#sinoP .rp .ops { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; } #sinoP .rp .ops button { text-align: left; background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 7px 10px; cursor: pointer; font: inherit; font-size: 12.5px; }
#sinoP .rp .ops button:hover { border-color: var(--accent); } #sinoP .rp .ops button small { display: block; color: var(--muted); font-size: 11.5px; } #sinoP .rp .ops button.ok { border-color: var(--done); color: var(--done); } #sinoP .rp .ops button.no { border-color: var(--blocked); color: var(--blocked); }
#sinoP .rp textarea { width: 100%; box-sizing: border-box; background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 7px 9px; font: inherit; font-size: 12.5px; resize: vertical; min-height: 54px; }
#sinoP .rp .ac { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; flex-wrap: wrap; } #sinoP .rp .ac button { background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 5px 10px; cursor: pointer; font: inherit; font-size: 12px; }
#sinoP .rp .ac button.pri { background: var(--accent); border-color: var(--accent); color: #1a120d; font-weight: 700; } #sinoP .rp .st { font-size: 12px; color: var(--muted); margin-top: 6px; }`;
document.head.appendChild(css);

const bt = document.createElement('button'); bt.id = 'sinoBt'; bt.title = 'Notificações de todos os andares';
bt.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
const hdr = document.querySelector('header'), ref = document.getElementById('accts');
if (hdr) { hdr.insertBefore(bt, ref || null); hdr.style.overflow = 'visible'; }
const painel = document.createElement('div'); painel.id = 'sinoP'; painel.style.display = 'none'; document.body.appendChild(painel);
bt.addEventListener('click', (e) => { e.stopPropagation(); const v = painel.style.display === 'none'; painel.style.display = v ? 'flex' : 'none'; if (v) { desenha(); marcaVistos(); } });
document.addEventListener('click', (e) => { if (!e.target.isConnected) return; if (painel.style.display !== 'none' && !painel.contains(e.target) && e.target !== bt && !e.target.closest('.mbg')) painel.style.display = 'none'; });

function marcaVistos() { for (const it of dados.itens) vistos.add(chave(it)); try { localStorage.setItem('orq.sino.vistos', JSON.stringify([...vistos].slice(-400))); } catch {} contador(); }
function contador() {
  const pend = dados.itens.filter((x) => x.tipo !== 'terminou'), urg = pend.some((x) => x.tipo === 'aprovacao');
  const n = pend.length || dados.itens.filter((x) => !vistos.has(chave(x))).length;
  bt.classList.toggle('tem', pend.length > 0);
  bt.querySelector('.n')?.remove(); if (n) bt.insertAdjacentHTML('beforeend', `<span class="n ${urg || !pend.length ? '' : 'am'}">${n > 9 ? '9+' : n}</span>`);
}
function desenha() {
  if (painel.style.display === 'none') return;
  if (painel.querySelector('textarea:focus')) return; // não atrapalha quem está digitando
  const lista = dados.itens.filter((x) => !filtro || x.projeto === filtro);
  painel.innerHTML = `<div class="sh"><b>Notificações</b><select title="Filtrar por andar"><option value="">Todos os andares</option>${dados.andares.map((a) => `<option value="${esc(a.id)}" ${a.id === filtro ? 'selected' : ''}>${a.andar}º · ${esc(a.nome)}</option>`).join('')}</select></div>
    <div class="sl">${lista.length ? lista.map((it) => { const k = chave(it), T = TIPO[it.tipo];
      return `<div class="it ${aberto === k ? 'ab' : ''} ${vistos.has(k) ? '' : 'novo'}" data-k="${esc(k)}"><div class="ic" style="background:${T.c}">${T.i}</div>
        <div class="tt"><b>${esc(it.nome)}</b> ${T.t}<small>${it.andar}º andar · ${esc(it.andarNome)} · ${quando(it.ts)}</small>${it.trecho && aberto !== k ? `<div class="tr">${esc(it.trecho)}</div>` : ''}</div>
        ${aberto === k ? '<div class="rp"><div class="st">carregando…</div></div>' : ''}</div>`; }).join('') : `<div class="vz">${filtro ? 'Nada pendente neste andar.' : 'Nenhum agente precisa de você agora. 🎉'}</div>`}</div>`;
  painel.querySelector('select').onchange = (e) => { filtro = e.target.value; try { localStorage.setItem('orq.sino.filtro', filtro); } catch {} aberto = null; desenha(); };
  if (aberto) { const it = dados.itens.find((x) => chave(x) === aberto); const box = painel.querySelector('.it.ab .rp'); if (it && box) abreResposta(it, box); }
}
painel.addEventListener('click', (e) => { const el = e.target.closest('.it'); if (!el || el.classList.contains('ab') || e.target.closest('.rp')) return; aberto = el.dataset.k; desenha(); });

async function abreResposta(it, box) {
  const ir = `<button data-a="ir">ir ao andar</button>`;
  if (it.tipo === 'terminou') {
    box.innerHTML = `<div class="ac">${ir}${it.projeto === AQUI ? '<button data-a="conversa">abrir conversa</button>' : ''}<button class="pri" data-a="ok">✓ ok, visto</button></div>`;
  } else if (it.tipo === 'aprovacao') {
    let q = null; try { q = await fetch('/pergunta?' + qs({ p: it.projeto, agent: it.agente }), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)); } catch {}
    const ops = (q?.opcoes || []).filter((o) => !/type something/i.test(o.texto));
    box.innerHTML = `${q?.pergunta || q?.titulo ? `<div class="txt"><b>${esc(q.titulo || '')}</b>${q.titulo && q.pergunta ? '<br>' : ''}${esc(q.pergunta || '')}</div>` : `<div class="txt">${esc((q?.contexto || 'Não consegui ler a tela dele.').slice(-900))}</div>`}
      ${ops.length ? `<div class="ops">${ops.map((o) => `<button data-op="${o.n}">${o.n}. ${esc(o.texto)}${o.desc ? `<small>${esc(o.desc)}</small>` : ''}</button>`).join('')}</div>` : ''}
      <textarea placeholder="ou escreva a resposta… (⌘+Enter envia)"></textarea><div class="ac">${ir}<button data-a="esc" title="Esc na tela dele">cancelar a pergunta</button><button class="pri" data-a="txt">Enviar</button></div>`;
  } else {
    let ult = ''; try { const c = await fetch('/chat?' + qs({ p: it.projeto, agent: it.agente }), { cache: 'no-store' }).then((r) => r.json()); ult = [...c].reverse().find((x) => x.kind === 'text' && x.role === 'agent')?.text || ''; } catch {}
    const bts = [...(it.opcoes || []).map((o) => ({ t: `${o.n}. ${o.texto}`, m: `Opção ${o.n}: ${o.texto}` })), ...(it.autoriza ? [{ t: '✓ Autorizo, pode seguir', m: 'Autorizo — pode seguir.', c: 'ok' }, { t: '✕ Não autorizo', m: 'Não autorizo. Não faça isso; me explique as alternativas.', c: 'no' }] : [])];
    box.innerHTML = `<div class="txt">${md((ult || it.trecho || '').slice(-2500))}</div>
      ${bts.length ? `<div class="ops">${bts.map((b, i) => `<button class="${b.c || ''}" data-qm="${i}">${esc(b.t)}</button>`).join('')}</div>` : ''}
      <textarea placeholder="Responder para ${esc(it.nome)}… (⌘+Enter envia)"></textarea><div class="ac">${ir}<button data-a="visto">dispensar</button><button class="pri" data-a="send">Enviar</button></div>`;
    box._bts = bts;
  }
  const status = (t) => { let s = box.querySelector('.st'); if (!s) { s = document.createElement('div'); s.className = 'st'; box.appendChild(s); } s.textContent = t; };
  const pronto = (t) => { status(t); setTimeout(() => { aberto = null; carrega(); }, 900); };
  const manda = async (texto) => { status('enviando…'); const r = await api('/send', { project: it.projeto, agent: it.agente, text: texto }); if (r.bloqueado) { status('ele abriu uma tela de aprovação — recarregando…'); return setTimeout(carrega, 600); } r.ok ? pronto('enviado ✓') : status(r.out || 'não enviou'); };
  box.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const ta = box.querySelector('textarea'), txt = ta?.value.trim() || '';
    if (b.dataset.a === 'ir') return location.assign('/?p=' + encodeURIComponent(it.projeto));
    if (b.dataset.a === 'conversa') { painel.style.display = 'none'; return window.orqAbrirConversa?.(it.agente); }
    if (b.dataset.a === 'ok') { await api('/agent', { project: it.projeto, agent: it.agente, action: 'ok' }); return pronto('ok ✓'); }
    if (b.dataset.a === 'visto') { await api('/agent', { project: it.projeto, agent: it.agente, action: 'visto' }); return pronto('dispensado'); }
    if (b.dataset.op) { status('respondendo…'); const r = await api('/responder', { project: it.projeto, agent: it.agente, opcao: +b.dataset.op }); return r.ok ? pronto(r.out || 'respondido ✓') : status(r.out || 'falhou'); }
    if (b.dataset.a === 'esc') { const r = await api('/responder', { project: it.projeto, agent: it.agente, esc: true }); return r.ok ? pronto('pergunta cancelada') : status(r.out || 'falhou'); }
    if (b.dataset.a === 'txt') { if (!txt) return ta.focus(); status('respondendo…'); const r = await api('/responder', { project: it.projeto, agent: it.agente, texto: txt }); return r.ok ? pronto('respondido ✓') : status(r.out || 'falhou'); }
    if (b.dataset.qm) return manda(box._bts[+b.dataset.qm].m);
    if (b.dataset.a === 'send') { if (!txt) return ta.focus(); return manda(txt); }
  };
  box.querySelector('textarea')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); box.querySelector('.ac .pri')?.click(); } });
}

let assinatura = '';
async function carrega() {
  try { dados = await fetch('/pendencias', { cache: 'no-store' }).then((r) => r.json()); } catch { return; }
  const sig = JSON.stringify(dados.itens.map(chave)); contador();
  if (sig !== assinatura) { assinatura = sig; if (aberto && !dados.itens.some((x) => chave(x) === aberto)) aberto = null; desenha(); }
}
carrega(); setInterval(carrega, 4000);
window.orqSino = { abrir: () => bt.click(), recarregar: carrega };
