import { getProjectPath } from '@root/main/utils'
import { serverEventBus } from '@root/server/event-bus'
import { WebSocketCompileStreamPort } from '@root/shared/platform/compile-stream-port'
import { deserializeFromTransport, serializeForTransport } from '@root/shared/platform/json-serialization'
import { getUserDataPath } from '@root/shared/platform/paths'
import { CreatePouFileProps } from '@root/types/IPC/pou-service'
import { CreateProjectFileProps } from '@root/types/IPC/project-service'
import { DeviceConfiguration, DevicePin } from '@root/types/PLC/devices'
import { RuntimeLogEntry } from '@root/types/PLC/runtime-logs'
import { getRuntimeHttpsOptions } from '@root/utils/runtime-https-config'
import type { Express, Request, Response } from 'express'
import { readFile, realpathSync, stat, statSync, unwatchFile, watchFile } from 'fs'
import type { IncomingMessage } from 'http'
import https from 'https'
import { join, resolve, sep } from 'path'
import { platform } from 'process'
import type { WebSocket } from 'ws'

import { ProjectState } from '../../../renderer/store/slices'
import { PLCPou, PLCProject } from '../../../types/PLC/open-plc'
import { store } from '../../modules/store'
import { logger } from '../../services'
import { PouService, ProjectService } from '../../services'
import { CompilerModule } from '../compiler'
import { HardwareModule } from '../hardware'
import { ModbusTcpClient } from '../modbus/modbus-client'
import { ModbusRtuClient } from '../modbus/modbus-rtu-client'
import { SimulatorModule } from '../simulator/simulator-module'
import { VirtualSerialPort } from '../simulator/virtual-serial-port'
import { WebSocketDebugClient } from '../websocket/websocket-debug-client'

export type ApiBridgeConstructor = {
  projectService: ProjectService
  pouService: PouService
  compilerModule: CompilerModule
  hardwareModule: HardwareModule
}

type IDataToWrite = {
  projectPath: string
  content: {
    pous: PLCPou[]
    projectData: PLCProject
    deviceConfiguration: DeviceConfiguration
    devicePinMapping: DevicePin[]
  }
}

class ApiBridge {
  projectService
  pouService
  compilerModule
  hardwareModule
  store = store
  private debuggerModbusClient: ModbusTcpClient | ModbusRtuClient | null = null
  private debuggerWebSocketClient: WebSocketDebugClient | null = null
  private debuggerTargetIp: string | null = null
  private debuggerReconnecting: boolean = false
  private debuggerConnectionType: 'tcp' | 'rtu' | 'websocket' | 'simulator' | null = null
  private debuggerRtuPort: string | null = null
  private debuggerRtuBaudRate: number | null = null
  private debuggerRtuSlaveId: number | null = null
  private debuggerJwtToken: string | null = null
  private runtimeCredentials: { ipAddress: string; username: string; password: string } | null = null
  private tokenRefreshInFlight: Promise<{ success: boolean; accessToken?: string; error?: string }> | null = null
  // Current project root path used to validate file-watcher IPC calls
  private currentProjectPath: string | null = null
  // File watchers for auto-reload functionality (using watchFile for better macOS compatibility)
  private fileWatchers: Map<string, { lastMtime: number }> = new Map()
  // avr8js ATmega2560 emulator instance for the built-in simulator
  private simulatorModule = new SimulatorModule()

  constructor({ projectService, pouService, compilerModule, hardwareModule }: ApiBridgeConstructor) {
    this.projectService = projectService
    this.pouService = pouService
    this.compilerModule = compilerModule
    this.hardwareModule = hardwareModule
  }

  private emitToRenderer(channel: string, ...args: unknown[]): void {
    serverEventBus.emitEvent(channel, ...args)
  }

  // ===================== RUNTIME API HANDLERS =====================
  private readonly RUNTIME_API_PORT = 8443
  private readonly RUNTIME_CONNECTION_TIMEOUT_MS = 5000 // 5 seconds (important-comment)

  private formatRuntimeApiError(data: string, statusCode?: number): string {
    const trimmedData = data.trim()
    const statusMessage = statusCode ? `HTTP ${statusCode}` : 'Runtime request failed'

    if (!trimmedData) {
      return statusMessage
    }

    try {
      const parsed = JSON.parse(trimmedData) as { error?: unknown; message?: unknown; detail?: unknown }
      const parsedMessage = parsed.error ?? parsed.message ?? parsed.detail
      if (typeof parsedMessage === 'string' && parsedMessage.trim()) {
        return `${statusMessage}: ${parsedMessage}`
      }
    } catch {
      // Runtime responses are not always JSON; fall through to the raw body.
    }

    return `${statusMessage}: ${trimmedData}`
  }

  handleRuntimeGetUsersInfo = async (ipAddress: string) => {
    try {
      const url = `https://${ipAddress}:${this.RUNTIME_API_PORT}/api/get-users-info`

      return new Promise((resolve) => {
        const req = https.get(
          url,
          {
            ...getRuntimeHttpsOptions(),
          },
          (res: IncomingMessage) => {
            let data = ''
            res.on('data', (chunk: Buffer) => {
              data += chunk.toString()
            })
            res.on('end', () => {
              // Extract runtime version from response header
              const runtimeVersion = res.headers['x-openplc-runtime-version'] as string | undefined

              if (res.statusCode === 404) {
                resolve({ hasUsers: false, runtimeVersion })
              } else if (res.statusCode === 200) {
                resolve({ hasUsers: true, runtimeVersion })
              } else {
                resolve({ hasUsers: false, error: data || `Unexpected status: ${res.statusCode}`, runtimeVersion })
              }
            })
          },
        )
        req.setTimeout(this.RUNTIME_CONNECTION_TIMEOUT_MS, () => {
          req.destroy()
          resolve({ hasUsers: false, error: 'Connection timeout' })
        })
        req.on('error', (error: Error) => {
          resolve({ hasUsers: false, error: error.message })
        })
      })
    } catch (error) {
      return { hasUsers: false, error: String(error) }
    }
  }

