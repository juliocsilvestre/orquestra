# TODO

## Antes de publicar no GitHub
- [x] Separar o motor (público) da configuração pessoal (privada)
- [x] Criar andar novo a partir de modelos (`novo-andar.sh`) — falta a versão com telas dentro do app
- [ ] Modelos de agentes: Boss, dev residente, QA (Playwright), GitLab, GitHub, Taiga, Logs
- [x] Renomear "Estúdio" para "Orquestra" na interface
- [x] Licença MIT · repositório via `publicar-github.sh`
- [ ] Textos em inglês (i18n) além do português
- [x] Capturas de tela, GIF e vídeo (modo demonstração)

## macOS
- [x] App Electron que sobe o servidor e abre a interface
- [ ] Conta Apple Developer → assinatura + notarização (DMG sem aviso de segurança)
- [ ] Homebrew cask (`brew install --cask orquestra`)
- [ ] Atualização automática (electron-updater + releases do GitHub)
- [ ] Abrir ao iniciar o Mac (opcional, nas preferências)
- [ ] ~~App Store~~ — não dá: o sandbox da loja proíbe rodar terminais, `claude`, `hc` e `docker`

## Linux
- [x] AppImage e .deb (electron-builder)
- [ ] Testar em Ubuntu/Fedora com Herdr instalado

## Windows (futuro)
- [ ] Verificar se o Herdr/`hc` roda no Windows; senão, suportar via WSL2
- [ ] Reescrever os scripts bash (`boss.sh`, `equipe.sh`, `servicos.sh`, …) em Node para rodar nativo
- [ ] Trocar `lsof` por `netstat`/`Get-NetTCPConnection` na detecção de portas
- [ ] Instalador NSIS + assinatura de código

## CI
- [ ] GitHub Actions: build de macOS e Linux a cada tag `v*` e anexar à release
