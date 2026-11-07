#!/usr/bin/env node
// Hook PreToolUse(Bash) do Boss e dos devs: registra quem foi falar com quem.
// Nunca bloqueia nada: sempre sai com 0 e não escreve no stdout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ORQ = path.resolve(DIR, '..');
const OUT = path.join(DIR, 'data', 'events.jsonl');

const NOT_AGENTS = new Set(['estudio', 'bin', 'relatorios']);
function agentFromCwd(cwd) {
  if (!cwd) return null;
  if (cwd.startsWith(ORQ + '/')) {
    const top = cwd.slice(ORQ.length + 1).split('/')[0];
    return top && !NOT_AGENTS.has(top) ? top : null;
  }
  const m = cwd.match(/\/\.worktrees\/([^/]+)/);
  return m ? (m[1].startsWith('dev-') ? m[1] : 'dev-' + m[1]) : null;
}
const clip = (s) => (s || '').replace(/[ \t]+/g, ' ').trim().slice(0, 4000); // a mensagem inteira (o feed resume na tela)

function parse(cmd, from) {
  const ev = [];
  for (const m of cmd.matchAll(/dev\.sh\s+(\S+)\s+(\S+)\s+(?:"([\s\S]*?)"|'([\s\S]*?)')/g))
    ev.push({ kind: 'delegate', to: `dev-${m[1]}-${m[2]}`, text: m[3] ?? m[4] });
  for (const m of cmd.matchAll(/tarefa\.sh\s+(\S+)\s+(\S+)\s+(?:"([\s\S]*?)"|'([\s\S]*?)')/g))
    ev.push({ kind: 'delegate', to: `dev-${m[1]}`, text: `${m[2]}: ${m[3] ?? m[4]}` });
  if (from !== 'boss') for (const m of cmd.matchAll(/avisa-boss\.sh\s+(?:"([\s\S]*?)"|'([\s\S]*?)'|(\S+))/g))
    ev.push({ kind: 'report', to: 'boss', text: m[1] ?? m[2] ?? m[3] });
  for (const m of cmd.matchAll(/hcp\.sh\s+send\s+(\S+)\s+(?:"([\s\S]*?)"|'([\s\S]*?)'|(\S+))/g))
    ev.push({ kind: from === 'boss' ? 'send' : 'report', to: m[1], text: m[2] ?? m[3] ?? m[4] });
  for (const m of cmd.matchAll(/hcp\.sh\s+read\s+([a-z][\w-]*)/g))
    if (from === 'boss' && !/^srv-/.test(m[1])) ev.push({ kind: 'inspect', to: m[1], text: 'olhando a tela' });
  for (const m of cmd.matchAll(/(?<!hcp\.sh\s{0,3})\bhc\s+send\s+(?:--\S+\s+)*(\S+)\s+(?:"([\s\S]*?)"|'([\s\S]*?)'|(\S+))/g))
    ev.push({ kind: from === 'boss' ? 'send' : 'report', to: m[1], text: m[2] ?? m[3] ?? m[4] });
  if (from === 'boss') for (const m of cmd.matchAll(/ok\.sh\s+(\S+)\s*(?:"([\s\S]*?)"|'([\s\S]*?)')?/g))
    ev.push({ kind: 'approve', to: m[1], text: m[2] ?? m[3] ?? 'aprovado' });
  if (/\bhc\s+wait\b/.test(cmd)) ev.push({ kind: 'wait', to: null, text: 'aguardando a equipe' });
  if (from === 'boss') {
    for (const m of cmd.matchAll(/\bhc\s+(?:read|attach)\s+(?:--\S+\s+\S+\s+)*([a-z][\w-]*)/g))
      if (!/^srv-/.test(m[1])) ev.push({ kind: 'inspect', to: m[1], text: 'olhando a tela' });
    const seen = new Set();
    for (const m of cmd.matchAll(/\.worktrees\/([^\s/'"]+)/g)) {
      if (cmd.includes('dev.sh') || seen.has(m[1])) continue;
      seen.add(m[1]);
      ev.push({ kind: 'review', to: m[1].startsWith('dev-') ? m[1] : 'dev-' + m[1], text: /\bdiff\b/.test(cmd) ? 'revisando o diff' : 'conferindo o worktree' });
    }
    for (const m of cmd.matchAll(/relatorios\/(dev-[\w-]+?|taiga|logs)(?:\/|\.md)/g))
      if (!/dev\.sh|tarefa\.sh/.test(cmd)) ev.push({ kind: 'review', to: m[1], text: 'lendo o relatório' });
  }
  return ev;
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(raw);
    const cmd = j.tool_input?.command || '';
    const from = agentFromCwd(j.cwd);
    if (!from || !cmd) return;
    const evs = parse(cmd, from);
    if (!evs.length) return;
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const ts = Date.now();
    fs.appendFileSync(OUT, evs.map((e) => JSON.stringify({ ts, from, ...e, text: clip(e.text) })).join('\n') + '\n');
  } catch {}
});
process.stdin.on('error', () => {});
