/* eslint-disable @typescript-eslint/no-explicit-any */
import { deserializeFromTransport, serializeForTransport } from '@root/shared/platform/json-serialization'
import { CreatePouFileProps, PouServiceResponse } from '@root/types/IPC/pou-service'
import {
  CreateProjectFileProps,
  IProjectServiceResponse,
  projectDefaultFilesMapSchema,
} from '@root/types/IPC/project-service'
import { IDataToWrite, ISaveDataResponse } from '@root/types/IPC/save-data'
import { DeviceConfiguration, DevicePin } from '@root/types/PLC/devices'
import {
  PLCPou,
  PLCPouSchema,
  PLCProject,
  PLCRemoteDevice,
  PLCRemoteDeviceSchema,
  PLCServer,
  PLCServerSchema,
} from '@root/types/PLC/open-plc'
import { RuntimeLogEntry } from '@root/types/PLC/runtime-logs'
import { getDefaultSchemaValues } from '@root/utils/default-zod-schema-values'
import { getExtensionFromLanguage } from '@root/utils/PLC/pou-file-extensions'
import {
  detectLanguageFromExtension,
  parseGraphicalPouFromString,
  parseHybridPouFromString,
  parseTextualPouFromString,
} from '@root/utils/PLC/pou-text-parser'
import { serializePouToText } from '@root/utils/PLC/pou-text-serializer'
import JSZip from 'jszip'

import type { ProjectState } from '../renderer/store/slices/project/types'

type BridgeCallback = (_event: unknown, ...args: any[]) => void

// Same-origin API calls; webpack dev server proxies /api to the backend.
const API_BASE = ''
const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/ws`

const eventListeners = new Map<string, Set<BridgeCallback>>()
let ws: WebSocket | null = null
let wsReconnectTimer: number | null = null

type BrowserFileSystemDirectoryHandle = {
  name: string
  kind: 'directory'
  entries(): AsyncIterableIterator<[string, BrowserFileSystemHandle]>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileSystemDirectoryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileSystemFileHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
}

type BrowserFileSystemFileHandle = {
  name: string
  kind: 'file'
  getFile(): Promise<File>
  createWritable(): Promise<{
    write(data: string): Promise<void>
    close(): Promise<void>
  }>
}

type BrowserFileSystemHandle = BrowserFileSystemDirectoryHandle | BrowserFileSystemFileHandle

type BrowserWindow = Window & {
  showDirectoryPicker?: (options?: {
    id?: string
    mode?: 'read' | 'readwrite'
  }) => Promise<BrowserFileSystemDirectoryHandle>
}

const browserProjectDirectories = new Map<string, BrowserFileSystemDirectoryHandle>()
const browserProjectFileSelections = new Map<string, File[]>()
let browserProjectId = 0

const isBrowserProjectPath = (path: string): boolean => path.startsWith('browser-fs://')
const isBrowserUploadProjectPath = (path: string): boolean => path.startsWith('browser-upload://')
const isBrowserDownloadProjectPath = (path: string): boolean => path.startsWith('browser-download://')

const unsupportedBrowserFsResponse = {
  success: false,
  error: {
    title: 'Browser filesystem is not supported',
    description: 'Use a browser that supports local directory access, such as Chrome or Edge.',
    error: null,
  },
}

const normalizeBrowserRelativePath = (path: string): string => path.replaceAll('\\', '/').replace(/^\/+/, '')

const getBrowserProjectRoot = (path: string): { rootPath: string; relativePath: string } | null => {
  if (!isBrowserProjectPath(path)) return null
  const withoutScheme = path.slice('browser-fs://'.length)
  const [rootId, ...relativeParts] = withoutScheme.split('/')
  const rootPath = `browser-fs://${rootId}`
  return {
    rootPath,
    relativePath: normalizeBrowserRelativePath(relativeParts.join('/')),
  }
}

const getBrowserProjectDirectory = (path: string): BrowserFileSystemDirectoryHandle | null => {
  const root = getBrowserProjectRoot(path)
  return root ? browserProjectDirectories.get(root.rootPath) ?? null : null
}

const createBrowserProjectPath = (directoryName: string): string => {
  browserProjectId += 1
  return `browser-fs://${encodeURIComponent(directoryName)}-${browserProjectId}`
}

