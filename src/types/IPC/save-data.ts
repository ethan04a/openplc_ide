import { DeviceConfiguration, DevicePin } from '@root/types/PLC/devices'

import { ProjectState } from '../../renderer/store/slices/project/types'
import { PLCPou, PLCProject } from '../PLC/open-plc'

export type IDataToWrite = {
  projectPath: string
  content: {
    projectData: PLCProject
    pous: PLCPou[]
    deviceConfiguration: DeviceConfiguration
    devicePinMapping: DevicePin[]
    servers?: ProjectState['data']['servers']
    remoteDevices?: ProjectState['data']['remoteDevices']
  }
}

export type ISaveDataResponse = {
  success: boolean
  reason: {
    title: string
    description: string
  }
}
