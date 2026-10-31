# Plano de testes no macOS — ClearChat 0.10.2

Roteiro para um agente (Claude Code) rodando **num Mac**, a partir do repositório
`ezenere/ClearChatDesktop` na tag `v0.10.2` (ou `main`). O app foi desenvolvido e testado no Linux; aqui
ficam só as partes que dependem do sistema operacional e que **nunca rodaram no macOS**.

Leia antes: `CLAUDE.md`, `SPEC.md` (seções Áudio, Modo avançado (GPU local), Menu de contexto,
Configurações) e o `README`/scripts do `package.json`.

## Regras (obrigatórias)

- **Dados reais do usuário**: não toque em `~/Library/Application Support/ClearChat` (nem no antigo
  `…/CleartChat`). Toda execução do app em teste usa uma pasta isolada:
  `CLEARCHAT_USER_DATA=$PWD/.mac-test/userdata-<nome>`. Apague essas pastas no fim.
- **Microfone**: testes automáticos **nunca** abrem o microfone real — injete `getUserMedia` como
  faz `e2e/voice-dictation.spec.ts` (as flags de fake device do Chromium foram ignoradas no
  Linux; confira se no macOS também). Testes com o microfone de verdade são **manuais**: peça ao
  usuário para falar e confirmar.
- **Custo**: nenhuma chamada paga (OpenRouter, ElevenLabs, Anthropic…) sem o usuário autorizar.
  Os specs com provedor falso não custam nada. `e2e/ui.spec.ts` e `e2e/backend.spec.ts` usam API
  paga — **não rode**.
- **Downloads grandes** (modelos locais, runtime da GPU de ~7,5 GB): só com autorização.
- **Não faça commit/push.** Se corrigir algo, deixe as mudanças no working tree e descreva no
  relatório (o orquestrador revisa e commita).
- Antes de rodar o Electron num terminal que exporte `ELECTRON_RUN_AS_NODE`, faça
  `unset ELECTRON_RUN_AS_NODE`.

## Ambiente — registre no relatório

- Modelo do Mac, chip (**Apple Silicon** M1/M2/M3/M4 ou **Intel**), versão do macOS, RAM.
- `node -v`, `npm -v`, `python3 --version`, `xcode-select -p`.
- Homebrew instalado? `which espeak-ng` / `brew list espeak-ng`.

## 1. Build, testes e pacote

1. `npm ci`
2. `npm run typecheck`
3. `npm run test:unit` — esperado: todos passam (no Linux: 1081 passam, 5 pulados). Anote
   qualquer falha específica do macOS (caminhos, `/Users`, case-insensitive FS, `sh`/`zsh`).
4. `npx electron-vite build`
5. `npm run dist:mac` — gera `dist/ClearChat-0.10.2-arm64.dmg` e `-x64.dmg` (não assinado,
   `notarize: false`).
6. Instale o DMG da sua arquitetura, abra pelo **Finder** (Gatekeeper: botão direito → Abrir) e
   confirme que o app inicia sem erro. Repita abrindo pelo terminal
   (`/Applications/ClearChat.app/Contents/MacOS/ClearChat`) para ver o log no stdout.
7. Confira que os módulos nativos foram desempacotados e carregam (são usados pelo app):
   `better-sqlite3`, `@napi-rs/whisper-darwin-<arch>`, `onnxruntime-node/bin/napi-v6/darwin/<arch>`
   em `ClearChat.app/Contents/Resources/app.asar.unpacked/node_modules/…`.
   - **Intel (x64)**: o `onnxruntime-node` 1.30 **não tem binário darwin/x64** e o
     `@napi-rs/whisper` pode não ter o binário x64 no pacote (o npm instala só a arquitetura do
     Mac que compilou). Esperado: o app abre normalmente e Configurações → Áudio → Modelos locais
     mostra **"não disponível"** com o motivo — nunca crash.
8. Tamanho dos `.dmg` e do `.app` (o pacote não pode conter Python, torch nem pesos de modelos).

## 2. Testes automáticos de UI no macOS (sem custo)

Rode cada um com uma pasta isolada (`CLEARCHAT_E2E_DIR=$PWD/.mac-test/e2e/<nome>`) e anote
`passos ok` / falhas (os specs salvam screenshots na pasta):

