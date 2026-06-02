import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

type PickFolderOptions = {
  title: string
  createDirectory?: boolean
}

const pickFolderWindows = async ({ title, createDirectory = false }: PickFolderOptions): Promise<string | null> => {
  const escapedTitle = title.replace(/"/g, '`"')
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = "${escapedTitle}"`,
    `$dialog.ShowNewFolderButton = $${createDirectory ? 'true' : 'false'}`,
    '$result = $dialog.ShowDialog()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
  ].join('\n')

  const scriptPath = join(tmpdir(), `openplc-folder-picker-${randomUUID()}.ps1`)
  await writeFile(scriptPath, script, 'utf-8')

  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { encoding: 'utf8' },
    )
    const selectedPath = stdout.trim()
    return selectedPath.length > 0 ? selectedPath : null
  } finally {
    await unlink(scriptPath).catch(() => undefined)
  }
}

const pickFolderDarwin = async ({ title }: PickFolderOptions): Promise<string | null> => {
  const escapedTitle = title.replace(/"/g, '\\"')
  const script = `POSIX path of (choose folder with prompt "${escapedTitle}")`
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { encoding: 'utf8' })
    const selectedPath = stdout.trim()
    return selectedPath.length > 0 ? selectedPath : null
  } catch {
    return null
  }
}

const pickFolderLinux = async ({ title }: PickFolderOptions): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory', `--title=${title}`], {
      encoding: 'utf8',
    })
    const selectedPath = stdout.trim()
    return selectedPath.length > 0 ? selectedPath : null
  } catch {
    return null
  }
}

export async function pickNativeFolder(options: PickFolderOptions): Promise<string | null> {
  switch (process.platform) {
    case 'win32':
      return pickFolderWindows(options)
    case 'darwin':
      return pickFolderDarwin(options)
    default:
      return pickFolderLinux(options)
  }
}
