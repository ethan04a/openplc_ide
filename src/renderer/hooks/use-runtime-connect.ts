import { useOpenPLCStore } from '@root/renderer/store'
import type {
  RuntimeConnectionModalData,
  RuntimeConnectionTarget,
} from '@root/renderer/store/slices/device/runtime-connection-target'
import type { TimingStats } from '@root/renderer/store/slices/device/types'
import { validateRuntimeVersion } from '@root/utils'
import { useCallback } from 'react'

type UseRuntimeConnectOptions = {
  target: RuntimeConnectionTarget
  deviceBoard: string
}

const useRuntimeConnect = ({ target, deviceBoard }: UseRuntimeConnectOptions) => {
  const isStandby = target === 'standby'

  const ipAddress = useOpenPLCStore((state) =>
    isStandby
      ? state.deviceDefinitions.configuration.standbyRuntimeIpAddress || ''
      : state.deviceDefinitions.configuration.runtimeIpAddress || '',
  )
  const connectionStatus = useOpenPLCStore((state) =>
    isStandby ? state.standbyRuntimeConnection.connectionStatus : state.runtimeConnection.connectionStatus,
  )
  const plcStatus = useOpenPLCStore((state) =>
    isStandby ? state.standbyRuntimeConnection.plcStatus : state.runtimeConnection.plcStatus,
  )

  const setIpAddress = useOpenPLCStore((state) =>
    isStandby ? state.deviceActions.setStandbyRuntimeIpAddress : state.deviceActions.setRuntimeIpAddress,
  )
  const setJwtToken = useOpenPLCStore((state) =>
    isStandby ? state.deviceActions.setStandbyRuntimeJwtToken : state.deviceActions.setRuntimeJwtToken,
  )
  const setConnectionStatus = useOpenPLCStore((state) =>
    isStandby ? state.deviceActions.setStandbyRuntimeConnectionStatus : state.deviceActions.setRuntimeConnectionStatus,
  )
  const clearStandbyPlcLogs = useOpenPLCStore((state) => state.deviceActions.clearStandbyPlcLogs)
  const setStandbyTimingStats = useOpenPLCStore(
    (state): ((stats: TimingStats | null) => void) => state.deviceActions.setStandbyTimingStats,
  )
  const setRuntimeNodeInfo = useOpenPLCStore((state) => state.deviceActions.setRuntimeNodeInfo)
  const setStandbyNodeInfo = useOpenPLCStore((state) => state.deviceActions.setStandbyNodeInfo)
  const openModal = useOpenPLCStore((state) => state.modalActions.openModal)

  const handleConnect = useCallback(async () => {
    if (connectionStatus === 'connected') {
      setJwtToken(null)
      setConnectionStatus('disconnected')
      if (isStandby) {
        clearStandbyPlcLogs()
        setStandbyTimingStats(null)
        setStandbyNodeInfo(null)
      } else {
        setRuntimeNodeInfo(null)
      }
      const clearCreds = window.bridge.runtimeClearCredentials as (() => Promise<{ success: boolean }>) | undefined
      if (!isStandby) {
        await clearCreds?.()
      }
      return
    }

    if (!ipAddress) {
      return
    }

    setConnectionStatus('connecting')

    const modalData: RuntimeConnectionModalData = { connectionTarget: target }

    try {
      const result = await window.bridge.runtimeGetUsersInfo(ipAddress)

      if (result.error) {
        setConnectionStatus('error')
        return
      }

      const proceedWithConnection = () => {
        if (result.hasUsers) {
          openModal('runtime-login', modalData)
        } else {
          openModal('runtime-create-user', modalData)
        }
      }

      const versionValidation = validateRuntimeVersion(deviceBoard, result.runtimeVersion)

      if (versionValidation.status === 'mismatch') {
        setConnectionStatus('error')
        openModal('debugger-message', {
          type: 'error',
          title: 'Runtime Version Mismatch',
          message: versionValidation.message || 'Unknown version mismatch error',
          buttons: ['OK'],
          onResponse: () => undefined,
        })
        return
      }

      if (versionValidation.status === 'missing') {
        openModal('debugger-message', {
          type: 'warning',
          title: 'Older Runtime Detected',
          message: versionValidation.message || 'Could not detect runtime version.',
          buttons: ['Continue Anyway', 'Cancel'],
          onResponse: (buttonIndex: number) => {
            if (buttonIndex === 0) {
              proceedWithConnection()
            } else {
              setConnectionStatus('disconnected')
            }
          },
        })
        return
      }

      proceedWithConnection()
    } catch (_error) {
      setConnectionStatus('error')
    }
  }, [
    clearStandbyPlcLogs,
    setRuntimeNodeInfo,
    setStandbyNodeInfo,
    setStandbyTimingStats,
    connectionStatus,
    deviceBoard,
    ipAddress,
    isStandby,
    openModal,
    setConnectionStatus,
    setJwtToken,
    target,
  ])

  return {
    ipAddress,
    connectionStatus,
    plcStatus,
    setIpAddress,
    handleConnect,
  }
}

export { useRuntimeConnect }
