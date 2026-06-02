/* eslint-disable @typescript-eslint/no-explicit-any */
import { deserializeFromTransport, serializeForTransport } from '@root/shared/platform/json-serialization'
import { CreatePouFileProps, PouServiceResponse } from '@root/types/IPC/pou-service'
import { CreateProjectFileProps, IProjectServiceResponse } from '@root/types/IPC/project-service'
import { IDataToWrite, ISaveDataResponse } from '@root/types/IPC/save-data'
import { RuntimeLogEntry } from '@root/types/PLC/runtime-logs'

import type { ProjectState } from '../renderer/store/slices/project/types'

type BridgeCallback = (_event: unknown, ...args: any[]) => void

// Same-origin API calls; webpack dev server proxies /api to the backend.
const API_BASE = ''
const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/ws`

const eventListeners = new Map<string, Set<BridgeCallback>>()
let ws: WebSocket | null = null
let wsReconnectTimer: number | null = null

const isDeprecatedBrowserProjectPath = (path: string): boolean => /^browser-(fs|upload|download):\/\//.test(path)

const localhostProjectAccessResponse = {
  success: false,
  error: {
    title: 'Local project access requires localhost',
    description: 'Open this editor from localhost on the machine running the service to access PLC project files.',
    error: null,
  },
}

const isLocalhostAccess = (): boolean => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname)

const invokeLocalProjectAccess = <T>(factory: () => Promise<T>): Promise<T | typeof localhostProjectAccessResponse> => {
  if (!isLocalhostAccess()) return Promise.resolve(localhostProjectAccessResponse)
  return factory()
}

const emit = (channel: string, ...args: unknown[]) => {
  const listeners = eventListeners.get(channel)
  if (!listeners) return
  listeners.forEach((callback) => callback({}, ...args))
}

const on = (channel: string, callback: BridgeCallback) => {
  if (!eventListeners.has(channel)) {
    eventListeners.set(channel, new Set())
  }
  eventListeners.get(channel)?.add(callback)
}

const removeAllListeners = (channel: string) => {
  eventListeners.delete(channel)
}

const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const response = await fetch(`${API_BASE}/api/invoke/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: serializeForTransport(args) }),
  })

  const payload = (await response.json()) as { ok: boolean; result?: unknown; error?: string }
  if (!payload.ok) {
    throw new Error(payload.error || `Invoke failed for ${channel}`)
  }

  return deserializeFromTransport(payload.result) as T
}

