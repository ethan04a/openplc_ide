import { join } from 'path'

const rootPath = join(__dirname, '../..')

const srcPath = join(rootPath, 'src')
const srcMainPath = join(srcPath, 'main')
const srcRendererPath = join(srcPath, 'renderer')

const releasePath = join(rootPath, 'release')
const appPath = join(releasePath, 'app')
const distPath = join(appPath, 'dist')
const distRendererPath = join(distPath, 'renderer')

const typesPath = join(srcPath, 'types')

export default {
  rootPath,
  srcPath,
  srcMainPath,
  srcRendererPath,
  releasePath,
  appPath,
  distPath,
  distRendererPath,
  typesPath,
}