- Telas simuladas (mock): `chat-overlay`, `chat-bars-ui`, `branches-ui`, `file-viewer-ui`,
  `memory-ui`, `model-compat-ui`, `voice-ui`, `audio-settings-ux`, `gpu-mode-ui`,
  `settings-sidebar` (`node e2e/<nome>.spec.ts`).
- App compilado com provedor falso: `smart-approve`, `approvals`, `approval-queue`, `ask-user`,
  `auto-title`, `branching`, `memory`, `skills`, `web-search`, `network-retry`, `sync`,
  `voice-dictation`, `context-menu` (rode `npx electron-vite build` antes).

Diferenças esperadas de plataforma (anote, não é falha automática): atalhos com ⌘, fontes, a
barra de título.

## 3. Janela e barra de título

- `titleBarStyle: 'hidden'`: os botões vermelho/amarelo/verde não podem cobrir nada. A sidebar
  no Mac esconde logo e nome (fica só a nuvem à direita) — confira.
- Arrastar a janela pelas áreas de arrasto; duplo clique na barra maximiza/minimiza conforme a
  preferência do sistema.
- Tela cheia (⌃⌘F), janela mínima 900×600, modo escuro/claro do sistema.

## 4. Atalhos de teclado (provável bug)

- Ao passar o mouse em "Novo chat" e "Configurações" na sidebar aparecem `Ctrl` `N` / `Ctrl` `,`
  — **no Mac deveria ser ⌘** (há `<Kbd>Ctrl</Kbd>` fixo em 3 lugares do renderer). Confirme se o
  atalho em si funciona com ⌘ ou só com Ctrl, e se os textos estão errados.
- ⌘C/⌘V/⌘X/⌘A/⌘Z/⇧⌘Z nos campos de texto; Enter envia, Shift+Enter quebra linha.

## 5. Menu de contexto (botão direito / Ctrl+clique / dois dedos)

- Campo de texto: Desfazer/Refazer, Recortar/Copiar/Colar/Colar sem formatação/Selecionar tudo,
  com os atalhos do Mac (⇧⌘Z, ⇧⌥⌘V).
- **Corretor ortográfico**: no macOS o Electron usa o corretor do sistema (o idioma é detectado
  pelo macOS; `setSpellCheckerLanguages` não tem efeito). Digite uma palavra errada em
  português: aparecem sugestões? "Adicionar ao dicionário" grava no dicionário do sistema?
- Texto selecionado numa mensagem: Copiar, "Pesquisar na web: “…”" (abre o navegador padrão).
- Link: Abrir no navegador / Copiar link. Imagem: Copiar / Salvar como….
- Mensagem: Copiar mensagem, Copiar como Markdown, Editar, Regenerar resposta, Copiar código num
  bloco de código. Arquivo apresentado: Executar…, Abrir no app, **Mostrar na pasta** (deve abrir
  o **Finder** com o arquivo selecionado), Salvar como…, Copiar caminho.
- O botão direito no microfone do composer abre o menu de microfones (não o menu nativo).

## 6. Microfone — permissão do macOS (provável bug crítico)

Contexto: o pacote do Mac **não declara uso do microfone** — o `Info.plist` não tem
`NSMicrophoneUsageDescription` e `build/entitlements.mac.plist` não tem
`com.apple.security.device.audio-input`. Sem isso o macOS (TCC) pode **não pedir permissão** e o
`getUserMedia` falhar, ou o app ser encerrado ao acessar o microfone.

Teste **manual**, com o usuário (pacote instalado, não o dev):
1. Configure uma transcrição em Configurações → Áudio (peça ao usuário para escolher o provedor;
   isso pode custar — confirme antes).
2. Clique no microfone do composer. Esperado: o macOS pergunta "ClearChat quer acessar o
   microfone". Registre o que acontece: pede? nega em silêncio? aparece erro no app ("Permissão do
   microfone negada…")? o app fecha?
3. Ajustes do Sistema → Privacidade e Segurança → Microfone: o ClearChat aparece na lista?
4. Se falhar, a correção provável é: `extendInfo` com `NSMicrophoneUsageDescription` (texto em
   pt-BR) no bloco `mac:` do `electron-builder.yml`, a entitlement
   `com.apple.security.device.audio-input` em `build/entitlements.mac.plist`, e opcionalmente
   `systemPreferences.askForMediaAccess('microphone')` no main antes de capturar. Implemente,
   gere o DMG de novo e repita o teste. (No dev — `npm run dev`/`electron .` — a permissão vai
   para o Terminal/Electron, não para o app; teste no pacote.)