const send = (channel: string, ...args: unknown[]) => {
  void fetch(`${API_BASE}/api/send/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: serializeForTransport(args) }),
  })
}

const ensureWebSocket = () => {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return ws
  }

  ws = new WebSocket(WS_URL)

  ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as
        | { type: 'event'; channel: string; args: unknown[] }
        | { type: 'compile-message'; data: unknown }

      if (payload.type === 'event') {
        const eventArgs = deserializeFromTransport(payload.args)
        if (Array.isArray(eventArgs)) {
          emit(payload.channel, ...(eventArgs as unknown[]))
        } else {
          emit(payload.channel, eventArgs)
        }
      }
    } catch (error) {
      console.error('Failed to parse websocket message', error)
    }
  }

  ws.onclose = () => {
    if (wsReconnectTimer) {
      window.clearTimeout(wsReconnectTimer)
    }
    wsReconnectTimer = window.setTimeout(() => {
      ws = null
      ensureWebSocket()
    }, 2000)
  }

  return ws
}

const runCompileStream = (
  type: 'compiler:run-compile-program' | 'compiler:run-debug-compilation',
  compileArgs: unknown[],
  callback: (args: any) => void,
) => {
  const socket = ensureWebSocket()
  let hasReceivedMessage = false
  let hasStarted = false
  let startupTimer: number | null = null

  const stopStartupTimer = () => {
    if (startupTimer) {
      window.clearTimeout(startupTimer)
      startupTimer = null
    }
  }

  const handleMessage = (event: MessageEvent) => {
    try {
      const payload = JSON.parse(String(event.data)) as { type: string; data?: unknown }
      if (payload.type === 'compile-message') {
        hasReceivedMessage = true
        stopStartupTimer()
        callback(deserializeFromTransport(payload.data))
      }
    } catch (error) {
      console.error('Failed to parse compile stream message', error)
    }
  }

  const handleError = () => {
    stopStartupTimer()
    callback({
      logLevel: 'error',
      message: 'Compilation log stream failed. Check that /api/ws is reachable from this browser.',
      closePort: true,
    })
  }

  const handleClose = () => {
    stopStartupTimer()
    if (!hasReceivedMessage) {
      callback({
        logLevel: 'error',
        message: 'Compilation log stream closed before any logs were received.',
        closePort: true,
      })
    }
  }

  const start = () => {
    if (hasStarted) return
    hasStarted = true
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('error', handleError, { once: true })
    socket.addEventListener('close', handleClose, { once: true })
    socket.send(JSON.stringify({ type, args: serializeForTransport(compileArgs) }))
    startupTimer = window.setTimeout(() => {
      if (!hasReceivedMessage) {
        callback({
          logLevel: 'error',
          message:
            'No compilation logs received after 10 seconds. Check the Linux server websocket/proxy configuration.',
          closePort: true,
        })
      }
    }, 10000)
  }

  if (socket.readyState === WebSocket.OPEN) {
    start()
  } else {
    socket.addEventListener('open', start, { once: true })
  }

  return () => {
    stopStartupTimer()
    socket.removeEventListener('message', handleMessage)
    socket.removeEventListener('error', handleError)
    socket.removeEventListener('close', handleClose)
  }
}

const triggerDownload = (filename: string, content: string) => {
  const blob = new Blob([content], { type: 'application/xml' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

const keyboardShortcuts: Array<{ match: (event: KeyboardEvent) => boolean; channel: string; args?: unknown[] }> = [
  {
    match: (event) => (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n',
    channel: 'project:create-accelerator',
  },
  {
    match: (event) => (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o',
    channel: 'project:open-project-request',
  },
  {
    match: (event) => (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.shiftKey,
    channel: 'project:save-accelerator',
  },
  {
    match: (event) => (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 's',
    channel: 'project:save-file-accelerator',
  },
  {
    match: (event) => (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w' && !event.shiftKey,
    channel: 'workspace:close-tab-accelerator',
  },
  {
    match: (event) => (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'w',
    channel: 'workspace:close-project-accelerator',
  },
  {
    match: (event) => (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey,
    channel: 'edit:undo-request',
  },
  {
    match: (event) => (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'z',
    channel: 'edit:redo-request',
  },
  {
    match: (event) => (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f',
    channel: 'project:find-in-project-accelerator',
  },
]

export const initWebBridge = (): void => {
  ensureWebSocket()

  window.addEventListener('keydown', (event) => {
    const shortcut = keyboardShortcuts.find((item) => item.match(event))
    if (!shortcut) return
    event.preventDefault()
    emit(shortcut.channel, ...(shortcut.args ?? []))
  })
}

const webBridge = {
  aboutAccelerator: (callback: BridgeCallback) => on('website:about-accelerator', callback),
  aboutModalAccelerator: (callback: BridgeCallback) => on('about:open-accelerator', callback),
  closeProjectAccelerator: (callback: BridgeCallback) => on('workspace:close-project-accelerator', callback),
  closeTabAccelerator: (callback: BridgeCallback) => on('workspace:close-tab-accelerator', callback),
  createProject: (data: CreateProjectFileProps): Promise<IProjectServiceResponse> =>
    invokeLocalProjectAccess(() => invoke('project:create', data)) as Promise<IProjectServiceResponse>,
  createProjectAccelerator: (callback: BridgeCallback) => on('project:create-accelerator', callback),
  deleteFileAccelerator: (callback: BridgeCallback) => on('workspace:delete-file-accelerator', callback),
  findInProjectAccelerator: (callback: BridgeCallback) => on('project:find-in-project-accelerator', callback),
  handleOpenProjectRequest: (callback: BridgeCallback) => on('project:open-project-request', callback),
  openProject: (): Promise<IProjectServiceResponse> =>
    invokeLocalProjectAccess(() => invoke('project:open')) as Promise<IProjectServiceResponse>,
  openProjectByPath: (projectPath: string): Promise<IProjectServiceResponse> =>
    isDeprecatedBrowserProjectPath(projectPath)
      ? Promise.resolve({
          success: false,
          error: {
            title: 'Project path is no longer supported',
            description: 'Open the project from localhost so the editor can use the real project path.',
            error: null,
          },
        })
      : (invokeLocalProjectAccess(() =>
          invoke('project:open-by-path', projectPath),
        ) as Promise<IProjectServiceResponse>),
  openRecentAccelerator: (callback: BridgeCallback) => on('project:open-recent-accelerator', callback),
  pathPicker: async (): Promise<{
    success: boolean
    error?: { title: string; description: string }
    path?: string
  }> => {
    if (!isLocalhostAccess()) {
      return {
        success: false,
        error: {
          title: localhostProjectAccessResponse.error.title,
          description: localhostProjectAccessResponse.error.description,
        },
      }
    }
    return invoke('project:path-picker')
  },
  removeCloseProjectListener: () => removeAllListeners('workspace:close-project-accelerator'),
  removeCloseTabListener: () => removeAllListeners('workspace:close-tab-accelerator'),
  removeCreateProjectAccelerator: () => removeAllListeners('project:create-accelerator'),
  removeDeleteFileListener: () => removeAllListeners('workspace:delete-file-accelerator'),
  removeOpenProjectAccelerator: () => removeAllListeners('project:open-project-request'),
  removeOpenRecentListener: () => removeAllListeners('project:open-recent-accelerator'),
  removeSaveFileAccelerator: () => removeAllListeners('project:save-file-accelerator'),
  removeSaveProjectAccelerator: () => removeAllListeners('project:save-accelerator'),
  saveFile: (filePath: string, content: unknown): Promise<{ success: boolean; error?: string }> =>
    invoke('project:save-file', filePath, content),
  saveFileAccelerator: (callback: BridgeCallback) => on('project:save-file-accelerator', callback),
  saveProject: (dataToWrite: IDataToWrite): Promise<ISaveDataResponse> => invoke('project:save', dataToWrite),
  saveProjectAccelerator: (callback: BridgeCallback) => on('project:save-accelerator', callback),
  switchPerspective: (callback: BridgeCallback) => on('workspace:switch-perspective-accelerator', callback),

  createPouFile: (props: CreatePouFileProps): Promise<PouServiceResponse> => invoke('pou:create', props),
  deletePouFile: (filePath: string): Promise<PouServiceResponse> => invoke('pou:delete', filePath),
  renamePouFile: (data: {
    filePath: string
    newFileName: string
    fileContent?: unknown
  }): Promise<PouServiceResponse> => invoke('pou:rename', data),

  handleUndoRequest: (callback: BridgeCallback) => on('edit:undo-request', callback),
  removeUndoRequestListener: () => removeAllListeners('edit:undo-request'),
  handleRedoRequest: (callback: BridgeCallback) => on('edit:redo-request', callback),
  removeRedoRequestListener: () => removeAllListeners('edit:redo-request'),

  darwinAppIsClosing: (callback: BridgeCallback) => on('app:darwin-is-closing', callback),
  getRecent: (): Promise<string[]> => invoke('app:store-get'),
  getStoreValue: (key: string) => invoke('app:store-get', key),
  getSystemInfo: (): Promise<{
    OS: 'linux' | 'darwin' | 'win32' | ''
    architecture: 'x64' | 'arm' | ''
    prefersDarkMode: boolean
    isWindowMaximized: boolean
  }> => invoke('system:get-system-info'),
  handleQuitApp: () => send('app:quit'),
  openExternalLinkAccelerator: (link: string): Promise<{ success: boolean }> => {
    window.open(link, '_blank', 'noopener,noreferrer')
    return Promise.resolve({ success: true })
  },
  quitAppRequest: (callback: BridgeCallback) => on('app:quit-accelerator', callback),
  removeQuitAppListener: () => removeAllListeners('app:quit-accelerator'),
  retrieveRecent: (): Promise<{ name: string; path: string; lastOpenedAt: string; createdAt: string }[]> =>
    invoke('app:store-retrieve-recent'),
  setStoreValue: (key: string, val: string) => send('app:store-set', key, val),

  closeWindow: () => undefined,
  handleCloseOrHideWindow: () => undefined,
  handleCloseOrHideWindowAccelerator: () => on('window-controls:request-close', () => undefined),
  hideWindow: () => undefined,
  isMaximizedWindow: (callback: BridgeCallback) => on('window-controls:toggle-maximized', callback),
  maximizeWindow: () => undefined,
  minimizeWindow: () => undefined,
  rebuildMenu: () => undefined,
  reloadWindow: () => window.location.reload(),
  removeHandleCloseOrHideWindowAccelerator: () => removeAllListeners('window-controls:request-close'),
  windowIsClosing: (callback: BridgeCallback) => on('window-controls:is-closing', callback),

  handleUpdateTheme: (callback: BridgeCallback) => on('system:update-theme', callback),
  winHandleUpdateTheme: () => send('system:update-theme'),

  exportProjectXml: async (
    pathToUserProject: string,
    dataToCreateXml: ProjectState['data'],
    parseTo: 'old-editor' | 'codesys',
  ): Promise<{ success: boolean; message: string }> => {
    const result = await invoke<{ success: boolean; message: string; content?: string; filePath?: string }>(
      'compiler:export-project-xml',
      pathToUserProject,
      dataToCreateXml,
      parseTo,
    )

    if (result.success && result.content) {
      const filename = result.filePath?.split(/[\\/]/).pop() || 'plc.xml'
      triggerDownload(filename, result.content)
    }

    return { success: result.success, message: result.message }
  },

  runCompileProgram: (
    compileProgramArgs: Array<string | boolean | null | ProjectState['data']>,
    callback: (args: any) => void,
  ) => {
    runCompileStream('compiler:run-compile-program', compileProgramArgs, callback)
  },

  runDebugCompilation: (compileArgs: Array<string | ProjectState['data']>, callback: (args: any) => void) => {
    runCompileStream('compiler:run-debug-compilation', compileArgs, callback)
  },

  compileRequest: (_xmlPath: string, _callback: (args: any) => void) => undefined,
  createBuildDirectory: (_pathToUserProject: string): Promise<{ success: boolean; message: string }> =>
    Promise.resolve({
      success: false,
      message: 'Deprecated',
    }),
  createXmlFileToBuild: (
    _pathToUserProject: string,
    _dataToCreateXml: ProjectState['data'],
  ): Promise<{ success: boolean; message: string }> => Promise.resolve({ success: false, message: 'Deprecated' }),
  exportProjectRequest: (callback: BridgeCallback) => on('compiler:export-project-request', callback),
  generateCFilesRequest: (_pathToStProgram: string, _callback: (args: any) => void) => undefined,
  removeExportProjectListener: () => removeAllListeners('compiler:export-project-request'),
  setupCompilerEnvironment: (_callback: (args: any) => void) => undefined,

  getAvailableBoards: (): Promise<Map<string, unknown>> => invoke('hardware:get-available-boards'),
  getAvailableCommunicationPorts: (): Promise<{ name: string; address: string }[]> =>
    invoke('hardware:get-available-communication-ports'),
  refreshAvailableBoards: (): Promise<{ board: string; version: string }[]> =>
    invoke('hardware:refresh-available-boards'),
  refreshCommunicationPorts: (): Promise<{ name: string; address: string }[]> =>
    invoke('hardware:refresh-communication-ports'),

  getPreviewImage: (image: string): Promise<string> => invoke('util:get-preview-image', image),
  log: (level: 'info' | 'error', message: string) => send('util:log', { level, message }),
  readDebugFile: (
    projectPath: string,
    boardTarget: string,
  ): Promise<{ success: boolean; content?: string; error?: string }> =>
    invoke('util:read-debug-file', projectPath, boardTarget),

  debuggerVerifyMd5: (
    connectionType: 'tcp' | 'rtu' | 'websocket' | 'simulator',
    connectionParams: {
      ipAddress?: string
      port?: string
      baudRate?: number
      slaveId?: number
      jwtToken?: string
    },
    expectedMd5: string,
  ): Promise<{ success: boolean; match?: boolean; targetMd5?: string; error?: string }> =>
    invoke('debugger:verify-md5', connectionType, connectionParams, expectedMd5),

  debuggerReadProgramStMd5: (
    projectPath: string,
    boardTarget: string,
  ): Promise<{ success: boolean; md5?: string; error?: string }> =>
    invoke('debugger:read-program-st-md5', projectPath, boardTarget),

  debuggerGetVariablesList: (
    variableIndexes: number[],
  ): Promise<{
    success: boolean
    tick?: number
    lastIndex?: number
    data?: number[]
    error?: string
    needsReconnect?: boolean
  }> => invoke('debugger:get-variables-list', variableIndexes),

  debuggerSetVariable: (
    variableIndex: number,
    force: boolean,
    valueBuffer?: Uint8Array,
  ): Promise<{ success: boolean; error?: string }> =>
    invoke('debugger:set-variable', variableIndex, force, valueBuffer),

  debuggerConnect: (
    connectionType: 'tcp' | 'rtu' | 'websocket' | 'simulator',
    connectionParams: {
      ipAddress?: string
      port?: string
      baudRate?: number
      slaveId?: number
      jwtToken?: string
    },
  ): Promise<{ success: boolean; error?: string }> => invoke('debugger:connect', connectionType, connectionParams),

  debuggerDisconnect: (): Promise<{ success: boolean }> => invoke('debugger:disconnect'),

  runtimeGetUsersInfo: (ipAddress: string): Promise<{ hasUsers: boolean; runtimeVersion?: string; error?: string }> =>
    invoke('runtime:get-users-info', ipAddress),
  runtimeCreateUser: (
    ipAddress: string,
    username: string,
    password: string,
  ): Promise<{ success: boolean; error?: string }> => invoke('runtime:create-user', ipAddress, username, password),
  runtimeLogin: (
    ipAddress: string,
    username: string,
    password: string,
  ): Promise<{ success: boolean; accessToken?: string; error?: string }> =>
    invoke('runtime:login', ipAddress, username, password),
  runtimeGetStatus: (
    ipAddress: string,
    jwtToken: string,
    includeStats?: boolean,
  ): Promise<{
    success: boolean
    status?: string
    timingStats?: {
      scan_count: number
      scan_time_min: number | null
      scan_time_max: number | null
      scan_time_avg: number | null
      cycle_time_min: number | null
      cycle_time_max: number | null
      cycle_time_avg: number | null
      cycle_latency_min: number | null
      cycle_latency_max: number | null
      cycle_latency_avg: number | null
      overruns: number
    }
    error?: string
  }> => invoke('runtime:get-status', ipAddress, jwtToken, includeStats),
  runtimeStartPlc: (ipAddress: string, jwtToken: string): Promise<{ success: boolean; error?: string }> =>
    invoke('runtime:start-plc', ipAddress, jwtToken),
  runtimeStopPlc: (ipAddress: string, jwtToken: string): Promise<{ success: boolean; error?: string }> =>
    invoke('runtime:stop-plc', ipAddress, jwtToken),
  runtimeGetCompilationStatus: (
    ipAddress: string,
    jwtToken: string,
  ): Promise<{
    success: boolean
    data?: { status: string; logs: string[]; exit_code: number | null }
    error?: string
  }> => invoke('runtime:get-compilation-status', ipAddress, jwtToken),
  runtimeGetLogs: (
    ipAddress: string,
    jwtToken: string,
    minId?: number,
  ): Promise<{ success: boolean; logs?: string | RuntimeLogEntry[]; error?: string }> =>
    invoke('runtime:get-logs', ipAddress, jwtToken, minId),
  runtimeClearCredentials: (): Promise<{ success: boolean }> => invoke('runtime:clear-credentials'),
  runtimeGetSerialPorts: (
    ipAddress: string,
    jwtToken: string,
  ): Promise<{ success: boolean; ports?: Array<{ device: string; description?: string }>; error?: string }> =>
    invoke('runtime:get-serial-ports', ipAddress, jwtToken),
  onRuntimeTokenRefreshed: (callback: (_event: unknown, newToken: string) => void) => {
    on('runtime:token-refreshed', callback)
    return () => removeAllListeners('runtime:token-refreshed')
  },

  simulatorLoadFirmware: (hexPath: string): Promise<{ success: boolean; error?: string }> =>
    invoke('simulator:load-firmware', hexPath),
  simulatorStop: (): Promise<{ success: boolean }> => invoke('simulator:stop'),
  simulatorIsRunning: (): Promise<boolean> => invoke('simulator:is-running'),
  onSimulatorStopped: (callback: () => void) => {
    on('simulator:stopped', () => callback())
    return () => removeAllListeners('simulator:stopped')
  },

  fileWatchStart: (filePath: string): Promise<{ success: boolean; error?: string }> =>
    invoke('file:watch-start', filePath),
  fileWatchStop: (filePath: string): Promise<{ success: boolean }> => invoke('file:watch-stop', filePath),
  fileWatchStopAll: (): Promise<{ success: boolean }> => invoke('file:watch-stop-all'),
  fileReadContent: (filePath: string): Promise<{ success: boolean; content?: string; error?: string }> =>
    invoke('file:read-content', filePath),
  onFileExternalChange: (callback: (_event: unknown, data: { filePath: string }) => void) => {
    on('file:external-change', callback)
    return () => removeAllListeners('file:external-change')
  },
}

export type PlatformBridge = typeof webBridge

export default webBridge
