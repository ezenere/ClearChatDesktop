import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNEL,
  IPC,
  VOICE_CALL_STATE_CHANNEL,
  VOICE_CALL_TIMELINE_CHANNEL,
  VOICE_CALL_UTTERANCE_CANCEL_CHANNEL,
  VOICE_CALL_UTTERANCE_CHANNEL,
  VOICE_CALL_UTTERANCE_CHUNK_CHANNEL,
  VOICE_GPU_PROGRESS_CHANNEL,
  VOICE_MODELS_PROGRESS_CHANNEL,
  VOICE_PARTIAL_CHANNEL,
  VOICE_TTS_CLIPS_PROGRESS_CHANNEL,
  type FullClearApi,
  type TtsClipProgressEvent,
  type VoiceCallTimelineEvent,
  type VoiceCallUtteranceCancelEvent,
  type VoiceCallUtteranceChunkEvent,
  type VoiceCallUtteranceEvent,
  type VoiceModelProgressEvent,
  type VoicePartialEvent
} from '@shared/ipc'
import type { VoiceCallState } from '@shared/voice'
import type { GpuStatus } from '@shared/gpuVoice'
import type { AgentEvent } from '@shared/types'
import {
  CTX_ACTION_CHANNEL,
  CTX_QUERY_CHANNEL,
  CTX_REPLY_CHANNEL,
  type AppCtx,
  type CtxAppAction
} from '@shared/contextMenu'

const invoke = ipcRenderer.invoke.bind(ipcRenderer)

