const { contextBridge, ipcRenderer } = require('electron');
// o app oferece um seletor de pasta nativo (usado em "Adicionar andar")
contextBridge.exposeInMainWorld('orqApp', { escolherPasta: () => ipcRenderer.invoke('orq:pasta') });
// Ajustes de janela de app: no Mac a barra de título fica embutida — o cabeçalho do Estúdio vira a área de arrastar.
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('orq-app', 'orq-' + process.platform);
  if (process.platform !== 'darwin') return;
  const st = document.createElement('style');
  st.textContent = `
    .orq-darwin header { padding-left: 84px !important; -webkit-app-region: drag; }
    .orq-darwin header button, .orq-darwin header select, .orq-darwin header a, .orq-darwin header input, .orq-darwin header [data-tab], .orq-darwin header .tabs, .orq-darwin header #accts, .orq-darwin header #srv { -webkit-app-region: no-drag; }`;
  document.head.appendChild(st);
});