## 7. Áudio — reprodução e voz local (CPU)

- "Testar voz" com a voz local **Kokoro** (Configurações → Áudio → Modelos locais → baixar o
  Kokoro fp32 ~310 MB + uma voz pt-BR — peça autorização): toca? (A CSP já permite `blob:`; no
  Linux o bug de "sem som" era isso.)
- **espeak-ng** (necessário para o Kokoro): instale com `brew install espeak-ng` se o usuário
  aceitar. Depois teste o app **aberto pelo Finder/Dock**: apps de GUI no macOS não herdam o PATH
  do terminal, então `/opt/homebrew/bin` (Apple Silicon) ou `/usr/local/bin` (Intel) podem não ser
  encontrados → Modelos locais mostra "espeak-ng ausente" mesmo instalado. Compare com o app
  aberto pelo terminal. Se falhar pelo Finder, a correção provável é procurar o `espeak-ng`
  também nesses caminhos fixos (ou usar o PATH do shell de login, como `src/main/tools/shellEnv.ts`
  já faz para a tool shell) — e a mensagem de instalação deve dizer `brew install espeak-ng`.
- **whisper.cpp local** (baixe o modelo tiny ~74 MB com autorização): ditado com transcrição local
  (modo local), uso de CPU razoável, parciais aparecendo. Apple Silicon deve ser rápido.
- Reprodução de PCM em streaming (chamada) e WAV (clipes): sem estalos nem cortes. O tocador abre
  um `AudioContext` na taxa da voz (24 kHz) — confira que o CoreAudio aceita (sem erro no console).

## 8. Modo avançado (GPU local) — macOS

Regras do app: **Apple Silicon** → aviso "MPS experimental", deixa instalar; **Intel** → motores
**bloqueados** (sem wheels do PyTorch), com o motivo na tela.
- Abra Configurações → Áudio → **Modelos locais** → seção GPU: o card de hardware mostra o chip
  Apple? os avisos/bloqueios estão corretos para a sua arquitetura?
- (Só com autorização, ~8–10 GB de download) Apple Silicon: instale o runtime e **um** motor
  pequeno (Whisper ou Qwen3-TTS 0.6B). Anote: o Python portátil darwin baixa e extrai? o torch
  instala (wheels padrão, sem CUDA)? o servidor sobe? "Testar" funciona — em MPS ou CPU? latência?
  Ao fechar o app, nenhum processo `python` fica órfão (`ps aux | grep gpu-server`).
- Remova o runtime no fim se o usuário não quiser manter.

## 9. Tool shell, processos e arquivos

- Num chat de teste com provedor falso (ou real, se autorizado): a tool shell usa o shell do
  usuário (`zsh`) com o PATH do login (Homebrew visível?).
- `process_start` / `process_stop`: o processo e os filhos morrem no stop e ao fechar o app.
- Sandbox: o isolamento do shell no Linux usa bubblewrap; no macOS confira o que as Aprovações
  mostram ("sandbox indisponível" ou equivalente) e se nada quebra.
- Visualizador de arquivos: "Abrir no app" (app padrão do macOS), sugestões de "Executar" por
  extensão (`.sh`, `.command`, `.py`), "Mostrar na pasta" no Finder, "Salvar como…" com o diálogo
  nativo.

## 10. Sync, conta e atualização (smoke)

- `e2e/sync.spec.ts` já cobre com servidor falso (seção 2). Manualmente: entrar na conta (se o
  usuário quiser, com a conta dele) e ver chats sincronizarem — o ícone do host no composer e a
  barra lateral nova de Configurações.
- Aviso de nova versão: com a pasta isolada o app não consulta a rede (esperado).

## Relatório

Escreva `.mac-test/MACOS_TEST_RESULTS.md` (a pasta `.mac-test/` está no `.gitignore`) com:
- Ambiente.
- Tabela por seção: item · resultado (ok / falhou / não testado) · evidência (log, screenshot,
  comando) · observação.
- Bugs encontrados com passos para reproduzir, causa provável (arquivo:linha) e correção proposta
  ou aplicada (diff no working tree, sem commit).
- O que precisou de autorização do usuário e o que ficou sem testar.
