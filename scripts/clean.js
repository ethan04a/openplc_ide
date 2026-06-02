import fs from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { rimrafSync } from 'rimraf'

const rootPath = join(dirname(fileURLToPath(import.meta.url)), '..')
const foldersToRemove = [join(rootPath, 'release', 'app', 'dist'), join(rootPath, 'dist')]

foldersToRemove.forEach((folder) => {
  if (fs.existsSync(folder)) rimrafSync(folder)
})