const createBrowserUploadProjectPath = (directoryName: string): string => {
  browserProjectId += 1
  return `browser-upload://${encodeURIComponent(directoryName)}-${browserProjectId}`
}

const createBrowserDownloadProjectPath = (): string => {
  browserProjectId += 1
  return `browser-download://new-project-${browserProjectId}`
}

const getDirectoryHandleByPath = async (
  rootHandle: BrowserFileSystemDirectoryHandle,
  relativePath: string,
  create = false,
): Promise<BrowserFileSystemDirectoryHandle> => {
  const parts = normalizeBrowserRelativePath(relativePath).split('/').filter(Boolean)
  let current = rootHandle
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create })
  }
  return current
}

const getFileHandleByPath = async (
  rootHandle: BrowserFileSystemDirectoryHandle,
  relativePath: string,
  create = false,
): Promise<BrowserFileSystemFileHandle> => {
  const normalizedPath = normalizeBrowserRelativePath(relativePath)
  const parts = normalizedPath.split('/').filter(Boolean)
  const fileName = parts.pop()
  if (!fileName) throw new Error('File path is empty')
  const directory = await getDirectoryHandleByPath(rootHandle, parts.join('/'), create)
  return directory.getFileHandle(fileName, { create })
}

const writeBrowserFile = async (
  rootHandle: BrowserFileSystemDirectoryHandle,
  relativePath: string,
  content: string,
): Promise<void> => {
  const fileHandle = await getFileHandleByPath(rootHandle, relativePath, true)
  const writable = await fileHandle.createWritable()
  await writable.write(content)
  await writable.close()
}

const readBrowserFileText = async (
  rootHandle: BrowserFileSystemDirectoryHandle,
  relativePath: string,
): Promise<string> => {
  const fileHandle = await getFileHandleByPath(rootHandle, relativePath)
  return (await fileHandle.getFile()).text()
}

const browserDirectoryIsEmpty = async (directoryHandle: BrowserFileSystemDirectoryHandle): Promise<boolean> => {
  for await (const _entry of directoryHandle.entries()) {
    return false
  }
  return true
}

const safeReadBrowserJson = async <T>(
  rootHandle: BrowserFileSystemDirectoryHandle,
  relativePath: string,
  fallback: T,
): Promise<T> => {
  try {
    return JSON.parse(await readBrowserFileText(rootHandle, relativePath)) as T
  } catch {
    await writeBrowserFile(rootHandle, relativePath, JSON.stringify(fallback, null, 2))
    return fallback
  }
}

const defineBrowserPou = (language: CreateProjectFileProps['language']): PLCPou => ({
  type: 'program',
  data: {
    name: 'main',
    language,
    variables: [],
    documentation: '',
    body:
      language === 'ld'
        ? { language, value: { name: 'main', rungs: [] } }
        : language === 'fbd'
          ? {
              language,
              value: {
                name: 'main',
                rung: {
                  comment: '',
                  edges: [],
                  nodes: [],
                },
              },
            }
          : { language, value: '' },
  },
})

const createBrowserProjectFile = (data: CreateProjectFileProps): PLCProject => ({
  meta: {
    name: data.name,
    type: data.type,
  },
  data: {
    pous: [],
    dataTypes: [],
    configuration: {
      resource: {
        tasks: [
          {
            name: 'task0',
            triggering: 'Cyclic',
            interval: data.time,
            priority: 1,
          },
        ],
        instances: [
          {
            name: 'instance0',
            program: 'main',
            task: 'task0',
          },
        ],
        globalVariables: [],
      },
    },
  },
})

const detectBrowserPouTypeFromPath = (path: string): PLCPou['type'] => {
  const normalized = normalizeBrowserRelativePath(path)
  if (normalized.includes('/function-blocks/')) return 'function-block'
  if (normalized.includes('/functions/')) return 'function'
  if (normalized.includes('/programs/')) return 'program'
  throw new Error(`Cannot determine POU type from path: ${path}`)
}

