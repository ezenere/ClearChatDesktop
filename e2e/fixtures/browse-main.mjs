// Main mínimo do Electron para e2e/browsePage.test.ts: registra os hooks de TS dos testes e expõe o
// `loadPage` real (src/main/tools/browsePage.ts) em `globalThis.__browse` — o teste chama pelo
// `app.evaluate` do Playwright. Sem janela visível, sem o resto do app.
import { createRequire } from 'node:module'
import '../ts-hooks.mjs'

const require = createRequire(import.meta.url)
const { app } = require('electron')

app.on('window-all-closed', () => {}) // as janelas ocultas do browse fecham; o app fica
// sem top-level await: o Electron só emite o `ready` depois que o main termina de avaliar
void app
  .whenReady()
  .then(() => import('../../src/main/tools/browsePage.ts'))
  .then((mod) => {
    globalThis.__browse = { loadPage: mod.loadPage }
  })
  .catch((e) => {
    console.error('browse-main:', e)
    globalThis.__browse = { error: String(e) }
  })
