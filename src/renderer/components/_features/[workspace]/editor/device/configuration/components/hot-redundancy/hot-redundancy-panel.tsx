import { RefreshIcon } from '@root/renderer/assets'
import { PlcLogsCompact } from '@root/renderer/components/_organisms/plc-logs/plc-logs-compact'
import { useOpenPLCStore } from '@root/renderer/store'
import type { TimingStats } from '@root/renderer/store/slices/device/types'
import {
  mapRuntimeNodeInfoToNetworkDisplay,
  mapRuntimeNodeInfoToSystemDisplay,
  type RuntimeNodeInfoDisplayNetwork,
  type RuntimeNodeInfoDisplaySystem,
} from '@root/types/PLC/runtime-node-info'
import { cn } from '@root/utils'
import type { ReactNode } from 'react'
import { useCallback, useMemo, useState } from 'react'

import { ScanCycleStats } from '../scan-cycle-stats'
import {
  type HotRedundancyLinkMessages,
  type HotRedundancyMockData,
  MOCK_HOT_REDUNDANCY_DATA,
  type NodeRedundancyStatus,
  type NodeStatusIndicator,
} from './mock-data'

type HotRedundancyPanelProps = {
  timingStats: TimingStats | null
  data?: HotRedundancyMockData
}

const statusDotClassName: Record<NodeStatusIndicator, string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-400',
  error: 'bg-red-500',
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className='flex gap-2 text-xs'>
    <dt className='shrink-0 text-neutral-500 dark:text-neutral-400'>{label}</dt>
    <dd className='min-w-0 flex-1 font-medium text-neutral-900 dark:text-white'>{children}</dd>
  </div>
)

