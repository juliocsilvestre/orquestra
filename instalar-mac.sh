#!/usr/bin/env bash
# Gera o Orquestra.app neste Mac e instala em /Applications (sem assinatura da Apple — uso próprio).
# Rode no Terminal, na pasta do repositório:  bash instalar-mac.sh
set -euo pipefail
cd "$(dirname "$0")"
command -v npm >/dev/null || { echo "Precisa do Node.js:  brew install node"; exit 1; }
echo "› instalando dependências (Electron — a 1ª vez demora um pouco)…"
npm install --no-audit --no-fund
echo "› gerando o app…"
npx electron-builder --mac dir
APP="$(ls -d dist/mac*/Orquestra.app | head -1)"
codesign --force --deep --sign - "$APP" 2>/dev/null || true   # assinatura local (ad-hoc), exigida nos Macs M1/M2/M3
echo "› instalando em /Applications…"
rm -rf /Applications/Orquestra.app
ditto "$APP" /Applications/Orquestra.app
xattr -dr com.apple.quarantine /Applications/Orquestra.app 2>/dev/null || true
echo "✓ pronto — abrindo o Orquestra"
open /Applications/Orquestra.app