const parseBrowserPouFile = (relativePath: string, content: string): PLCPou | null => {
  const extension = relativePath.slice(relativePath.lastIndexOf('.'))

  try {
    if (extension === '.json') {
      const result = PLCPouSchema.safeParse(JSON.parse(content))
      return result.success ? result.data : null
    }

    const pouType = detectBrowserPouTypeFromPath(relativePath)
    const language = detectLanguageFromExtension(relativePath)
    const pou =
      language === 'st' || language === 'il'
        ? parseTextualPouFromString(content, language, pouType)
        : language === 'python' || language === 'cpp'
          ? parseHybridPouFromString(content, language, pouType)
          : language === 'ld' || language === 'fbd'
            ? parseGraphicalPouFromString(content, language, pouType)
            : null

    if (!pou) return null
    const result = PLCPouSchema.safeParse(pou)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

const readBrowserPous = async (
  directoryHandle: BrowserFileSystemDirectoryHandle,
  basePath = '',
): Promise<Array<{ path: string; pou: PLCPou }>> => {
  const pous: Array<{ path: string; pou: PLCPou }> = []
  for await (const [name, handle] of directoryHandle.entries()) {
    const relativePath = normalizeBrowserRelativePath(`${basePath}/${name}`)
    if (handle.kind === 'directory') {
      pous.push(...(await readBrowserPous(handle, relativePath)))
      continue
    }

    if (!['.st', '.il', '.ld', '.fbd', '.py', '.cpp', '.json'].some((ext) => name.endsWith(ext))) {
      continue
    }

    const content = await (await handle.getFile()).text()
    const pou = parseBrowserPouFile(relativePath, content)
    if (pou) {
      pous.push({ path: relativePath, pou })
    }
  }
  return pous
}

const readBrowserJsonDirectory = async <T>(
  rootHandle: BrowserFileSystemDirectoryHandle,
  relativePath: string,
  schema: { safeParse: (data: unknown) => { success: boolean; data?: T } },
): Promise<T[]> => {
  try {
    const directory = await getDirectoryHandleByPath(rootHandle, relativePath)
    const values: T[] = []
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.json')) continue
      try {
        const result = schema.safeParse(JSON.parse(await (await handle.getFile()).text()))
        if (result.success && result.data) values.push(result.data)
      } catch {
        // Skip invalid files, matching the server-side project reader.
      }
    }
    return values
  } catch {
    return []
  }
}

const getFileRelativePath = (file: File): string => {
  const fileWithRelativePath = file as File & { webkitRelativePath?: string }
  return normalizeBrowserRelativePath(fileWithRelativePath.webkitRelativePath || file.name)
}

const stripSelectedDirectoryName = (path: string): string => {
  const parts = normalizeBrowserRelativePath(path).split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(1).join('/') : parts.join('/')
}

const pickBrowserProjectFiles = async (): Promise<{ path: string; files: File[] } | null> =>
  new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    input.setAttribute('webkitdirectory', '')
    input.setAttribute('directory', '')

    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      input.remove()

      if (files.length === 0) {
        resolve(null)
        return
      }

      const firstRelativePath = getFileRelativePath(files[0])
      const directoryName = firstRelativePath.split('/').filter(Boolean)[0] || 'project'
      const path = createBrowserUploadProjectPath(directoryName)
      browserProjectFileSelections.set(path, files)
      resolve({ path, files })
    }

    input.onerror = () => {
      input.remove()
      reject(new Error('Unable to open directory picker'))
    }

    document.body.appendChild(input)
    input.click()
  })

const readUploadedTextFile = async (filesByPath: Map<string, File>, relativePath: string): Promise<string> => {
  const file = filesByPath.get(normalizeBrowserRelativePath(relativePath))
  if (!file) throw new Error(`${relativePath} was not found in the selected directory`)
  return file.text()
}

const safeReadUploadedJson = async <T>(
  filesByPath: Map<string, File>,
  relativePath: string,
  fallback: T,
): Promise<T> => {
  try {
    return JSON.parse(await readUploadedTextFile(filesByPath, relativePath)) as T
  } catch {
    return fallback
  }
}

