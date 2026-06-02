import { i18n } from '../../utils/i18n'
import { isEmptyDir } from './is-empty-dir'
import { pickNativeFolder } from './native-folder-picker'

const getProjectPath = async () => {
  const selectedPath = await pickNativeFolder({
    title: i18n.t('createProject:dialog.title'),
    createDirectory: true,
  })

  if (!selectedPath) {
    return {
      success: false,
      error: {
        title: i18n.t('projectServiceResponses:createProject.errors.canceled.title'),
        description: i18n.t('projectServiceResponses:createProject.errors.canceled.description'),
      },
    }
  }

  if (!(await isEmptyDir(selectedPath))) {
    return {
      success: false,
      error: {
        title: i18n.t('projectServiceResponses:createProject.errors.directoryNotEmpty.title'),
        description: i18n.t('projectServiceResponses:createProject.errors.directoryNotEmpty.description'),
      },
    }
  }

  return {
    success: true,
    path: selectedPath,
  }
}

export { getProjectPath }
