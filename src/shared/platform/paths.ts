import { homedir } from 'os'
import { join } from 'path'

const APP_NAME = 'open-plc-editor'

export function getUserDataPath(): string {
  const home = homedir()

  switch (process.platform) {
    case 'win32':
      return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), APP_NAME)
    case 'darwin':
      return join(home, 'Library', 'Application Support', APP_NAME)
    default:
      return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), APP_NAME)
  }
}

export function getResourcesPath(): string {
  return process.env.NODE_ENV === 'development' ? join(process.cwd(), 'resources') : join(process.cwd(), 'resources')
}
