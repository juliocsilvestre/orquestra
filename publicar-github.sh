#!/usr/bin/env bash
# Cria o repositório no GitHub e envia o código. Precisa do GitHub CLI logado (gh auth login).
#   bash publicar-github.sh [nome-do-repo] [--public|--private]
set -euo pipefail
cd "$(dirname "$0")"
NOME="${1:-orquestra}"; VIS="${2:---public}"
command -v gh >/dev/null || { echo "Instale o GitHub CLI:  brew install gh   (Linux: https://cli.github.com)"; exit 1; }
gh auth status >/dev/null 2>&1 || gh auth login
DONO="$(gh api user -q .login)"
perl -pi -e "s#<seu-usuario>#$DONO#g; s#SEU-USUARIO#$DONO#g" README.md package.json
[ -d .git ] || git init -q -b main
mkdir -p .github/workflows && cp ci/release.yml .github/workflows/release.yml   # build dos instaladores a cada tag v*
git add -A
git commit -q -m "Orquestra 0.1.0 — escritório 3D para orquestrar agentes de IA

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CdRYHFZHo2FUgWBhS7mMRL" || echo "(nada novo para commitar)"
if git remote get-url origin >/dev/null 2>&1; then git push -u origin main
else gh repo create "$NOME" $VIS --source . --remote origin --push --description "Escritório 3D para orquestrar agentes de IA (Claude Code + Herdr): Boss, devs, QA e PRs, com sessões, custos e serviços."; fi
gh repo edit "$DONO/$NOME" --homepage "https://github.com/$DONO/$NOME" --add-topic claude-code --add-topic ai-agents --add-topic electron --add-topic threejs --add-topic herdr >/dev/null || true
echo
echo "✓ https://github.com/$DONO/$NOME"
echo "Para gerar os instaladores (macOS .dmg, Linux .AppImage/.deb) pelo GitHub Actions:"
echo "  git tag v0.1.0 && git push origin v0.1.0"