const api: FullClearApi = {
  providers: {
    list: () => invoke(IPC.providers.list),
    create: (p) => invoke(IPC.providers.create, p),
    update: (id, patch) => invoke(IPC.providers.update, id, patch),
    delete: (id) => invoke(IPC.providers.delete, id),
    listModels: (providerId) => invoke(IPC.providers.listModels, providerId),
    test: (p) => invoke(IPC.providers.test, p)
  },
  settings: {
    get: (key) => invoke(IPC.settings.get, key),
    set: (key, value) => invoke(IPC.settings.set, key, value)
  },
  chats: {
    list: () => invoke(IPC.chats.list),
    get: (id) => invoke(IPC.chats.get, id),
    create: (input) => invoke(IPC.chats.create, input),
    update: (id, patch) => invoke(IPC.chats.update, id, patch),
    delete: (id) => invoke(IPC.chats.delete, id),
    generateTitle: (id) => invoke(IPC.chats.generateTitle, id)
  },
  sessions: {
    list: (chatId) => invoke(IPC.sessions.list, chatId),
    messages: (sessionId) => invoke(IPC.sessions.messages, sessionId)
  },
  messages: {
    update: (id, message) => invoke(IPC.messages.update, id, message),
    delete: (id) => invoke(IPC.messages.delete, id)
  },
  agent: {
    send: (sessionId, text, attachments, skills, opts) =>
      invoke(IPC.agent.send, sessionId, text, attachments, skills, opts),
    forceSend: (queuedId) => invoke(IPC.agent.forceSend, queuedId),
    removeQueued: (queuedId) => invoke(IPC.agent.removeQueued, queuedId),
    getQueue: (sessionId) => invoke(IPC.agent.getQueue, sessionId),
    stop: (sessionId) => invoke(IPC.agent.stop, sessionId),
    regenerate: (sessionId, messageId) => invoke(IPC.agent.regenerate, sessionId, messageId),
    editBranch: (messageId, message) => invoke(IPC.agent.editBranch, messageId, message),
    selectBranch: (messageId) => invoke(IPC.agent.selectBranch, messageId),
    approve: (requestId, decision, items) => invoke(IPC.agent.approve, requestId, decision, items),
    pendingApprovals: () => invoke(IPC.agent.pendingApprovals),
    previewRequest: (sessionId) => invoke(IPC.agent.previewRequest, sessionId),
    runningSessions: () => invoke(IPC.agent.runningSessions),
    compact: (sessionId, opts) => invoke(IPC.agent.compact, sessionId, opts),
    stopSubagents: (chatId) => invoke(IPC.agent.stopSubagents, chatId),
    smartOverride: (messageId) => invoke(IPC.agent.smartOverride, messageId),
    smartApproveTest: (input) => invoke(IPC.agent.smartApproveTest, input),
    setCapturedContext: (chatId, sessionId, text) =>
      invoke(IPC.agent.setCapturedContext, chatId, sessionId, text),
    undoCapturedContext: (chatId, sessionId) =>
      invoke(IPC.agent.undoCapturedContext, chatId, sessionId)
  },
  fs: {
    listDir: (path) => invoke(IPC.fs.listDir, path),
    readFile: (path) => invoke(IPC.fs.readFile, path),
    pickDirectory: () => invoke(IPC.fs.pickDirectory),
    homeDir: () => invoke(IPC.fs.homeDir),
    mkdir: (path) => invoke(IPC.fs.mkdir, path)
  },
  viewer: {
    open: (target) => invoke(IPC.viewer.open, target),
    check: (chatId, messageId) => invoke(IPC.viewer.check, chatId, messageId),
    readText: (token) => invoke(IPC.viewer.readText, token),
    openExternal: (token) => invoke(IPC.viewer.openExternal, token),
    showInFolder: (token) => invoke(IPC.viewer.showInFolder, token),
    saveBytes: (name, bytes) => invoke(IPC.viewer.saveBytes, name, bytes),
    openBytes: (name, bytes) => invoke(IPC.viewer.openBytes, name, bytes),
    run: (token) => invoke(IPC.viewer.run, token),
    runBytes: (chatId, name, bytes) => invoke(IPC.viewer.runBytes, chatId, name, bytes)
  },
  app: {
    capabilities: () => invoke(IPC.app.capabilities)
  },
  updates: {
    status: () => invoke(IPC.updates.status),
    check: () => invoke(IPC.updates.check),
    openRelease: () => invoke(IPC.updates.openRelease)
  },
  memory: {
    listCollections: () => invoke(IPC.memory.listCollections),
    createCollection: (input) => invoke(IPC.memory.createCollection, input),
    updateCollection: (id, patch) => invoke(IPC.memory.updateCollection, id, patch),
    deleteCollection: (id) => invoke(IPC.memory.deleteCollection, id),
    list: (query) => invoke(IPC.memory.list, query),
    create: (input) => invoke(IPC.memory.create, input),
    update: (id, patch) => invoke(IPC.memory.update, id, patch),
    delete: (id) => invoke(IPC.memory.delete, id),
    preview: (sessionId) => invoke(IPC.memory.preview, sessionId),
    refreshSnapshot: (sessionId) => invoke(IPC.memory.refreshSnapshot, sessionId),
    extractNow: (sessionId) => invoke(IPC.memory.extractNow, sessionId)
  },
  skills: {
    getSettings: () => invoke(IPC.skills.getSettings),
    updateSettings: (patch) => invoke(IPC.skills.updateSettings, patch),
    discover: (opts) => invoke(IPC.skills.discover, opts),
    read: (file) => invoke(IPC.skills.read, file),
    pickFolder: () => invoke(IPC.skills.pickFolder),
    openFolder: (path) => invoke(IPC.skills.openFolder, path)
  },
  presets: {
    list: () => invoke(IPC.presets.list),
    create: (input) => invoke(IPC.presets.create, input),
    update: (id, patch) => invoke(IPC.presets.update, id, patch),
    delete: (id) => invoke(IPC.presets.delete, id),
    duplicate: (id) => invoke(IPC.presets.duplicate, id)
  },
  attachments: {
    pick: () => invoke(IPC.attachments.pick),
    add: (input) => invoke(IPC.attachments.add, input)
  },
  questions: {
    answer: (id, answers) => invoke(IPC.questions.answer, id, answers),
    cancel: (id) => invoke(IPC.questions.cancel, id),
    pending: () => invoke(IPC.questions.pending)
  },
  retries: {
    retry: (id) => invoke(IPC.retries.retry, id),
    cancel: (id) => invoke(IPC.retries.cancel, id),
    pending: () => invoke(IPC.retries.pending)
  },
  processes: {
    list: (chatId) => invoke(IPC.processes.list, chatId),
    stop: (chatId, id) => invoke(IPC.processes.stop, chatId, id),
    logs: (chatId, id, tail) => invoke(IPC.processes.logs, chatId, id, tail)
  },
  approvals: {
    getSettings: () => invoke(IPC.approvals.getSettings),
    updateSettings: (patch) => invoke(IPC.approvals.updateSettings, patch)
  },
  webSearch: {
    getSettings: () => invoke(IPC.webSearch.getSettings),
    updateEngines: (engines) => invoke(IPC.webSearch.updateEngines, engines),
    setKey: (engine, key) => invoke(IPC.webSearch.setKey, engine, key),
    revealKey: (engine) => invoke(IPC.webSearch.revealKey, engine),
    test: (engine) => invoke(IPC.webSearch.test, engine)
  },
  voice: {
    settings: {
      get: () => invoke(IPC.voice.settingsGet),
      set: (kind, value) => invoke(IPC.voice.settingsSet, kind, value)
    },
    transcribe: {
      start: (language, opts) => invoke(IPC.voice.transcribeStart, language, opts),
      push: (sessionId, pcm16, sampleRate) =>
        invoke(IPC.voice.transcribePush, sessionId, pcm16, sampleRate),
      stop: (sessionId, opts) => invoke(IPC.voice.transcribeStop, sessionId, opts),
      cancel: (sessionId) => invoke(IPC.voice.transcribeCancel, sessionId),
      speculate: (sessionId) => invoke(IPC.voice.transcribeSpeculate, sessionId)
    },
    models: {
      list: () => invoke(IPC.voice.modelsList),
      download: (input) => invoke(IPC.voice.modelsDownload, input),
      cancel: (input) => invoke(IPC.voice.modelsCancel, input),
      remove: (input) => invoke(IPC.voice.modelsRemove, input)
    },
    tts: {
      synth: (input) => invoke(IPC.voice.ttsSynth, input),
      test: (input) => invoke(IPC.voice.ttsTest, input),
      clips: {
        generate: (input) => invoke(IPC.voice.ttsClipsGenerate, input),
        list: (input) => invoke(IPC.voice.ttsClipsList, input)
      },
      voices: () => invoke(IPC.voice.ttsVoices)
    },
    call: {
      start: (input) => invoke(IPC.voice.callStart, input),
      stop: () => invoke(IPC.voice.callStop),
      mute: (input) => invoke(IPC.voice.callMute, input),
      speechBegin: (input) => invoke(IPC.voice.callSpeechBegin, input),
      speechEnd: () => invoke(IPC.voice.callSpeechEnd),
      turn: (input) => invoke(IPC.voice.callTurn, input),
      playbackIdle: () => invoke(IPC.voice.callPlaybackIdle),
      bargeIn: (input) => invoke(IPC.voice.callBargeIn, input),
      backchannel: (input) => invoke(IPC.voice.callBackchannel, input),
      getState: () => invoke(IPC.voice.callGetState)
    },
    catalog: {
      list: (input) => invoke(IPC.voice.catalogList, input),
      preview: (input) => invoke(IPC.voice.catalogPreview, input)
    },
    resolve: (input) => invoke(IPC.voice.resolve, input),
    runtime: {
      status: () => invoke(IPC.voice.runtimeStatus)
    },
    // "Modo avançado (GPU local)": URL/token do servidor nunca passam por aqui
    gpu: {
      status: () => invoke(IPC.voice.gpuStatus),
      installRuntime: () => invoke(IPC.voice.gpuInstallRuntime),
      removeRuntime: () => invoke(IPC.voice.gpuRemoveRuntime),
      installEngine: (id) => invoke(IPC.voice.gpuInstallEngine, id),
      removeEngine: (id) => invoke(IPC.voice.gpuRemoveEngine, id),
      cancel: () => invoke(IPC.voice.gpuCancel),
      selfTest: (id) => invoke(IPC.voice.gpuSelfTest, id),
      startServer: (ids) => invoke(IPC.voice.gpuStartServer, ids),
      stopServer: () => invoke(IPC.voice.gpuStopServer),
      addUserVoice: (input) => invoke(IPC.voice.gpuAddUserVoice, input),
      removeUserVoice: (id) => invoke(IPC.voice.gpuRemoveUserVoice, id),
      downloadCc0Voice: (input) => invoke(IPC.voice.gpuDownloadCc0Voice, input),
      transcribe: (input) => invoke(IPC.voice.gpuTranscribe, input),
      log: () => invoke(IPC.voice.gpuLog)
    }
  },
  sync: {
    status: () => invoke(IPC.sync.status),
    probeServer: (url) => invoke(IPC.sync.probeServer, url),
    setServer: (kind, url) => invoke(IPC.sync.setServer, kind, url),
    requestCode: (email) => invoke(IPC.sync.requestCode, email),
    verifyCode: (email, code) => invoke(IPC.sync.verifyCode, email, code),
    refreshKeys: () => invoke(IPC.sync.refreshKeys),
    unlock: (password, remember) => invoke(IPC.sync.unlock, password, remember),
    unlockWithRecovery: (key, pw, remember) =>
      invoke(IPC.sync.unlockWithRecovery, key, pw, remember),
    resolveMerge: (priority) => invoke(IPC.sync.resolveMerge, priority),
    lock: () => invoke(IPC.sync.lock),
    logout: () => invoke(IPC.sync.logout),
    changePassword: (pw) => invoke(IPC.sync.changePassword, pw),
    newRecoveryKey: () => invoke(IPC.sync.newRecoveryKey),
    devices: () => invoke(IPC.sync.devices),
    renameDevice: (id, name) => invoke(IPC.sync.renameDevice, id, name),
    revokeDevice: (id) => invoke(IPC.sync.revokeDevice, id),
    syncNow: () => invoke(IPC.sync.syncNow),
    setPushNotify: (on) => invoke(IPC.sync.setPushNotify, on),
    openSignup: () => invoke(IPC.sync.openSignup),
    openSetup: () => invoke(IPC.sync.openSetup),
    chatStates: () => invoke(IPC.sync.chatStates),
    takeover: (chatId, opts) => invoke(IPC.sync.takeover, chatId, opts),
    cancelHandover: (chatId) => invoke(IPC.sync.cancelHandover, chatId),
    setPinned: (chatId, pinned) => invoke(IPC.sync.setPinned, chatId, pinned),
    confirmCwd: (chatId, cwd) => invoke(IPC.sync.confirmCwd, chatId, cwd),
    divergence: (chatId) => invoke(IPC.sync.divergence, chatId),
    resolveDivergence: (chatId, keep) => invoke(IPC.sync.resolveDivergence, chatId, keep),
    setActiveChat: (chatId) => invoke(IPC.sync.setActiveChat, chatId),
    answerPrompt: (chatId, keep) => invoke(IPC.sync.answerPrompt, chatId, keep),
    cloudSkills: () => invoke(IPC.sync.cloudSkills),
    trackedSkills: () => invoke(IPC.sync.trackedSkills),
    setSkillSync: (name, on) => invoke(IPC.sync.setSkillSync, name, on),
    downloadSkills: (names) => invoke(IPC.sync.downloadSkills, names),
    removeCloudSkill: (name) => invoke(IPC.sync.removeCloudSkill, name),
    stopTrackingSkill: (name) => invoke(IPC.sync.stopTrackingSkill, name),
    hostSkills: (chatId) => invoke(IPC.sync.hostSkills, chatId),
    remoteListDir: (chatId, path) => invoke(IPC.sync.remoteListDir, chatId, path),
    remoteReadFile: (chatId, path, offset, length) =>
      invoke(IPC.sync.remoteReadFile, chatId, path, offset, length),
    liveChats: () => invoke(IPC.sync.liveChats),
    liveOpen: (chatId) => invoke(IPC.sync.liveOpen, chatId),
    liveAttach: (chatId, name, mime, data) => invoke(IPC.sync.liveAttach, chatId, name, mime, data),
    liveStats: (chatId) => invoke(IPC.sync.liveStats, chatId),
    saveOnline: (chatId) => invoke(IPC.sync.saveOnline, chatId),
    takeOffServer: (chatId) => invoke(IPC.sync.takeOffServer, chatId)
  },
  onEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: AgentEvent): void => cb(event)
    ipcRenderer.on(EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, listener)
    }
  },
  onVoicePartial: (cb) => {
    const listener = (_e: IpcRendererEvent, event: VoicePartialEvent): void => cb(event)
    ipcRenderer.on(VOICE_PARTIAL_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(VOICE_PARTIAL_CHANNEL, listener)
    }
  },
  onVoiceModelProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, event: VoiceModelProgressEvent): void => cb(event)
    ipcRenderer.on(VOICE_MODELS_PROGRESS_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(VOICE_MODELS_PROGRESS_CHANNEL, listener)
    }
  },
  onVoiceGpuProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, event: GpuStatus): void => cb(event)
    ipcRenderer.on(VOICE_GPU_PROGRESS_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(VOICE_GPU_PROGRESS_CHANNEL, listener)
    }
  },
  onVoiceTtsClipsProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, event: TtsClipProgressEvent): void => cb(event)
    ipcRenderer.on(VOICE_TTS_CLIPS_PROGRESS_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(VOICE_TTS_CLIPS_PROGRESS_CHANNEL, listener)
    }
  },
  onVoiceCallState: (cb) => {
    const listener = (_e: IpcRendererEvent, event: VoiceCallState): void => cb(event)
    ipcRenderer.on(VOICE_CALL_STATE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(VOICE_CALL_STATE_CHANNEL, listener)
    }
  },
  onVoiceCallUtterance: (cb) => {
    const listener = (_e: IpcRendererEvent, event: VoiceCallUtteranceEvent): void => cb(event)
    ipcRenderer.on(VOICE_CALL_UTTERANCE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(VOICE_CALL_UTTERANCE_CHANNEL, listener)
    }
  },
  onVoiceCallUtteranceCancel: (cb) => {
    const listener = (_e: IpcRendererEvent, event: VoiceCallUtteranceCancelEvent): void => cb(event)
    ipcRenderer.on(VOICE_CALL_UTTERANCE_CANCEL_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(VOICE_CALL_UTTERANCE_CANCEL_CHANNEL, listener)
    }
  },
  onVoiceCallUtteranceChunk: (cb) => {
    const listener = (_e: IpcRendererEvent, event: VoiceCallUtteranceChunkEvent): void => cb(event)
    ipcRenderer.on(VOICE_CALL_UTTERANCE_CHUNK_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(VOICE_CALL_UTTERANCE_CHUNK_CHANNEL, listener)
    }
  },
  contextMenu: {
    onQuery: (cb) => {
      const listener = (_e: IpcRendererEvent, reqId: number): void => {
        let ctx: AppCtx | null
        try {
          ctx = cb()
        } catch {
          ctx = null
        }
        ipcRenderer.send(CTX_REPLY_CHANNEL, reqId, ctx)
      }
      ipcRenderer.on(CTX_QUERY_CHANNEL, listener)
      return () => {
        ipcRenderer.removeListener(CTX_QUERY_CHANNEL, listener)
      }
    },
    onAction: (cb) => {
      const listener = (
        _e: IpcRendererEvent,
        event: { token: number; action: CtxAppAction }
      ): void => cb(event)
      ipcRenderer.on(CTX_ACTION_CHANNEL, listener)
      return () => {
        ipcRenderer.removeListener(CTX_ACTION_CHANNEL, listener)
      }
    }
  },
  onVoiceCallTimeline: (cb) => {
    const listener = (_e: IpcRendererEvent, event: VoiceCallTimelineEvent): void => cb(event)
    ipcRenderer.on(VOICE_CALL_TIMELINE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(VOICE_CALL_TIMELINE_CHANNEL, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