const readUploadedJsonDirectory = async <T>(
  filesByPath: Map<string, File>,
  relativeDirectory: string,
  schema: { safeParse: (data: unknown) => { success: boolean; data?: T } },
): Promise<T[]> => {
  const values: T[] = []
  const normalizedDirectory = normalizeBrowserRelativePath(relativeDirectory)

  for (const [relativePath, file] of filesByPath) {
    if (!relativePath.startsWith(`${normalizedDirectory}/`) || !relativePath.endsWith('.json')) continue

    try {
      const result = schema.safeParse(JSON.parse(await file.text()))
      if (result.success && result.data) values.push(result.data)
    } catch {
      // Skip invalid files, matching the server-side project reader.
    }
  }

  return values
}

const readUploadedProject = async (rootPath: string, files: File[]): Promise<IProjectServiceResponse> => {
  const filesByPath = new Map<string, File>()
  for (const file of files) {
    filesByPath.set(stripSelectedDirectoryName(getFileRelativePath(file)), file)
  }

  if (!filesByPath.has('project.json')) {
    return {
      success: false,
      error: {
        title: 'Invalid project directory',
        description: 'project.json was not found in the selected directory.',
        error: null,
      },
    }
  }

  const project = await safeReadUploadedJson<PLCProject>(
    filesByPath,
    'project.json',
    getDefaultSchemaValues(projectDefaultFilesMapSchema['project.json']) as PLCProject,
  )
  const deviceConfiguration = await safeReadUploadedJson<DeviceConfiguration>(
    filesByPath,
    'devices/configuration.json',
    getDefaultSchemaValues(projectDefaultFilesMapSchema['devices/configuration.json']) as DeviceConfiguration,
  )
  deviceConfiguration.communicationConfiguration.modbusRTU.rtuBaudRate ||= '115200'
  const devicePinMapping = await safeReadUploadedJson<DevicePin[]>(
    filesByPath,
    'devices/pin-mapping.json',
    getDefaultSchemaValues(projectDefaultFilesMapSchema['devices/pin-mapping.json']) as DevicePin[],
  )

  const seenPous = new Set<string>()
  const pous: PLCPou[] = []
  for (const [relativePath, file] of [...filesByPath].sort(([a], [b]) => {
    const aIsJson = a.endsWith('.json')
    const bIsJson = b.endsWith('.json')
    return aIsJson === bIsJson ? 0 : aIsJson ? 1 : -1
  })) {
    if (!relativePath.startsWith('pous/')) continue
    if (!['.st', '.il', '.ld', '.fbd', '.py', '.cpp', '.json'].some((ext) => relativePath.endsWith(ext))) continue

    const pou = parseBrowserPouFile(relativePath, await file.text())
    if (!pou) continue

    const key = `${pou.type}:${pou.data.name}`
    if (seenPous.has(key)) continue
    seenPous.add(key)
    pous.push(pou)
  }

  const servers = await readUploadedJsonDirectory<PLCServer>(filesByPath, 'devices/servers', PLCServerSchema)
  const remoteDevices = await readUploadedJsonDirectory<PLCRemoteDevice>(
    filesByPath,
    'devices/remote',
    PLCRemoteDeviceSchema,
  )

  return {
    success: true,
    data: {
      meta: { path: rootPath },
      content: {
        project,
        pous,
        deviceConfiguration,
        devicePinMapping,
        servers,
        remoteDevices,
      },
    },
  }
}

