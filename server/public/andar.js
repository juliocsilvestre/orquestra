// Novo andar (projeto) pela interface: pasta + repos, quais agentes, contas e modelos.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slug = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 12).replace(/-+$/, '');

function aviso(titulo, texto) {
  return new Promise((ok) => {
    const bg = document.createElement('div'); bg.className = 'mbg';
    bg.innerHTML = `<div class="mdl" role="dialog" aria-modal="true"><h4>${esc(titulo)}</h4><p>${esc(texto).replace(/\n/g, '<br>')}</p><div class="mact"><button class="mo">Entendi</button></div></div>`;
    bg.addEventListener('click', (e) => { if (e.target === bg || e.target.classList.contains('mo')) { bg.remove(); ok(); } });
    document.body.appendChild(bg);
  });
}

export async function abrirNovoAndar() {
  let token = ''; try { token = (await fetch('/token', { cache: 'no-store' }).then((r) => r.json())).token; } catch {}
  const bg = document.createElement('div'); bg.className = 'mbg';
  const temSeletor = !!window.orqApp?.escolherPasta;
  bg.innerHTML = `<div class="mdl wide frm" role="dialog" aria-modal="true" style="width:min(780px,95vw)">
    <h4>＋ Adicionar andar (projeto)</h4>
    <div class="lin"><div><label>Nome do andar</label><input id="anT" placeholder="ex.: Loja Online"></div>
      <div style="flex:.6"><label>Atalho no terminal (chama o Boss)</label><input id="anA" placeholder="ex.: loja"><small>No terminal do Herdr: digite isso e o Boss sobe com a equipe.</small></div></div>
    <label>Pasta do projeto (a pasta que CONTÉM o(s) repositório(s))</label>
    <div class="lin"><div style="flex:3"><input id="anP" placeholder="ex.: ~/Projetos/loja-online"></div>${temSeletor ? '<div style="flex:none"><button class="sb" id="anEsc" style="height:34px">Escolher…</button></div>' : ''}</div>
    <div id="anRepos" class="note" style="margin-top:6px">Escolha a pasta para ver os repositórios.</div>
    <label>Clonar repositórios para dentro da pasta (opcional, um por linha)</label>
    <textarea id="anC" rows="2" placeholder="git@github.com:empresa/api.git&#10;https://gitlab.com/empresa/web.git"></textarea>
    <label>Sobre o projeto (o Boss recebe isso)</label>
    <textarea id="anS" rows="3" placeholder="O que é o projeto, stack, regras importantes, onde roda…"></textarea>
    <label style="margin-top:14px">Agentes</label>
    <div class="ck"><input type="checkbox" checked disabled><label style="margin:0"><b>Boss</b> — conversa com você, divide e revisa o trabalho (sempre)</label></div>
    <div class="ck"><input type="checkbox" checked disabled><label style="margin:0"><b>Devs residentes</b> — um por repositório marcado acima</label></div>
    <div class="ck"><input type="checkbox" id="anQa" checked><label for="anQa" style="margin:0"><b>QA</b> — valida as entregas no navegador (Playwright)</label></div>
    <div class="ck"><input type="checkbox" id="anGitOn" checked><label for="anGitOn" style="margin:0"><b>Git</b> — abre o MR/PR depois do seu OK e acompanha a pipeline</label><select id="anGit" style="width:auto;margin-left:8px"><option value="auto">detectar</option><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></div>
    <div class="ck"><input type="checkbox" id="anRev" checked><label for="anRev" style="margin:0"><b>Revisor</b> — avisa o que outras pessoas sobem (develop/main e PRs) e se dá para puxar</label></div>
    <div id="anEsp"></div>
    <button class="sb" id="anMais" style="margin-top:8px">＋ Especialista (segurança, docs, banco, performance…)</button>
    <div class="lin" style="margin-top:6px"><div><label>Conta do Boss</label><select id="anCB"><option value="1">conta 1</option><option value="2">conta 2</option></select></div>
      <div><label>Conta da equipe</label><select id="anCE"><option value="2">conta 2</option><option value="1">conta 1</option></select></div>
      <div><label>Modelo dos devs</label><select id="anMD"><option>sonnet</option><option>haiku</option><option>opus</option></select></div>
      <div><label>Modelo dos especialistas</label><select id="anME"><option>sonnet</option><option>haiku</option><option>opus</option></select></div></div>
    <div class="lin"><div><label>Branch base</label><input id="anB" placeholder="automático (develop se existir, senão main)"></div></div>
    <small>Skills: cada agente começa com as skills padrão da conta dele. Depois é só abrir o agente → <b>Skills</b> para criar ou ajustar (só dele ou da equipe toda); e → <b>Instruções</b> para mudar o que ele faz.</small>
    <div class="ck"><input type="checkbox" id="anI" checked><label for="anI" style="margin:0">Chamar o Boss agora (sobe a equipe e os serviços)</label></div>
    <div class="mact"><button class="mc">Cancelar</button><button class="mo">Criar andar</button></div></div>`;
  const $ = (q) => bg.querySelector(q);
  let info = null, mexeuAtalho = false;
  $('#anT').oninput = () => { if (!mexeuAtalho) $('#anA').value = slug($('#anT').value); };
  $('#anA').oninput = () => { mexeuAtalho = true; };
  const verPasta = async () => {
    const c = $('#anP').value.trim(); if (!c) return;
    $('#anRepos').innerHTML = 'lendo a pasta…';
    try { info = await fetch('/andar/pasta?caminho=' + encodeURIComponent(c), { cache: 'no-store' }).then((r) => r.json()); } catch (e) { $('#anRepos').textContent = 'erro: ' + e.message; return; }
    if (!$('#anT').value.trim()) { const n = c.replace(/\/+$/, '').split('/').pop(); $('#anT').value = n; if (!mexeuAtalho) $('#anA').value = slug(n); }
    const av = [];
    if (!info.existe) av.push('a pasta ainda não existe — ela será criada (use "Clonar repositórios" para trazer os repos).');
    if (info.ehRepo) av.push('<b style="color:var(--blocked)">essa pasta já é um repositório.</b> Escolha a pasta acima dela (ou crie uma pasta e coloque o repo dentro).');
    if (info.jaTemAndar) av.push('<b style="color:var(--blocked)">essa pasta já tem um andar.</b>');
    const plats = [...new Set(info.repos.map((r) => r.plat).filter(Boolean))];
    $('#anRepos').innerHTML = (av.length ? av.map((x) => `<div>⚠ ${x}</div>`).join('') : '') + (info.repos.length ? `<div style="margin-top:4px">Repositórios encontrados — marque os que terão <b>dev residente</b>:</div>` + info.repos.map((r) => `<div class="ck" style="margin-top:4px"><input type="checkbox" class="anDev" value="${esc(r.nome)}" checked><label style="margin:0"><b>${esc(r.nome)}</b> <span class="note" style="margin:0">${esc(r.remoto || 'sem remoto')}${r.develop ? ' · tem develop' : ''}</span></label></div>`).join('') : (info.existe ? '<div>Nenhum repositório git dentro dessa pasta.</div>' : ''))
      + (plats.length ? `<div class="note" style="margin-top:4px">Git detectado: ${plats.map((p) => p === 'github' ? 'GitHub' : 'GitLab').join(' e ')}</div>` : '');
  };
  $('#anP').onchange = verPasta;
  $('#anEsc')?.addEventListener('click', async () => { const p = await window.orqApp.escolherPasta(); if (p) { $('#anP').value = p; verPasta(); } });
  $('#anGitOn').onchange = () => { $('#anGit').disabled = !$('#anGitOn').checked; };
  $('#anMais').onclick = () => {
    const d = document.createElement('div'); d.className = 'esp'; d.style.cssText = 'border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin-top:8px';
    d.innerHTML = `<div class="lin"><div><label style="margin-top:0">Nome curto</label><input class="eN" placeholder="ex.: seguranca"></div><div><label style="margin-top:0">Título</label><input class="eT" placeholder="ex.: Segurança"></div><div style="flex:none;align-self:end"><button class="sb eX">remover</button></div></div>
      <label>O que ele faz, como e quando</label><textarea class="eI" rows="3" placeholder="ex.: Revise o diff de cada entrega procurando segredos, injeção de SQL, XSS e dados pessoais em log. Responda por gravidade."></textarea>`;
    d.querySelector('.eX').onclick = () => d.remove();
    d.querySelector('.eN').oninput = (e) => { const t = d.querySelector('.eT'); if (!t.dataset.m) t.value = e.target.value.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()); };
    d.querySelector('.eT').oninput = (e) => { e.target.dataset.m = 1; };
    $('#anEsp').appendChild(d); d.querySelector('.eN').focus();
  };
  const fim = () => { bg.classList.add('out'); setTimeout(() => bg.remove(), 150); };
  bg.addEventListener('click', async (e) => {
    if (e.target === bg || e.target.classList.contains('mc')) return fim();
    if (!e.target.classList.contains('mo')) return;
    const atalho = $('#anA').value.trim().toLowerCase();
    const corpo = {
      titulo: $('#anT').value.trim(), atalho, id: atalho.slice(0, 12).replace(/[^a-z0-9-]/g, '-').replace(/-+$/, ''), pasta: $('#anP').value.trim(),
      clonar: $('#anC').value.split('\n').map((x) => x.trim()).filter(Boolean), sobre: $('#anS').value,
      devs: info ? [...bg.querySelectorAll('.anDev')].filter((x) => x.checked).map((x) => x.value) : undefined,
      qa: $('#anQa').checked, git: $('#anGitOn').checked ? ($('#anGit').value === 'auto' ? '' : $('#anGit').value) : 'nenhum', revisor: $('#anRev').checked,
      especialistas: [...bg.querySelectorAll('.esp')].map((d) => ({ nome: d.querySelector('.eN').value.trim().toLowerCase(), titulo: d.querySelector('.eT').value.trim(), instrucoes: d.querySelector('.eI').value })).filter((x) => x.nome),
      contaBoss: $('#anCB').value, contaEquipe: $('#anCE').value, modeloDevs: $('#anMD').value, modeloEspecialistas: $('#anME').value, base: $('#anB').value.trim(), iniciar: $('#anI').checked,
    };
    if (info && info.repos.length && corpo.devs.length === 0 && !corpo.clonar.length) return aviso('Nenhum dev', 'Marque pelo menos um repositório para ter dev residente.');
    e.target.disabled = true; e.target.textContent = corpo.clonar.length ? 'clonando e criando…' : 'criando…';
    const r = await fetch('/andar', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token }, body: JSON.stringify(corpo) }).then((x) => x.json()).catch((er) => ({ ok: false, out: er.message }));
    e.target.disabled = false; e.target.textContent = 'Criar andar';
    if (!r.ok) return aviso('Não criei o andar', r.out || 'falhou');
    fim(); await aviso('Andar criado', r.out); location.assign('/?p=' + encodeURIComponent(r.id));
  });
  document.body.appendChild(bg); setTimeout(() => $('#anT').focus(), 30);
}