const NodeCard = ({ title, node }: { title: string; node: NodeRedundancyStatus }) => (
  <div className='flex min-w-0 flex-1 flex-col gap-2 rounded-lg bg-neutral-50 p-4 dark:bg-neutral-900'>
    <div className='flex items-center gap-2'>
      <span className={cn('h-2 w-2 shrink-0 rounded-full', statusDotClassName[node.statusIndicator])} aria-hidden />
      <h4 className='text-sm font-semibold text-neutral-900 dark:text-white'>{title}</h4>
    </div>
    <dl className='flex flex-col gap-2'>
      <Row label='配置/活动角色'>
        {node.configuredRole} / {node.activeRole}
      </Row>
      <Row label='心跳 eth0'>{node.heartbeatEth0}</Row>
      <Row label='功能 eth2'>
        <span className='flex flex-col gap-0.5 font-mono text-[11px] font-normal'>
          {node.functionEth2Lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      </Row>
      <Row label='PLC'>{node.plc}</Row>
      <Row label='程序'>{node.program}</Row>
      <Row label='IO'>{node.io}</Row>
    </dl>
  </div>
)

const LinkStatusCenter = ({ messages }: { messages: HotRedundancyLinkMessages }) => (
  <div className='flex shrink-0 flex-col items-center justify-center gap-2 px-2 lg:px-4'>
    <p className='rounded-md bg-neutral-100 px-3 py-2 text-center text-xs font-medium text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200'>
      {messages.tcp}
    </p>
    <p className='rounded-md bg-neutral-100 px-3 py-2 text-center text-xs font-medium text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200'>
      {messages.io}
    </p>
  </div>
)

const SystemInfoBlock = ({ title, system }: { title: string; system: RuntimeNodeInfoDisplaySystem }) => (
  <div className='flex min-w-0 flex-1 flex-col gap-2 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-900'>
    <h4 className='text-sm font-semibold text-neutral-900 dark:text-white'>{title}</h4>
    <dl className='flex flex-col gap-1 text-xs'>
      <Row label='OS'>{system.os}</Row>
      <Row label='Kernel'>{system.kernel}</Row>
      <Row label='CPU'>{system.cpu}</Row>
      <Row label='RAM'>{system.ram}</Row>
    </dl>
  </div>
)

const NetworkInfoBlock = ({ title, network }: { title: string; network: RuntimeNodeInfoDisplayNetwork[] }) => (
  <div className='flex min-w-0 flex-1 flex-col gap-2 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-900'>
    <h4 className='text-sm font-semibold text-neutral-900 dark:text-white'>{title}</h4>
    <div className='flex flex-col gap-1'>
      {network.map((iface, index) => (
        <p key={`${iface.interface}-${index}`} className='font-mono text-[11px] text-neutral-600 dark:text-neutral-400'>
          {iface.interface}: {iface.ip} ({iface.mac})
        </p>
      ))}
    </div>
  </div>
)

const hasScanCycleData = (stats: TimingStats | null): stats is TimingStats => stats !== null && stats.scan_count > 0

const HotRedundancyPanel = ({ timingStats, data = MOCK_HOT_REDUNDANCY_DATA }: HotRedundancyPanelProps) => {
  const [redundancyData, setRedundancyData] = useState(data)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const masterNodeInfo = useOpenPLCStore((state) => state.runtimeConnection.nodeInfo)
  const standbyNodeInfo = useOpenPLCStore((state) => state.standbyRuntimeConnection.nodeInfo)
  const standbyTimingStats = useOpenPLCStore((state): TimingStats | null => state.standbyRuntimeConnection.timingStats)
  const standbyPlcLogs = useOpenPLCStore((state) => state.standbyRuntimeConnection.plcLogs)
  const clearStandbyPlcLogs = useOpenPLCStore((state) => state.deviceActions.clearStandbyPlcLogs)

  const masterSystemDisplay = useMemo(() => mapRuntimeNodeInfoToSystemDisplay(masterNodeInfo), [masterNodeInfo])
  const masterNetworkDisplay = useMemo(() => mapRuntimeNodeInfoToNetworkDisplay(masterNodeInfo), [masterNodeInfo])
  const standbySystemDisplay = useMemo(() => mapRuntimeNodeInfoToSystemDisplay(standbyNodeInfo), [standbyNodeInfo])
  const standbyNetworkDisplay = useMemo(() => mapRuntimeNodeInfoToNetworkDisplay(standbyNodeInfo), [standbyNodeInfo])

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true)
    // Placeholder until hot-redundancy status API is integrated.
    setRedundancyData({ ...MOCK_HOT_REDUNDANCY_DATA })
    window.setTimeout(() => {
      setIsRefreshing(false)
    }, 400)
  }, [])

  return (
    <div id='hot-redundancy-panel-content' className='flex w-full flex-col gap-6'>
      {hasScanCycleData(timingStats) && (
        <ScanCycleStats timingStats={timingStats} variant='compact' title='主机扫描周期统计' />
      )}

      {hasScanCycleData(standbyTimingStats) && (
        <ScanCycleStats timingStats={standbyTimingStats} variant='compact' title='备机扫描周期统计' />
      )}

      <section id='hot-redundancy-link-section' className='flex w-full flex-col gap-3'>
        <div className='flex w-full items-center justify-between gap-2'>
          <h3 className='text-base font-medium text-neutral-950 dark:text-white'>热冗余通信状态</h3>
          <button
            type='button'
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
            className='flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800'
            aria-label='刷新热冗余通信状态'
          >
            <RefreshIcon size='sm' className={cn(isRefreshing && 'spin-refresh')} />
            刷新
          </button>
        </div>
        <div className='flex w-full flex-col gap-4 lg:flex-row lg:items-stretch'>
          <NodeCard title='主机' node={redundancyData.master} />
          <LinkStatusCenter messages={redundancyData.linkMessages} />
          <NodeCard title='备机' node={redundancyData.standby} />
        </div>
      </section>

      <section className='flex w-full flex-col gap-3'>
        <h3 className='text-base font-medium text-neutral-950 dark:text-white'>备机PLC Logs</h3>
        <PlcLogsCompact logs={standbyPlcLogs} onClearLogs={clearStandbyPlcLogs} exportFilePrefix='standby-plc-logs' />
      </section>

      <section className='flex w-full flex-col gap-3'>
        <h3 className='text-base font-medium text-neutral-950 dark:text-white'>系统与网络映射信息</h3>
        <div className='grid w-full grid-cols-1 gap-3 xl:grid-cols-2'>
          <SystemInfoBlock title='主机系统信息' system={masterSystemDisplay} />
          <NetworkInfoBlock title='主机网络信息' network={masterNetworkDisplay} />
          <SystemInfoBlock title='备机系统信息' system={standbySystemDisplay} />
          <NetworkInfoBlock title='备机网络信息' network={standbyNetworkDisplay} />
        </div>
      </section>
    </div>
  )
}

export { HotRedundancyPanel }
