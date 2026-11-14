/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports -- CommonJS puro, carregado no main do Electron com `-r` */
// Guarda do microfone dos testes E2E: NENHUM teste automático abre o microfone real.
//
// Instalada por `e2e/launch.ts` (o único lugar que inicia o Electron nos testes) com
// `electron -r e2e/micGuard.cjs …` (o `--require` do default_app): roda no processo main ANTES do
// main do app ou do mock, então vale antes de qualquer janela existir. Camadas (cada uma já basta):
//   1. switches do Chromium, também passados na linha de comando pelo launch.ts:
//      `--use-fake-device-for-media-stream` (captura e lista de dispositivos só enxergam
//      "Fake Audio Input…"; o microfone de verdade nem é consultado) e, no modo `deny` (padrão),
//      `--use-fake-ui-for-media-stream=deny` (todo getUserMedia é recusado antes de chegar ao app);
//   2. permissão `media` negada em toda sessão (pedido e consulta) — inclusive se o app trocar o
//      handler depois: o handler novo é embrulhado e a regra da mídia continua por cima.
// Modo `fake` (só para quem precisa de uma captura funcionando): a UI falsa aceita e a permissão é
// concedida — o que chega é o tom do dispositivo falso, nunca o hardware.
//
// `install` é autocontida (sem nada de fora da função): o launch.ts a serializa para o app
// empacotado (`executablePath`, sem default_app) e o micGuard.test.ts a roda com um Electron falso.
'use strict'

/**
 * @param {typeof import('electron')} electron
 * @param {string | undefined} requested 'fake' ou qualquer outra coisa (= 'deny')
 */
function install(electron, requested) {
  const { app } = electron
  const mode = requested === 'fake' ? 'fake' : 'deny'
  const prev = globalThis.__clearchatMicGuard
  if (prev) return prev
  if (!app.isReady()) {
    app.commandLine.appendSwitch('use-fake-device-for-media-stream')
    if (mode === 'deny') app.commandLine.appendSwitch('use-fake-ui-for-media-stream', 'deny')
    else app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  }
  const MEDIA = new Set(['media', 'audioCapture', 'videoCapture'])
  const allow = mode === 'fake'
  const guarded = new WeakSet()
  const state = {
    mode,
    sessions: 0,
    /** Pedidos de mídia que chegaram ao handler (com a UI falsa, o Chromium decide antes). */
    requests: [],
    isGuarded: (ses) => guarded.has(ses)
  }
  globalThis.__clearchatMicGuard = state

  const guard = (ses) => {
    if (!ses || guarded.has(ses)) return
    guarded.add(ses)
    state.sessions++
    const setRequest = ses.setPermissionRequestHandler.bind(ses)
    const setCheck = ses.setPermissionCheckHandler.bind(ses)
    const wrapRequest = (inner) => (wc, permission, cb, details) => {
      if (MEDIA.has(permission)) {
        state.requests.push({ permission, mediaTypes: details?.mediaTypes ?? [], granted: allow })
        cb(allow)
      } else if (inner) inner(wc, permission, cb, details)
      else cb(true) // o padrão do Electron sem handler: concede
    }
    const wrapCheck = (inner) => (wc, permission, origin, details) => {
      if (MEDIA.has(permission)) return allow
      return inner ? inner(wc, permission, origin, details) : true
    }
    setRequest(wrapRequest(null))
    setCheck(wrapCheck(null))
    ses.setPermissionRequestHandler = (h) => setRequest(wrapRequest(h ?? null))
    ses.setPermissionCheckHandler = (h) => setCheck(wrapCheck(h ?? null))
  }

  app.on('session-created', guard)
  // Registrado antes do main do app: este 'ready' roda antes do `whenReady().then(...)` dele (as
  // promessas resolvem depois do emit); o defaultSession já existe aqui.
  if (app.isReady()) guard(electron.session.defaultSession)
  else app.once('ready', () => guard(electron.session.defaultSession))
  return state
}

module.exports = { install }

if (process.type === 'browser') install(require('electron'), process.env.CLEARCHAT_E2E_MIC)