  handleRuntimeCreateUser = async (ipAddress: string, username: string, password: string) => {
    try {
      const postData = JSON.stringify({ username, password, role: 'user' })

      return new Promise((resolve) => {
        const req = https.request(
          {
            hostname: ipAddress,
            port: this.RUNTIME_API_PORT,
            path: '/api/create-user',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData),
            },
            ...getRuntimeHttpsOptions(),
          },
          (res: IncomingMessage) => {
            let data = ''
            res.on('data', (chunk: Buffer) => {
              data += chunk.toString()
            })
            res.on('end', () => {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve({ success: true })
              } else {
                resolve({ success: false, error: this.formatRuntimeApiError(data, res.statusCode) })
              }
            })
          },
        )
        req.setTimeout(this.RUNTIME_CONNECTION_TIMEOUT_MS, () => {
          req.destroy()
          resolve({ success: false, error: 'Connection timeout' })
        })
        req.on('error', (error: Error) => {
          resolve({ success: false, error: error.message })
        })
        req.write(postData)
        req.end()
      })
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  private async performAuthentication(
    ipAddress: string,
    username: string,
    password: string,
  ): Promise<{ success: boolean; accessToken?: string; error?: string }> {
    try {
      const postData = JSON.stringify({ username, password })

      return new Promise((resolve) => {
        const req = https.request(
          {
            hostname: ipAddress,
            port: this.RUNTIME_API_PORT,
            path: '/api/login',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData),
            },
            ...getRuntimeHttpsOptions(),
          },
          (res: IncomingMessage) => {
            let data = ''
            res.on('data', (chunk: Buffer) => {
              data += chunk.toString()
            })
            res.on('end', () => {
              if (res.statusCode === 200) {
                try {
                  const response = JSON.parse(data) as { access_token: string }
                  resolve({ success: true, accessToken: response.access_token })
                } catch {
                  resolve({ success: false, error: 'Invalid response format' })
                }
              } else {
                resolve({ success: false, error: this.formatRuntimeApiError(data, res.statusCode) })
              }
            })
          },
        )
        req.setTimeout(this.RUNTIME_CONNECTION_TIMEOUT_MS, () => {
          req.destroy()
          resolve({ success: false, error: 'Connection timeout' })
        })
        req.on('error', (error: Error) => {
          resolve({ success: false, error: error.message })
        })
        req.write(postData)
        req.end()
      })
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  handleRuntimeLogin = async (ipAddress: string, username: string, password: string) => {
    const result = await this.performAuthentication(ipAddress, username, password)
    if (result.success && result.accessToken) {
      this.runtimeCredentials = { ipAddress, username, password }
    }
    return result
  }

  private async attemptTokenRefresh(): Promise<{ success: boolean; accessToken?: string; error?: string }> {
    if (this.tokenRefreshInFlight) {
      return this.tokenRefreshInFlight
    }

    if (!this.runtimeCredentials) {
      return { success: false, error: 'No stored credentials available for token refresh' }
    }

    const { ipAddress, username, password } = this.runtimeCredentials

    this.tokenRefreshInFlight = this.performAuthentication(ipAddress, username, password).finally(() => {
      this.tokenRefreshInFlight = null
    })

    return this.tokenRefreshInFlight
  }

  private isTokenExpiredError(statusCode: number | undefined, errorMessage: string): boolean {
    if (statusCode === 401 || statusCode === 403) {
      return true
    }
    const lowerError = errorMessage.toLowerCase()
    return (
      lowerError.includes('unauthorized') ||
      lowerError.includes('token') ||
      lowerError.includes('expired') ||
      lowerError.includes('invalid token')
    )
  }

  makeRuntimeApiRequest<T = void>(
    ipAddress: string,
    jwtToken: string,
    endpoint: string,
    responseParser?: (data: string) => T,
  ): Promise<{ success: true; data?: T } | { success: false; error: string }> {
    return new Promise((resolve) => {
      const req = https.get(
        `https://${ipAddress}:${this.RUNTIME_API_PORT}${endpoint}`,
        {
          headers: {
            Authorization: `Bearer ${jwtToken}`,
          },
          ...getRuntimeHttpsOptions(),
        },
        (res: IncomingMessage) => {
          let data = ''
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString()
          })
          res.on('end', () => {
            if (res.statusCode === 200) {
              if (responseParser) {
                try {
                  const parsedData = responseParser(data)
                  resolve({ success: true, data: parsedData })
                } catch {
                  resolve({ success: false, error: 'Invalid response format' })
                }
              } else {
                resolve({ success: true })
              }
            } else if (this.isTokenExpiredError(res.statusCode, data)) {
              void this.attemptTokenRefresh().then((refreshResult) => {
                if (refreshResult.success && refreshResult.accessToken) {
                  if (refreshResult.accessToken) {
                    this.emitToRenderer('runtime:token-refreshed', refreshResult.accessToken)
                  }
                  const retryReq = https.get(
                    `https://${ipAddress}:${this.RUNTIME_API_PORT}${endpoint}`,
                    {
                      headers: {
                        Authorization: `Bearer ${refreshResult.accessToken}`,
                      },
                      ...getRuntimeHttpsOptions(),
                    },
                    (retryRes: IncomingMessage) => {
                      let retryData = ''
                      retryRes.on('data', (chunk: Buffer) => {
                        retryData += chunk.toString()
                      })
                      retryRes.on('end', () => {
                        if (retryRes.statusCode === 200) {
                          if (responseParser) {
                            try {
                              const parsedData = responseParser(retryData)
                              resolve({ success: true, data: parsedData })
                            } catch {
                              resolve({ success: false, error: 'Invalid response format' })
                            }
                          } else {
                            resolve({ success: true })
                          }
                        } else {
                          resolve({ success: false, error: retryData })
                        }
                      })
                    },
                  )
                  retryReq.setTimeout(this.RUNTIME_CONNECTION_TIMEOUT_MS, () => {
                    retryReq.destroy()
                    resolve({ success: false, error: 'Connection timeout' })
                  })
                  retryReq.on('error', (error: Error) => {
                    resolve({ success: false, error: error.message })
                  })
                } else {
                  resolve({
                    success: false,
                    error: refreshResult.error ? `Token refresh failed: ${refreshResult.error}` : data,
                  })
                }
              })
            } else {
              resolve({ success: false, error: data })
            }
          })
        },
      )
      req.setTimeout(this.RUNTIME_CONNECTION_TIMEOUT_MS, () => {
        req.destroy()
        resolve({ success: false, error: 'Connection timeout' })
      })
      req.on('error', (error: Error) => {
        resolve({ success: false, error: error.message })
      })
    })
  }

  handleRuntimeGetStatus = async (ipAddress: string, jwtToken: string, includeStats?: boolean) => {
    try {
      // Build the endpoint path with optional include_stats query parameter
      const endpoint = includeStats ? '/api/status?include_stats=true' : '/api/status'

      const result = await this.makeRuntimeApiRequest<{
        status: string
        timing_stats?: {
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
      }>(ipAddress, jwtToken, endpoint, (data: string) => {
        const response = JSON.parse(data) as {
          status: string
          timing_stats?: {
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
        }
        return response
      })

      if (result.success && result.data) {
        return {
          success: true,
          status: result.data.status,
          timingStats: result.data.timing_stats,
        }
      } else {
        return { success: false, error: !result.success ? result.error : 'Unknown error' }
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  handleRuntimeStartPlc = async (ipAddress: string, jwtToken: string) => {
    try {
      return await this.makeRuntimeApiRequest(ipAddress, jwtToken, '/api/start-plc')
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  handleRuntimeStopPlc = async (ipAddress: string, jwtToken: string) => {
    try {
      return await this.makeRuntimeApiRequest(ipAddress, jwtToken, '/api/stop-plc')
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  handleRuntimeGetCompilationStatus = async (ipAddress: string, jwtToken: string) => {
    try {
      const result = await this.makeRuntimeApiRequest<{ status: string; logs: string[]; exit_code: number | null }>(
        ipAddress,
        jwtToken,
        '/api/compilation-status',
        (data: string) => {
          const response = JSON.parse(data) as { status: string; logs: string[]; exit_code: number | null }
          return response
        },
      )
      return result
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  handleRuntimeGetLogs = async (ipAddress: string, jwtToken: string, minId?: number) => {
    try {
      const endpoint = minId !== undefined ? `/api/runtime-logs?id=${minId}` : '/api/runtime-logs'
      const result = await this.makeRuntimeApiRequest<string | RuntimeLogEntry[]>(
        ipAddress,
        jwtToken,
        endpoint,
        (data: string) => {
          const response = JSON.parse(data) as { 'runtime-logs': string | RuntimeLogEntry[] }
          return response['runtime-logs']
        },
      )
      if (result.success) {
        return { success: true, logs: result.data }
      } else {
        return { success: false, error: result.error }
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  handleRuntimeClearCredentials = () => {
    this.runtimeCredentials = null
    return { success: true }
  }

  handleRuntimeGetSerialPorts = async (
    ipAddress: string,
    jwtToken: string,
  ): Promise<{ success: boolean; ports?: Array<{ device: string; description?: string }>; error?: string }> => {
    try {
      const result = await this.makeRuntimeApiRequest<{ ports: Array<{ device: string; description?: string }> }>(
        ipAddress,
        jwtToken,
        '/api/serial-ports',
        (data: string) => {
          const response = JSON.parse(data) as {
            ports?: Array<{ device: string; description?: string }>
            error?: string
          }
          if (response.error) {
            throw new Error(response.error)
          }
          return { ports: response.ports || [] }
        },
      )
      if (result.success && result.data) {
        return { success: true, ports: result.data.ports }
      } else {
        return { success: false, error: result.success ? 'No data returned' : result.error }
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  registerHttpRoutes(app: Express): void {
    app.post('/api/invoke/:channel', async (req: Request, res: Response) => {
      try {
        const channel = req.params.channel
        const args = deserializeFromTransport(req.body?.args ?? []) as unknown[]
        const result = await this.dispatchInvoke(channel, args)
        res.json({ ok: true, result: serializeForTransport(result) })
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })

    app.post('/api/send/:channel', (req: Request, res: Response) => {
      try {
        const channel = req.params.channel
        const args = deserializeFromTransport(req.body?.args ?? []) as unknown[]
        this.dispatchSend(channel, args)
        res.json({ ok: true })
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }

  handleWebSocketMessage = (socket: WebSocket, payload: { type: string; args?: unknown[] }): void => {
    if (payload.type === 'compiler:run-compile-program') {
      const streamPort = new WebSocketCompileStreamPort((data) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'compile-message', data: serializeForTransport(data) }))
        }
      })
      void this.compilerModule.compileProgram(
        deserializeFromTransport(payload.args ?? []) as Array<string | null | ProjectState['data']>,
        streamPort,
        this,
      )
      return
    }

    if (payload.type === 'compiler:run-debug-compilation') {
      const streamPort = new WebSocketCompileStreamPort((data) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'compile-message', data: serializeForTransport(data) }))
        }
      })
      void this.compilerModule.compileForDebugger(
        deserializeFromTransport(payload.args ?? []) as Array<string | ProjectState['data']>,
        streamPort,
      )
    }
  }

  private async dispatchInvoke(channel: string, args: unknown[]): Promise<unknown> {
    switch (channel) {
      case 'project:create':
        return this.handleProjectCreate(args[0] as CreateProjectFileProps)
      case 'project:open':
        return this.handleProjectOpen()
      case 'project:path-picker':
        return this.handleProjectPathPicker()
      case 'project:save':
        return this.handleProjectSave(args[0] as IDataToWrite)
      case 'project:save-file':
        return this.handleFileSave(args[0] as string, args[1])
      case 'project:open-by-path':
        return this.handleProjectOpenByPath(args[0] as string)
      case 'pou:create':
        return this.handleCreatePouFile(args[0] as CreatePouFileProps)
      case 'pou:delete':
        return this.handleDeletePouFile(args[0] as string)
      case 'pou:rename':
        return this.handleRenamePouFile(args[0] as { filePath: string; newFileName: string; fileContent?: unknown })
      case 'open-external-link':
        return this.handleOpenExternalLink(args[0] as string)
      case 'system:get-system-info':
        return this.handleGetSystemInfo()
      case 'app:store-retrieve-recent':
        return this.handleStoreRetrieveRecent()
      case 'compiler:export-project-xml':
        return this.handleCompilerExportProjectXml(
          args[0] as string,
          args[1] as ProjectState['data'],
          args[2] as 'old-editor' | 'codesys',
        )
      case 'hardware:get-available-communication-ports':
        return this.handleHardwareGetAvailableCommunicationPorts()
      case 'hardware:get-available-boards':
        return this.handleHardwareGetAvailableBoards()
      case 'hardware:refresh-communication-ports':
        return this.handleHardwareRefreshCommunicationPorts()
      case 'hardware:refresh-available-boards':
        return this.handleHardwareRefreshAvailableBoards()
      case 'util:get-preview-image':
        return this.handleUtilGetPreviewImage(args[0] as string)
      case 'util:read-debug-file':
        return this.handleReadDebugFile(args[0] as string, args[1] as string)
      case 'debugger:verify-md5':
        return this.handleDebuggerVerifyMd5(
          args[0] as 'tcp' | 'rtu' | 'websocket' | 'simulator',
          args[1] as {
            ipAddress?: string
            port?: string
            baudRate?: number
            slaveId?: number
            jwtToken?: string
          },
          args[2] as string,
        )
      case 'debugger:read-program-st-md5':
        return this.handleReadProgramStMd5(args[0] as string, args[1] as string)
      case 'debugger:get-variables-list':
        return this.handleDebuggerGetVariablesList(args[0] as number[])
      case 'debugger:set-variable':
        return this.handleDebuggerSetVariable(args[0] as number, args[1] as boolean, args[2] as Uint8Array | undefined)
      case 'debugger:connect':
        return this.handleDebuggerConnect(
          args[0] as 'tcp' | 'rtu' | 'websocket' | 'simulator',
          args[1] as {
            ipAddress?: string
            port?: string
            baudRate?: number
            slaveId?: number
            jwtToken?: string
          },
        )
      case 'debugger:disconnect':
        return this.handleDebuggerDisconnect()
      case 'runtime:get-users-info':
        return this.handleRuntimeGetUsersInfo(args[0] as string)
      case 'runtime:create-user':
        return this.handleRuntimeCreateUser(args[0] as string, args[1] as string, args[2] as string)
      case 'runtime:login':
        return this.handleRuntimeLogin(args[0] as string, args[1] as string, args[2] as string)
      case 'runtime:get-status':
        return this.handleRuntimeGetStatus(args[0] as string, args[1] as string, args[2] as boolean | undefined)
      case 'runtime:start-plc':
        return this.handleRuntimeStartPlc(args[0] as string, args[1] as string)
      case 'runtime:stop-plc':
        return this.handleRuntimeStopPlc(args[0] as string, args[1] as string)
      case 'runtime:get-compilation-status':
        return this.handleRuntimeGetCompilationStatus(args[0] as string, args[1] as string)
      case 'runtime:get-logs':
        return this.handleRuntimeGetLogs(args[0] as string, args[1] as string, args[2] as number | undefined)
      case 'runtime:clear-credentials':
        return this.handleRuntimeClearCredentials()
      case 'runtime:get-serial-ports':
        return this.handleRuntimeGetSerialPorts(args[0] as string, args[1] as string)
      case 'simulator:load-firmware':
        return this.handleSimulatorLoadFirmware(args[0] as string)
      case 'simulator:stop':
        return this.handleSimulatorStop()
      case 'simulator:is-running':
        return this.handleSimulatorIsRunning()
      case 'file:watch-start':
        return this.handleFileWatchStart(args[0] as string)
      case 'file:watch-stop':
        return this.handleFileWatchStop(args[0] as string)
      case 'file:watch-stop-all':
        return this.handleFileWatchStopAll()
      case 'file:read-content':
        return this.handleFileReadContent(args[0] as string)
      default:
        throw new Error(`Unknown invoke channel: ${channel}`)
    }
  }

  private dispatchSend(channel: string, args: unknown[]): void {
    switch (channel) {
      case 'app:quit':
        this.handleAppQuit()
        break
      case 'system:update-theme':
        this.mainIpcEventHandlers.handleUpdateTheme()
        this.emitToRenderer('system:update-theme')
        break
      case 'util:log': {
        const payload = args[0] as { level: 'info' | 'error'; message: string }
        this.handleUtilLog(payload)
        break
      }
      default:
        break
    }
  }

  // ===================== HANDLER METHODS =====================
  // Project-related handlers
  handleProjectCreate = async (data: CreateProjectFileProps) => {
    this.stopSimulatorAndNotify()
    const response = await this.projectService.createProject(data)
    return response
  }
  handleProjectOpen = async () => {
    this.stopSimulatorAndNotify()
    const response = await this.projectService.openProject()
    if (response.success && response.data?.meta.path) {
      this.currentProjectPath = response.data.meta.path
    }
    return response
  }
  handleProjectPathPicker = async () => {
    try {
      const res = await getProjectPath()
      return res
    } catch (error) {
      console.error('Error getting project path:', error)
      return undefined
    }
  }
  handleFileSave = async (filePath: string, content: unknown) => {
    const result = await this.projectService.saveFile(filePath, content)
    if (result.success) {
      // Update lastMtime for the saved file's watcher to suppress self-trigger
      const watcherData = this.fileWatchers.get(filePath)
      if (watcherData) {
        try {
          const stats = statSync(filePath)
          if (stats.mtimeMs > watcherData.lastMtime) {
            watcherData.lastMtime = stats.mtimeMs
          }
        } catch {
          /* file may not exist */
        }
      }
    }
    return result
  }
  handleProjectSave = ({ projectPath, content }: IDataToWrite) =>
    this.projectService.saveProject({ projectPath, content })
  handleProjectOpenByPath = async (projectPath: string) => {
    this.stopSimulatorAndNotify()
    try {
      const response = await this.projectService.openProjectByPath(projectPath)
      if (response.success && response.data?.meta.path) {
        this.currentProjectPath = response.data.meta.path
      }
      return response
    } catch (_error) {
      return {
        success: false,
        error: {
          title: 'Error opening project',
          description: 'Please try again',
        },
      }
    }
  }

  // Pou-related handlers
  handleCreatePouFile = async (props: CreatePouFileProps) => {
    try {
      const response = await this.pouService.createPouFile(props)
      return response
    } catch (error) {
      console.error('Error creating POU file:', error)
      return {
        success: false,
        error: {
          title: 'Error creating POU file',
          description: 'Please try again',
          error,
        },
      }
    }
  }
  handleDeletePouFile = async (filePath: string) => {
    try {
      const response = await this.pouService.deletePouFile(filePath)
      return response
    } catch (error) {
      console.error('Error deleting POU file:', error)
      return {
        success: false,
        error: {
          title: 'Error deleting POU file',
          description: 'Please try again',
          error,
        },
      }
    }
  }
  handleRenamePouFile = async (data: { filePath: string; newFileName: string; fileContent?: unknown }) => {
    try {
      const response = await this.pouService.renamePouFile(data)
      return response
    } catch (error) {
      console.error('Error renaming POU file:', error)
      return {
        success: false,
        error: {
          title: 'Error renaming POU file',
          description: 'Please try again',
          error,
        },
      }
    }
  }

  // App and system handlers
  handleOpenExternalLink = (url: string) => {
    return { success: true, url }
  }
  handleGetSystemInfo = async () => {
    const savedTheme = await this.store.get('theme')
    if (savedTheme === 'dark' || savedTheme === 'light') {
      // Theme is managed in the browser for the web version.
    }

    return {
      OS: platform,
      architecture: process.arch === 'arm64' ? 'arm' : 'x64',
      prefersDarkMode: savedTheme === 'dark',
      isWindowMaximized: false,
    }
  }
  handleStoreRetrieveRecent = async () => {
    const pathToUserDataFolder = join(getUserDataPath(), 'User')
    const pathToUserHistoryFolder = join(pathToUserDataFolder, 'History')
    const projectsFilePath = join(pathToUserHistoryFolder, 'projects.json')
    const response = await this.projectService.readProjectHistory(projectsFilePath)
    try {
      return response
    } catch (error) {
      console.error('Error reading history file:', error)
      return []
    }
  }
  handleAppQuit = () => {
    this.simulatorModule.stop()
  }

  // Compiler service handlers
  // TODO: This handle should be refactored to use a new approach on module implementation.
  handleCompilerExportProjectXml = (
    pathToUserProject: string,
    dataToCreateXml: ProjectState['data'],
    xmlFormatTarget: 'old-editor' | 'codesys',
  ) => this.compilerModule.createXmlFile(pathToUserProject, dataToCreateXml, xmlFormatTarget)

  // Hardware handlers
  handleHardwareGetAvailableCommunicationPorts = async () => this.hardwareModule.getAvailableSerialPorts()
  handleHardwareGetAvailableBoards = async () => this.hardwareModule.getAvailableBoards()
  handleHardwareRefreshCommunicationPorts = async () => this.hardwareModule.getAvailableSerialPorts()
  handleHardwareRefreshAvailableBoards = async () => this.hardwareModule.getAvailableBoards()

  // Utility handlers
  handleUtilGetPreviewImage = async (image: string) => this.hardwareModule.getBoardImagePreview(image)
  handleUtilLog = ({ level, message }: { level: 'info' | 'error'; message: string }) => {
    logger[level](message)
  }
  handleReadDebugFile = async (projectPath: string, boardTarget: string) => {
    try {
      const fs = await import('fs/promises')
      const path = await import('path')

      // projectPath is already the project directory, not a file path
      // Guard against traversal/absolute input in boardTarget
      if (path.isAbsolute(boardTarget) || boardTarget.includes('..') || boardTarget.includes(path.sep)) {
        return { success: false, error: 'Invalid board target' }
      }
      const debugFilePath = path.resolve(projectPath, 'build', boardTarget, 'src', 'debug.c')

      const content = await fs.readFile(debugFilePath, 'utf-8')
      return { success: true, content }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read debug.c file',
      }
    }
  }

  handleDebuggerVerifyMd5 = async (
    connectionType: 'tcp' | 'rtu' | 'websocket' | 'simulator',
    connectionParams: {
      ipAddress?: string
      port?: string
      baudRate?: number
      slaveId?: number
      jwtToken?: string
    },
    expectedMd5: string,
  ): Promise<{ success: boolean; match?: boolean; targetMd5?: string; error?: string }> => {
    let client: ModbusTcpClient | ModbusRtuClient | null = null
    let wsClient: WebSocketDebugClient | null = null
    try {
      if (connectionType === 'simulator') {
        const virtualPort = new VirtualSerialPort(this.simulatorModule)
        client = new ModbusRtuClient({
          port: 'simulator',
          baudRate: 115200,
          slaveId: 1,
          timeout: 5000,
          serialPort: virtualPort,
        })
        await client.connect()
        const targetMd5 = await client.getMd5Hash()
        const match = targetMd5.toLowerCase() === expectedMd5.toLowerCase()

        // Keep the client for subsequent debug operations
        this.debuggerModbusClient = client
        this.debuggerConnectionType = 'simulator'

        return { success: true, match, targetMd5 }
      } else if (connectionType === 'websocket') {
        if (!connectionParams.ipAddress || !connectionParams.jwtToken) {
          return { success: false, error: 'IP address and JWT token are required for WebSocket connection' }
        }
        if (!this.debuggerWebSocketClient) {
          wsClient = new WebSocketDebugClient({
            host: connectionParams.ipAddress,
            port: 8443,
            token: connectionParams.jwtToken,
            rejectUnauthorized: false,
          })
          await wsClient.connect()
        } else {
          wsClient = this.debuggerWebSocketClient
        }

        const targetMd5 = await wsClient.getMd5Hash()

        const match = targetMd5.toLowerCase() === expectedMd5.toLowerCase()

        if (!this.debuggerWebSocketClient) {
          this.debuggerWebSocketClient = wsClient
          this.debuggerTargetIp = connectionParams.ipAddress
          this.debuggerJwtToken = connectionParams.jwtToken
          this.debuggerConnectionType = 'websocket'
        }

        return { success: true, match, targetMd5 }
      } else if (connectionType === 'tcp') {
        if (!connectionParams.ipAddress) {
          return { success: false, error: 'IP address is required for TCP connection' }
        }
        client = new ModbusTcpClient({
          host: connectionParams.ipAddress,
          port: 502,
          timeout: 5000,
        })
      } else {
        if (!connectionParams.port || !connectionParams.baudRate || connectionParams.slaveId === undefined) {
          return { success: false, error: 'Port, baud rate, and slave ID are required for RTU connection' }
        }
        client = new ModbusRtuClient({
          port: connectionParams.port,
          baudRate: connectionParams.baudRate,
          slaveId: connectionParams.slaveId,
          timeout: 5000,
        })
      }

      await client.connect()
      const targetMd5 = await client.getMd5Hash()

      const match = targetMd5.toLowerCase() === expectedMd5.toLowerCase()

      if (connectionType === 'tcp') {
        client.disconnect()
      } else {
        this.debuggerModbusClient = client
        this.debuggerConnectionType = 'rtu'
        this.debuggerRtuPort = connectionParams.port!
        this.debuggerRtuBaudRate = connectionParams.baudRate!
        this.debuggerRtuSlaveId = connectionParams.slaveId!
      }

      return { success: true, match, targetMd5 }
    } catch (error) {
      client?.disconnect()
      wsClient?.disconnect()
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error during MD5 verification',
      }
    }
  }

  handleReadProgramStMd5 = async (
    projectPath: string,
    boardTarget: string,
  ): Promise<{ success: boolean; md5?: string; error?: string }> => {
    try {
      const fs = await import('fs/promises')
      const path = await import('path')

      // projectPath is already the project directory, not a file path
      // Guard against traversal/absolute input in boardTarget
      if (path.isAbsolute(boardTarget) || boardTarget.includes('..') || boardTarget.includes(path.sep)) {
        return { success: false, error: 'Invalid board target' }
      }
      const programStPath = path.resolve(projectPath, 'build', boardTarget, 'src', 'program.st')

      const content = await fs.readFile(programStPath, 'utf-8')

      const md5Pattern = /\(\*DBG:char md5\[\] = "([a-fA-F0-9]{32})";?\*\)/
      const match = content.match(md5Pattern)

      if (!match || !match[1]) {
        return {
          success: false,
          error: 'Could not find MD5 hash in program.st file',
        }
      }

      return { success: true, md5: match[1] }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read program.st file',
      }
    }
  }

  handleDebuggerGetVariablesList = async (
    variableIndexes: number[],
  ): Promise<{
    success: boolean
    tick?: number
    lastIndex?: number
    data?: number[]
    error?: string
    needsReconnect?: boolean
  }> => {
    // If connection type is null, the debugger was intentionally disconnected.
    // Return a silent failure so the renderer polling ignores it.
    if (this.debuggerConnectionType === null) {
      return { success: false, error: 'Debugger not connected' }
    }

    if (this.debuggerConnectionType === 'websocket') {
      if (!this.debuggerWebSocketClient) {
        if (this.debuggerReconnecting) {
          return { success: false, error: 'Reconnection in progress', needsReconnect: true }
        }

        this.debuggerReconnecting = true
        try {
          if (!this.debuggerTargetIp || !this.debuggerJwtToken) {
            this.debuggerReconnecting = false
            return { success: false, error: 'No target IP or JWT token stored', needsReconnect: true }
          }
          this.debuggerWebSocketClient = new WebSocketDebugClient({
            host: this.debuggerTargetIp,
            port: 8443,
            token: this.debuggerJwtToken,
            rejectUnauthorized: false,
          })
          await this.debuggerWebSocketClient.connect()
          this.debuggerReconnecting = false
        } catch (error) {
          this.debuggerWebSocketClient = null
          this.debuggerReconnecting = false
          return { success: false, error: `Failed to reconnect: ${String(error)}`, needsReconnect: true }
        }
      }

      try {
        const result = await this.debuggerWebSocketClient.getVariablesList(variableIndexes)

        if (result.success && result.data) {
          return {
            success: true,
            tick: result.tick,
            lastIndex: result.lastIndex,
            data: Array.from(result.data),
          }
        }

        return { success: false, error: result.error }
      } catch (error) {
        if (this.debuggerWebSocketClient) {
          this.debuggerWebSocketClient.disconnect()
          this.debuggerWebSocketClient = null
        }
        return { success: false, error: String(error), needsReconnect: true }
      }
    }

    if (!this.debuggerModbusClient) {
      if (this.debuggerReconnecting) {
        return { success: false, error: 'Reconnection in progress', needsReconnect: true }
      }

      this.debuggerReconnecting = true
      try {
        if (this.debuggerConnectionType === 'simulator') {
          const virtualPort = new VirtualSerialPort(this.simulatorModule)
          this.debuggerModbusClient = new ModbusRtuClient({
            port: 'simulator',
            baudRate: 115200,
            slaveId: 1,
            timeout: 5000,
            serialPort: virtualPort,
          })
        } else if (this.debuggerConnectionType === 'tcp') {
          if (!this.debuggerTargetIp) {
            this.debuggerReconnecting = false
            return { success: false, error: 'No target IP address stored', needsReconnect: true }
          }
          this.debuggerModbusClient = new ModbusTcpClient({
            host: this.debuggerTargetIp,
            port: 502,
            timeout: 5000,
          })
        } else if (this.debuggerConnectionType === 'rtu') {
          if (!this.debuggerRtuPort || !this.debuggerRtuBaudRate || this.debuggerRtuSlaveId === null) {
            this.debuggerReconnecting = false
            return { success: false, error: 'No RTU connection parameters stored', needsReconnect: true }
          }
          this.debuggerModbusClient = new ModbusRtuClient({
            port: this.debuggerRtuPort,
            baudRate: this.debuggerRtuBaudRate,
            slaveId: this.debuggerRtuSlaveId,
            timeout: 5000,
          })
        } else {
          this.debuggerReconnecting = false
          return { success: false, error: 'No connection type stored', needsReconnect: true }
        }

        await this.debuggerModbusClient.connect()
        this.debuggerReconnecting = false
      } catch (error) {
        this.debuggerModbusClient = null
        this.debuggerReconnecting = false
        return { success: false, error: `Failed to reconnect: ${String(error)}`, needsReconnect: true }
      }
    }

    try {
      const result = await this.debuggerModbusClient.getVariablesList(variableIndexes)

      if (result.success && result.data) {
        return {
          success: true,
          tick: result.tick,
          lastIndex: result.lastIndex,
          data: Array.from(result.data),
        }
      }

      return { success: false, error: result.error }
    } catch (error) {
      if (this.debuggerModbusClient) {
        this.debuggerModbusClient.disconnect()
        this.debuggerModbusClient = null
      }
      return { success: false, error: String(error), needsReconnect: true }
    }
  }

  handleDebuggerConnect = async (
    connectionType: 'tcp' | 'rtu' | 'websocket' | 'simulator',
    connectionParams: {
      ipAddress?: string
      port?: string
      baudRate?: number
      slaveId?: number
      jwtToken?: string
    },
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      if (connectionType === 'simulator') {
        if (this.debuggerModbusClient) {
          this.debuggerModbusClient.disconnect()
          this.debuggerModbusClient = null
        }

        const virtualPort = new VirtualSerialPort(this.simulatorModule)
        this.debuggerModbusClient = new ModbusRtuClient({
          port: 'simulator',
          baudRate: 115200,
          slaveId: 1,
          timeout: 5000,
          serialPort: virtualPort,
        })
        await this.debuggerModbusClient.connect()

        // Trigger endianness detection on the emulated runtime.
        // getMd5Hash sends 0xDEAD which the runtime uses to detect byte order
        // and call set_endianness(). Without this, the default SAME_ENDIANNESS
        // causes multi-byte values to be stored with swapped bytes on the
        // little-endian AVR emulator.
        await this.debuggerModbusClient.getMd5Hash()
      } else if (connectionType === 'websocket') {
        if (this.debuggerModbusClient) {
          this.debuggerModbusClient.disconnect()
          this.debuggerModbusClient = null
        }

        if (!connectionParams.ipAddress || !connectionParams.jwtToken) {
          return { success: false, error: 'IP address and JWT token are required for WebSocket connection' }
        }

        if (!this.debuggerWebSocketClient || this.debuggerConnectionType !== 'websocket') {
          if (this.debuggerWebSocketClient) {
            this.debuggerWebSocketClient.disconnect()
            this.debuggerWebSocketClient = null
          }

          this.debuggerWebSocketClient = new WebSocketDebugClient({
            host: connectionParams.ipAddress,
            port: 8443,
            token: connectionParams.jwtToken,
            rejectUnauthorized: false,
          })
          await this.debuggerWebSocketClient.connect()
        }

        this.debuggerTargetIp = connectionParams.ipAddress
        this.debuggerJwtToken = connectionParams.jwtToken
      } else if (connectionType === 'tcp') {
        if (this.debuggerModbusClient) {
          this.debuggerModbusClient.disconnect()
          this.debuggerModbusClient = null
        }

        if (!connectionParams.ipAddress) {
          return { success: false, error: 'IP address is required for TCP connection' }
        }
        this.debuggerModbusClient = new ModbusTcpClient({
          host: connectionParams.ipAddress,
          port: 502,
          timeout: 5000,
        })
        await this.debuggerModbusClient.connect()
        this.debuggerTargetIp = connectionParams.ipAddress
      } else {
        if (!connectionParams.port || !connectionParams.baudRate || connectionParams.slaveId === undefined) {
          return { success: false, error: 'Port, baud rate, and slave ID are required for RTU connection' }
        }

        if (
          this.debuggerModbusClient &&
          this.debuggerConnectionType === 'rtu' &&
          this.debuggerRtuPort === connectionParams.port &&
          this.debuggerRtuBaudRate === connectionParams.baudRate &&
          this.debuggerRtuSlaveId === connectionParams.slaveId
        ) {
          this.debuggerReconnecting = false
          return { success: true }
        }

        if (this.debuggerModbusClient) {
          this.debuggerModbusClient.disconnect()
          this.debuggerModbusClient = null
        }

        this.debuggerModbusClient = new ModbusRtuClient({
          port: connectionParams.port,
          baudRate: connectionParams.baudRate,
          slaveId: connectionParams.slaveId,
          timeout: 5000,
        })
        await this.debuggerModbusClient.connect()
        this.debuggerRtuPort = connectionParams.port
        this.debuggerRtuBaudRate = connectionParams.baudRate
        this.debuggerRtuSlaveId = connectionParams.slaveId
      }

      this.debuggerConnectionType = connectionType
      this.debuggerReconnecting = false

      return { success: true }
    } catch (error) {
      this.debuggerModbusClient = null
      this.debuggerWebSocketClient = null
      this.debuggerTargetIp = null
      this.debuggerConnectionType = null
      this.debuggerRtuPort = null
      this.debuggerRtuBaudRate = null
      this.debuggerRtuSlaveId = null
      this.debuggerJwtToken = null
      return { success: false, error: String(error) }
    }
  }

  handleDebuggerDisconnect = (): Promise<{ success: boolean }> => {
    if (this.debuggerModbusClient) {
      this.debuggerModbusClient.disconnect()
      this.debuggerModbusClient = null
    }
    if (this.debuggerWebSocketClient) {
      this.debuggerWebSocketClient.disconnect()
      this.debuggerWebSocketClient = null
    }
    this.debuggerTargetIp = null
    this.debuggerConnectionType = null
    this.debuggerRtuPort = null
    this.debuggerRtuBaudRate = null
    this.debuggerRtuSlaveId = null
    this.debuggerJwtToken = null
    this.debuggerReconnecting = false
    return Promise.resolve({ success: true })
  }

  handleDebuggerSetVariable = async (
    variableIndex: number,
    force: boolean,
    valueBuffer?: Uint8Array,
  ): Promise<{ success: boolean; error?: string }> => {
    const buffer = valueBuffer ? Buffer.from(valueBuffer) : undefined

    if (this.debuggerConnectionType === 'websocket') {
      if (!this.debuggerWebSocketClient) {
        console.log('[IPC Handler] WebSocket client not connected')
        return { success: false, error: 'Not connected to debugger' }
      }

      try {
        const result = await this.debuggerWebSocketClient.setVariable(variableIndex, force, buffer)
        console.log('[IPC Handler] WebSocket setVariable result:', result)
        return result
      } catch (error) {
        console.error('[IPC Handler] WebSocket setVariable error:', error)
        return { success: false, error: String(error) }
      }
    }

    if (!this.debuggerModbusClient) {
      console.log('[IPC Handler] Modbus client not connected')
      return { success: false, error: 'Not connected to debugger' }
    }

    try {
      const result = await this.debuggerModbusClient.setVariable(variableIndex, force, buffer)
      console.log('[IPC Handler] Modbus setVariable result:', result)
      return result
    } catch (error) {
      console.error('[IPC Handler] Modbus setVariable error:', error)
      return { success: false, error: String(error) }
    }
  }

  // ===================== FILE WATCHER HANDLERS =====================

  /**
   * Validate that a file path is within the current project root.
   * Resolves symlinks to prevent directory traversal attacks.
   */
  private validateFilePath(filePath: string): boolean {
    if (!this.currentProjectPath) return false
    try {
      const resolved = realpathSync(resolve(filePath))
      const projectRoot = realpathSync(resolve(this.currentProjectPath))
      return resolved.startsWith(projectRoot + sep) || resolved === projectRoot
    } catch {
      // realpathSync fails if the file doesn't exist yet — fall back to resolve only
      const resolved = resolve(filePath)
      const projectRoot = resolve(this.currentProjectPath)
      return resolved.startsWith(projectRoot + sep) || resolved === projectRoot
    }
  }

  // ===================== SIMULATOR HANDLERS =====================

  /** Stops the simulator and notifies the renderer so it can update UI state. */
  private stopSimulatorAndNotify(): void {
    if (this.simulatorModule.isRunning()) {
      this.simulatorModule.stop()
      this.emitToRenderer('simulator:stopped')
    }
  }

  handleSimulatorLoadFirmware = async (hexPath: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await this.simulatorModule.loadAndRun(hexPath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  handleSimulatorStop = (): Promise<{ success: boolean }> => {
    this.simulatorModule.stop()
    return Promise.resolve({ success: true })
  }

  handleSimulatorIsRunning = (): Promise<boolean> => {
    return Promise.resolve(this.simulatorModule.isRunning())
  }

  // Using watchFile (polling-based) instead of watch for better macOS compatibility
  // fs.watch can fail when editors use "safe write" (write to temp file, then rename)
  handleFileWatchStart = (filePath: string): Promise<{ success: boolean; error?: string }> => {
    if (!this.validateFilePath(filePath)) {
      return Promise.resolve({ success: false, error: 'Path is outside the project directory' })
    }

    return new Promise((res) => {
      if (this.fileWatchers.has(filePath)) {
        res({ success: true })
        return
      }

      stat(filePath, (statErr, stats) => {
        if (statErr) {
          res({ success: false, error: `Failed to stat file: ${statErr.message}` })
          return
        }

        const initialMtime = stats.mtimeMs

        try {
          watchFile(filePath, { interval: 1000 }, (curr, prev) => {
            const watcherData = this.fileWatchers.get(filePath)
            if (!watcherData) return

            if (curr.mtimeMs > prev.mtimeMs && curr.mtimeMs > watcherData.lastMtime) {
              watcherData.lastMtime = curr.mtimeMs
              this.emitToRenderer('file:external-change', { filePath })
            }
          })

          this.fileWatchers.set(filePath, { lastMtime: initialMtime })
          res({ success: true })
        } catch (error) {
          res({ success: false, error: `Failed to watch file: ${String(error)}` })
        }
      })
    })
  }

  handleFileWatchStop = (filePath: string): { success: boolean; error?: string } => {
    if (!this.validateFilePath(filePath)) {
      return { success: false, error: 'Path is outside the project directory' }
    }
    if (this.fileWatchers.has(filePath)) {
      unwatchFile(filePath)
      this.fileWatchers.delete(filePath)
    }
    return { success: true }
  }

  handleFileWatchStopAll = (): { success: boolean } => {
    for (const [filePath] of this.fileWatchers) {
      unwatchFile(filePath)
    }
    this.fileWatchers.clear()
    return { success: true }
  }

  handleFileReadContent = (filePath: string): Promise<{ success: boolean; content?: string; error?: string }> => {
    if (!this.validateFilePath(filePath)) {
      return Promise.resolve({ success: false, error: 'Path is outside the project directory' })
    }
    return new Promise((res) => {
      readFile(filePath, 'utf-8', (err, content) => {
        if (err) {
          res({ success: false, error: `Failed to read file: ${err.message}` })
        } else {
          res({ success: true, content })
        }
      })
    })
  }

  // ===================== EVENT HANDLERS =====================
  mainIpcEventHandlers = {
    handleUpdateTheme: async () => {
      const currentTheme = await this.store.get('theme')
      const nextTheme = currentTheme === 'dark' ? 'light' : 'dark'
      await this.store.set('theme', nextTheme)
    },
    createPou: () => this.emitToRenderer('pou:createPou', { ok: true }),
  }
}

export default ApiBridge
