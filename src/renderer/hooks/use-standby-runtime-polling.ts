import { useOpenPLCStore } from '@root/renderer/store'
import type { RuntimeConnection, TimingStats } from '@root/renderer/store/slices/device/types'
import { isV4Logs, LOG_BUFFER_CAP } from '@root/types/PLC/runtime-logs'
import { useCallback, useEffect, useRef } from 'react'

const POLL_INTERVAL_MS = 2000
const MAX_CONSECUTIVE_FAILURES = 5

/**
 * Polls standby runtime status and logs into standbyRuntimeConnection (independent from master).
 */
export const useStandbyRuntimePolling = () => {
  const connectionStatus = useOpenPLCStore((state) => state.standbyRuntimeConnection.connectionStatus)
  const jwtToken = useOpenPLCStore((state) => state.standbyRuntimeConnection.jwtToken)
  const standbyIpAddress = useOpenPLCStore((state) => state.standbyRuntimeConnection.ipAddress)
  const setStandbyPlcRuntimeStatus = useOpenPLCStore((state) => state.deviceActions.setStandbyPlcRuntimeStatus)
  const setStandbyRuntimeJwtToken = useOpenPLCStore((state) => state.deviceActions.setStandbyRuntimeJwtToken)
  const setStandbyRuntimeConnectionStatus = useOpenPLCStore(
    (state) => state.deviceActions.setStandbyRuntimeConnectionStatus,
  )
  const setStandbyTimingStats = useOpenPLCStore(
    (state): ((stats: TimingStats | null) => void) => state.deviceActions.setStandbyTimingStats,
  )
  const setStandbyNodeInfo = useOpenPLCStore((state) => state.deviceActions.setStandbyNodeInfo)
  const clearStandbyPlcLogs = useOpenPLCStore((state) => state.deviceActions.clearStandbyPlcLogs)

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const consecutiveFailuresRef = useRef<number>(0)
  const isPollingRef = useRef(false)

  const clearConnectionState = useCallback(() => {
    consecutiveFailuresRef.current = 0
    setStandbyRuntimeJwtToken(null)
    setStandbyRuntimeConnectionStatus('disconnected')
    setStandbyPlcRuntimeStatus(null)
    setStandbyTimingStats(null)
    setStandbyNodeInfo(null)
    clearStandbyPlcLogs()
  }, [
    clearStandbyPlcLogs,
    setStandbyPlcRuntimeStatus,
    setStandbyRuntimeConnectionStatus,
    setStandbyRuntimeJwtToken,
    setStandbyTimingStats,
    setStandbyNodeInfo,
  ])

  const poll = useCallback(async () => {
    if (isPollingRef.current) return

    const currentState = useOpenPLCStore.getState()
    const {
      runtimeConnection: { includeTimingStatsInPolling },
      standbyRuntimeConnection: {
        connectionStatus: currentConnectionStatus,
        jwtToken: currentJwtToken,
        ipAddress: currentIpAddress,
        plcLogsLastId,
      },
      deviceActions,
    } = currentState

    if (currentConnectionStatus !== 'connected' || !currentJwtToken || !currentIpAddress) {
      return
    }

    isPollingRef.current = true

    const handlePollFailure = () => {
      consecutiveFailuresRef.current += 1
      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
        }
        clearConnectionState()
      } else {
        setStandbyPlcRuntimeStatus('UNKNOWN')
      }
    }

    try {
      // Standby logs are always v4 structured entries (never v3 string format).
      const minId = plcLogsLastId !== null ? plcLogsLastId + 1 : undefined

      const [statusResult, logsResult, nodeInfoResult] = await Promise.all([
        window.bridge.runtimeGetStatus(currentIpAddress, currentJwtToken, includeTimingStatsInPolling),
        window.bridge.runtimeGetLogs(currentIpAddress, currentJwtToken, minId),
        window.bridge.runtimeGetNodeInfo(currentIpAddress, currentJwtToken, 'system,network'),
      ])

      if (statusResult.success && statusResult.status) {
        consecutiveFailuresRef.current = 0
        const statusValue = statusResult.status.replace('STATUS:', '').replace('\n', '').trim()
        const validStatuses = ['INIT', 'RUNNING', 'STOPPED', 'ERROR', 'EMPTY', 'UNKNOWN'] as const
        if (validStatuses.includes(statusValue as (typeof validStatuses)[number])) {
          setStandbyPlcRuntimeStatus(statusValue as NonNullable<RuntimeConnection['plcStatus']>)
        } else {
          setStandbyPlcRuntimeStatus('UNKNOWN')
        }
        if (includeTimingStatsInPolling && statusResult.timingStats) {
          setStandbyTimingStats(statusResult.timingStats)
        } else if (!includeTimingStatsInPolling) {
          setStandbyTimingStats(null)
        }
      } else {
        handlePollFailure()
        return
      }

      if (nodeInfoResult.success && nodeInfoResult.nodeInfo) {
        setStandbyNodeInfo(nodeInfoResult.nodeInfo)
      }

      if (logsResult.success && logsResult.logs !== undefined) {
        const newLogs = logsResult.logs

        if (isV4Logs(newLogs)) {
          if (newLogs.length > 0) {
            const hasRestartedRuntime =
              plcLogsLastId !== null && newLogs.some((log) => log.id !== null && log.id < plcLogsLastId)

            if (hasRestartedRuntime) {
              const cappedLogs = newLogs.length > LOG_BUFFER_CAP ? newLogs.slice(-LOG_BUFFER_CAP) : newLogs
              deviceActions.setStandbyPlcLogs(cappedLogs)
            } else {
              deviceActions.appendStandbyPlcLogs(newLogs)
            }

            const maxId = newLogs.reduce((max, log) => {
              if (log.id !== null && log.id > max) {
                return log.id
              }
              return max
            }, plcLogsLastId ?? -1)

            if (maxId >= 0) {
              deviceActions.setStandbyPlcLogsLastId(maxId)
            }
          }
        }
      }
    } catch {
      handlePollFailure()
    } finally {
      isPollingRef.current = false
    }
  }, [clearConnectionState, setStandbyPlcRuntimeStatus, setStandbyNodeInfo, setStandbyTimingStats])

  useEffect(() => {
    if (connectionStatus === 'connected' && jwtToken && standbyIpAddress) {
      consecutiveFailuresRef.current = 0
      void poll()
      pollIntervalRef.current = setInterval(() => {
        void poll()
      }, POLL_INTERVAL_MS)
    } else if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [connectionStatus, jwtToken, standbyIpAddress, poll])

  return {
    isConnected: connectionStatus === 'connected',
    plcStatus: useOpenPLCStore((state) => state.standbyRuntimeConnection.plcStatus),
  }
}
