import { getUserDataPath } from '@root/shared/platform/paths'
import { join } from 'path'

const logPath = join(getUserDataPath(), 'logs')

export { logPath }