const readBrowserProject = async (
  rootPath: string,
  rootHandle: BrowserFileSystemDirectoryHandle,
): Promise<IProjectServiceResponse> => {
  try {
    await rootHandle.getFileHandle('project.json')
  } catch {
    return {
      success: false,
      error: {
        title: 'Invalid project directory',
        description: 'project.json was not found in the selected directory.',
        error: null,
      },
    }
  }

  const project = await safeReadBrowserJson<PLCProject>(
    rootHandle,
    'project.json',
    getDefaultSchemaValues(projectDefaultFilesMapSchema['project.json']) as PLCProject,
  )
  const deviceConfiguration = await safeReadBrowserJson<DeviceConfiguration>(
    rootHandle,
    'devices/configuration.json',
    getDefaultSchemaValues(projectDefaultFilesMapSchema['devices/configuration.json']) as DeviceConfiguration,
  )
  deviceConfiguration.communicationConfiguration.modbusRTU.rtuBaudRate ||= '115200'
  const devicePinMapping = await safeReadBrowserJson<DevicePin[]>(
    rootHandle,
    'devices/pin-mapping.json',
    getDefaultSchemaValues(projectDefaultFilesMapSchema['devices/pin-mapping.json']) as DevicePin[],
  )

  let pous: PLCPou[] = []
  try {
    const pouDirectory = await rootHandle.getDirectoryHandle('pous')
    const pouFiles = await readBrowserPous(pouDirectory, 'pous')
    const seen = new Set<string>()
    pous = pouFiles
      .sort((a, b) => (a.path.endsWith('.json') === b.path.endsWith('.json') ? 0 : a.path.endsWith('.json') ? 1 : -1))
      .filter(({ pou }) => {
        const key = `${pou.type}:${pou.data.name}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map(({ pou }) => pou)
  } catch {
    pous = []
  }

  const servers = await readBrowserJsonDirectory<PLCServer>(rootHandle, 'devices/servers', PLCServerSchema)
  const remoteDevices = await readBrowserJsonDirectory<PLCRemoteDevice>(
    rootHandle,
    'devices/remote',
    PLCRemoteDeviceSchema,
  )

  return {
    success: true,
    data: {
      meta: { path: rootPath },
      content: {
        project,
        pous,
        deviceConfiguration,
        devicePinMapping,
        servers,
        remoteDevices,
      },
    },
  }
}

const pickBrowserProjectDirectory = async (mode: 'read' | 'readwrite') => {
  const picker = (window as BrowserWindow).showDirectoryPicker
  if (!picker) return null
  const handle = await picker({ id: 'openplc-project', mode })
  const path = createBrowserProjectPath(handle.name)
  browserProjectDirectories.set(path, handle)
  return { path, handle }
}

const createBrowserProject = async (data: CreateProjectFileProps): Promise<IProjectServiceResponse> => {
  const rootHandle = getBrowserProjectDirectory(data.path)
  if (!rootHandle && !isBrowserDownloadProjectPath(data.path)) return invoke('project:create', data)

  const project = createBrowserProjectFile(data)
  const pou = defineBrowserPou(data.language)
  const deviceConfiguration = getDefaultSchemaValues(
    projectDefaultFilesMapSchema['devices/configuration.json'],
  ) as DeviceConfiguration
  deviceConfiguration.communicationConfiguration.modbusRTU.rtuBaudRate = '115200'
  const devicePinMapping = getDefaultSchemaValues(
    projectDefaultFilesMapSchema['devices/pin-mapping.json'],
  ) as DevicePin[]
  const pouExtension = getExtensionFromLanguage(pou.data.body.language)

  if (rootHandle) {
    await getDirectoryHandleByPath(rootHandle, 'devices/servers', true)
    await getDirectoryHandleByPath(rootHandle, 'devices/remote', true)
    await getDirectoryHandleByPath(rootHandle, 'pous/programs', true)
    await getDirectoryHandleByPath(rootHandle, 'pous/functions', true)
    await getDirectoryHandleByPath(rootHandle, 'pous/function-blocks', true)
    await writeBrowserFile(rootHandle, 'project.json', JSON.stringify(project, null, 2))
    await writeBrowserFile(rootHandle, 'devices/configuration.json', JSON.stringify(deviceConfiguration, null, 2))
    await writeBrowserFile(rootHandle, 'devices/pin-mapping.json', JSON.stringify(devicePinMapping, null, 2))
    await writeBrowserFile(rootHandle, `pous/programs/${pou.data.name}${pouExtension}`, serializePouToText(pou))
  }

  return {
    success: true,
    data: {
      meta: { path: data.path },
      content: {
        project,
        pous: [pou],
        deviceConfiguration,
        devicePinMapping,
      },
    },
  }
}

const saveBrowserProject = async ({ projectPath, content }: IDataToWrite): Promise<ISaveDataResponse> => {
  const rootHandle = getBrowserProjectDirectory(projectPath)
  if (!rootHandle) {
    if (isBrowserUploadProjectPath(projectPath) || isBrowserDownloadProjectPath(projectPath)) {
      await downloadProjectZip(projectPath, content)
      return { success: true, message: 'Project downloaded successfully' }
    }
    return invoke('project:save', { projectPath, content })
  }

  await writeBrowserFile(rootHandle, 'project.json', JSON.stringify(content.projectData, null, 2))
  await writeBrowserFile(rootHandle, 'devices/configuration.json', JSON.stringify(content.deviceConfiguration, null, 2))
  await writeBrowserFile(rootHandle, 'devices/pin-mapping.json', JSON.stringify(content.devicePinMapping, null, 2))

  for (const pou of content.pous) {
    const typeDir =
      pou.type === 'function' ? 'functions' : pou.type === 'function-block' ? 'function-blocks' : 'programs'
    const extension = getExtensionFromLanguage(pou.data.body.language)
    await writeBrowserFile(rootHandle, `pous/${typeDir}/${pou.data.name}${extension}`, serializePouToText(pou))
  }

  return { success: true, message: 'Project saved successfully' }
}

const downloadProjectZip = async (projectPath: string, content: IDataToWrite['content']): Promise<void> => {
  const zip = new JSZip()
  const projectName =
    content.projectData.meta.name ||
    projectPath.replace(/^browser-upload:\/\//, '').replace(/^browser-download:\/\//, '') ||
    'openplc-project'

  zip.file('project.json', JSON.stringify(content.projectData, null, 2))
  zip.file('devices/configuration.json', JSON.stringify(content.deviceConfiguration, null, 2))
  zip.file('devices/pin-mapping.json', JSON.stringify(content.devicePinMapping, null, 2))

  for (const pou of content.pous) {
    const typeDir =
      pou.type === 'function' ? 'functions' : pou.type === 'function-block' ? 'function-blocks' : 'programs'
    const extension = getExtensionFromLanguage(pou.data.body.language)
    zip.file(`pous/${typeDir}/${pou.data.name}${extension}`, serializePouToText(pou))
  }

  const blob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${projectName}.zip`
  anchor.click()
  URL.revokeObjectURL(url)
}

const saveBrowserFile = async (filePath: string, content: unknown): Promise<{ success: boolean; error?: string }> => {
  const root = getBrowserProjectRoot(filePath)
  const rootHandle = getBrowserProjectDirectory(filePath)
  if (!root || !rootHandle) {
    if (isBrowserUploadProjectPath(filePath) || isBrowserDownloadProjectPath(filePath)) {
      const isPou = typeof content === 'object' && content !== null && 'type' in content && 'data' in content
      const filename =
        filePath
          .split('/')
          .pop()
          ?.replace(/\.json$/, '') || 'openplc-file'
      const fileContent = isPou ? serializePouToText(content as PLCPou) : JSON.stringify(content, null, 2)
      triggerDownload(filename, fileContent)
      return { success: true }
    }
    return invoke('project:save-file', filePath, content)
  }

  try {
    const isPou = typeof content === 'object' && content !== null && 'type' in content && 'data' in content
    if (isPou) {
      const pou = content as PLCPou
      const path = root.relativePath.endsWith('.json')
        ? root.relativePath.replace(/\.json$/, getExtensionFromLanguage(pou.data.body.language))
        : root.relativePath
      await writeBrowserFile(rootHandle, path, serializePouToText(pou))
    } else {
      await writeBrowserFile(rootHandle, root.relativePath, JSON.stringify(content, null, 2))
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const createBrowserPouFile = async (props: CreatePouFileProps): Promise<PouServiceResponse> => {
  const root = getBrowserProjectRoot(props.path)
  const rootHandle = getBrowserProjectDirectory(props.path)
  if (isBrowserUploadProjectPath(props.path) || isBrowserDownloadProjectPath(props.path)) return { success: true }
  if (!root || !rootHandle) return invoke('pou:create', props)

  try {
    const path = root.relativePath.endsWith('.json')
      ? root.relativePath.replace(/\.json$/, getExtensionFromLanguage(props.pou.data.body.language))
      : root.relativePath
    await writeBrowserFile(rootHandle, path, serializePouToText(props.pou))
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: {
        title: 'Error creating POU file',
        description: error instanceof Error ? error.message : String(error),
        error,
      },
    }
  }
}

const deleteBrowserPouFile = async (filePath: string): Promise<PouServiceResponse> => {
  const root = getBrowserProjectRoot(filePath)
  const rootHandle = getBrowserProjectDirectory(filePath)
  if (isBrowserUploadProjectPath(filePath) || isBrowserDownloadProjectPath(filePath)) return { success: true }
  if (!root || !rootHandle) return invoke('pou:delete', filePath)

  try {
    const normalizedPath = root.relativePath
    const parts = normalizedPath.split('/').filter(Boolean)
    const fileName = parts.pop()
    if (!fileName) throw new Error('File path is empty')
    const directory = await getDirectoryHandleByPath(rootHandle, parts.join('/'))

    if (fileName.endsWith('.json')) {
      const baseName = fileName.slice(0, -'.json'.length)
      for await (const [entryName, handle] of directory.entries()) {
        if (handle.kind === 'file' && entryName.replace(/\.[^.]+$/, '') === baseName) {
          await directory.removeEntry(entryName)
        }
      }
    } else {
      await directory.removeEntry(fileName)
    }

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: {
        title: 'Error deleting POU file',
        description: error instanceof Error ? error.message : String(error),
        error,
      },
    }
  }
}

const renameBrowserPouFile = async (data: {
  filePath: string
  newFileName: string
  fileContent?: unknown
}): Promise<PouServiceResponse> => {
  const root = getBrowserProjectRoot(data.filePath)
  const rootHandle = getBrowserProjectDirectory(data.filePath)
  if (isBrowserUploadProjectPath(data.filePath) || isBrowserDownloadProjectPath(data.filePath)) return { success: true }
  if (!root || !rootHandle) return invoke('pou:rename', data)

  try {
    await deleteBrowserPouFile(data.filePath)
    if (!data.fileContent) return { success: true }

    const pou = data.fileContent as PLCPou
    const parts = root.relativePath.split('/').filter(Boolean)
    parts.pop()
    const baseName = data.newFileName.replace(/\.json$/, '')
    const extension = getExtensionFromLanguage(pou.data.body.language)
    await writeBrowserFile(rootHandle, `${parts.join('/')}/${baseName}${extension}`, serializePouToText(pou))
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: {
        title: 'Error renaming POU file',
        description: error instanceof Error ? error.message : String(error),
        error,
      },
    }
  }
}

const readBrowserFileContent = async (
  filePath: string,
): Promise<{ success: boolean; content?: string; error?: string }> => {
  if (isBrowserDownloadProjectPath(filePath)) {
    return {
      success: false,
      error: 'This project exists in browser memory only. Save the project to download its files.',
    }
  }

  if (isBrowserUploadProjectPath(filePath)) {
    const uploadRoot = filePath.slice('browser-upload://'.length).split('/')[0]
    const rootPath = `browser-upload://${uploadRoot}`
    const relativePath = normalizeBrowserRelativePath(filePath.slice(rootPath.length))
    const files = browserProjectFileSelections.get(rootPath)

    if (!files) {
      return { success: false, error: 'Project files are no longer available. Open the project directory again.' }
    }

    const match = files.find((file) => stripSelectedDirectoryName(getFileRelativePath(file)) === relativePath)
    if (!match) return { success: false, error: `${relativePath} was not found in the selected directory` }
    return { success: true, content: await match.text() }
  }

  const root = getBrowserProjectRoot(filePath)
  const rootHandle = getBrowserProjectDirectory(filePath)
  if (!root || !rootHandle) return invoke('file:read-content', filePath)

  try {
    return { success: true, content: await readBrowserFileText(rootHandle, root.relativePath) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
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

  const handleMessage = (event: MessageEvent) => {
    try {
      const payload = JSON.parse(String(event.data)) as { type: string; data?: unknown }
      if (payload.type === 'compile-message') {
        callback(deserializeFromTransport(payload.data))
      }
    } catch (error) {
      console.error('Failed to parse compile stream message', error)
    }
  }

  const start = () => {
    socket.send(JSON.stringify({ type, args: serializeForTransport(compileArgs) }))
    socket.addEventListener('message', handleMessage)
  }

  if (socket.readyState === WebSocket.OPEN) {
    start()
  } else {
    socket.addEventListener('open', start, { once: true })
  }

  return () => {
    socket.removeEventListener('message', handleMessage)
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
  createProject: (data: CreateProjectFileProps): Promise<IProjectServiceResponse> => createBrowserProject(data),
  createProjectAccelerator: (callback: BridgeCallback) => on('project:create-accelerator', callback),
  deleteFileAccelerator: (callback: BridgeCallback) => on('workspace:delete-file-accelerator', callback),
  findInProjectAccelerator: (callback: BridgeCallback) => on('project:find-in-project-accelerator', callback),
  handleOpenProjectRequest: (callback: BridgeCallback) => on('project:open-project-request', callback),
  openProject: async (): Promise<IProjectServiceResponse> => {
    try {
      const picked = await pickBrowserProjectDirectory('readwrite')
      if (!picked) {
        const selectedFiles = await pickBrowserProjectFiles()
        if (!selectedFiles) {
          return unsupportedBrowserFsResponse
        }
        return readUploadedProject(selectedFiles.path, selectedFiles.files)
      }
      return readBrowserProject(picked.path, picked.handle)
    } catch (error) {
      return {
        success: false,
        error: {
          title: 'Error opening project',
          description: error instanceof Error ? error.message : String(error),
          error,
        },
      }
    }
  },
  openProjectByPath: (projectPath: string): Promise<IProjectServiceResponse> =>
    isBrowserProjectPath(projectPath) ||
    isBrowserUploadProjectPath(projectPath) ||
    isBrowserDownloadProjectPath(projectPath)
      ? Promise.resolve({
          success: false,
          error: {
            title: 'Project directory permission is no longer available',
            description: 'Open the project directory again from this browser.',
            error: null,
          },
        })
      : invoke('project:open-by-path', projectPath),
  openRecentAccelerator: (callback: BridgeCallback) => on('project:open-recent-accelerator', callback),
  pathPicker: async (): Promise<{
    success: boolean
    error?: { title: string; description: string }
    path?: string
  }> => {
    try {
      const picked = await pickBrowserProjectDirectory('readwrite')
      if (!picked) {
        return { success: true, path: createBrowserDownloadProjectPath() }
      }
      if (!(await browserDirectoryIsEmpty(picked.handle))) {
        browserProjectDirectories.delete(picked.path)
        return {
          success: false,
          error: {
            title: 'Directory is not empty',
            description: 'Choose an empty directory for the new project.',
          },
        }
      }
      return { success: true, path: picked.path }
    } catch (error) {
      return {
        success: false,
        error: {
          title: 'Error selecting directory',
          description: error instanceof Error ? error.message : String(error),
        },
      }
    }
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
    saveBrowserFile(filePath, content),
  saveFileAccelerator: (callback: BridgeCallback) => on('project:save-file-accelerator', callback),
  saveProject: (dataToWrite: IDataToWrite): Promise<ISaveDataResponse> => saveBrowserProject(dataToWrite),
  saveProjectAccelerator: (callback: BridgeCallback) => on('project:save-accelerator', callback),
  switchPerspective: (callback: BridgeCallback) => on('workspace:switch-perspective-accelerator', callback),

  createPouFile: (props: CreatePouFileProps): Promise<PouServiceResponse> => createBrowserPouFile(props),
  deletePouFile: (filePath: string): Promise<PouServiceResponse> => deleteBrowserPouFile(filePath),
  renamePouFile: (data: {
    filePath: string
    newFileName: string
    fileContent?: unknown
  }): Promise<PouServiceResponse> => renameBrowserPouFile(data),

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
    isBrowserProjectPath(filePath) || isBrowserUploadProjectPath(filePath) || isBrowserDownloadProjectPath(filePath)
      ? Promise.resolve({ success: true })
      : invoke('file:watch-start', filePath),
  fileWatchStop: (filePath: string): Promise<{ success: boolean }> =>
    isBrowserProjectPath(filePath) || isBrowserUploadProjectPath(filePath) || isBrowserDownloadProjectPath(filePath)
      ? Promise.resolve({ success: true })
      : invoke('file:watch-stop', filePath),
  fileWatchStopAll: (): Promise<{ success: boolean }> => invoke('file:watch-stop-all'),
  fileReadContent: (filePath: string): Promise<{ success: boolean; content?: string; error?: string }> =>
    readBrowserFileContent(filePath),
  onFileExternalChange: (callback: (_event: unknown, data: { filePath: string }) => void) => {
    on('file:external-change', callback)
    return () => removeAllListeners('file:external-change')
  },
}

export type PlatformBridge = typeof webBridge

export default webBridge
