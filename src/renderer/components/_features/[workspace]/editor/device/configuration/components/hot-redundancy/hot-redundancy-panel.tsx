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
import { useMemo } from 'react'

import { ScanCycleStats } from '../scan-cycle-stats'
import { type HotRedundancyMockData, MOCK_HOT_REDUNDANCY_DATA } from './mock-data'

type HotRedundancyPanelProps = {
  timingStats: TimingStats | null
  data?: HotRedundancyMockData
}

const StatusBadge = ({ label, active }: { label: string; active: boolean }) => (
  <span
    className={cn(
      'rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide',
      active ? 'bg-brand text-white' : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
    )}
  >
    {label}
  </span>
)

const NodeCard = ({ title, node }: { title: string; node: HotRedundancyMockData['master'] }) => (
  <div className='flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900'>
    <h4 className='text-sm font-semibold text-neutral-900 dark:text-white'>{title}</h4>
    <dl className='flex flex-col gap-1.5 text-xs'>
      <Row label='角色' value={node.role} />
      <Row label='运行状态' value={node.runStatus} />
      <Row label='心跳 eth0 IP' value={node.heartbeatIp} />
      <Row label='传输 eth1 IP' value={node.transferIp} />
      <Row label='PLC 状态' value={node.plcStatus} />
      <Row label='同步状态' value={node.syncStatus} />
      <Row label='IO 详情' value={node.ioDetail} />
    </dl>
  </div>
)

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className='flex gap-2'>
    <dt className='shrink-0 text-neutral-500 dark:text-neutral-400'>{label}</dt>
    <dd className='font-medium text-neutral-900 dark:text-white'>{value}</dd>
  </div>
)

const SystemInfoBlock = ({ title, system }: { title: string; system: RuntimeNodeInfoDisplaySystem }) => (
  <div className='flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900'>
    <h4 className='text-sm font-semibold text-neutral-900 dark:text-white'>{title}</h4>
    <dl className='flex flex-col gap-1 text-xs'>
      <Row label='OS' value={system.os} />
      <Row label='Kernel' value={system.kernel} />
      <Row label='CPU' value={system.cpu} />
      <Row label='RAM' value={system.ram} />
    </dl>
  </div>
)

const NetworkInfoBlock = ({ title, network }: { title: string; network: RuntimeNodeInfoDisplayNetwork[] }) => (
  <div className='flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900'>
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

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className='flex w-full flex-col gap-3'>
    <h3 className='text-base font-medium text-neutral-950 dark:text-white'>{title}</h3>
    {children}
  </section>
)

const hasScanCycleData = (stats: TimingStats | null): stats is TimingStats => stats !== null && stats.scan_count > 0

const HotRedundancyPanel = ({ timingStats, data = MOCK_HOT_REDUNDANCY_DATA }: HotRedundancyPanelProps) => {
  const { linkStatus } = data
  const masterNodeInfo = useOpenPLCStore((state) => state.runtimeConnection.nodeInfo)
  const standbyTimingStats = useOpenPLCStore((state): TimingStats | null => state.standbyRuntimeConnection.timingStats)
  const standbyPlcLogs = useOpenPLCStore((state) => state.standbyRuntimeConnection.plcLogs)
  const clearStandbyPlcLogs = useOpenPLCStore((state) => state.deviceActions.clearStandbyPlcLogs)

  const masterSystemDisplay = useMemo(() => mapRuntimeNodeInfoToSystemDisplay(masterNodeInfo), [masterNodeInfo])
  const masterNetworkDisplay = useMemo(() => mapRuntimeNodeInfoToNetworkDisplay(masterNodeInfo), [masterNodeInfo])

  return (
    <div id='hot-redundancy-panel-content' className='flex w-full flex-col gap-6'>
      {hasScanCycleData(timingStats) && (
        <ScanCycleStats timingStats={timingStats} variant='compact' title='主机扫描周期统计' />
      )}

      {hasScanCycleData(standbyTimingStats) && (
        <ScanCycleStats timingStats={standbyTimingStats} variant='compact' title='备机扫描周期统计' />
      )}

      <Section title='热冗余通信状态'>
        <div className='flex w-full flex-col gap-3 lg:flex-row lg:items-stretch'>
          <NodeCard title='主机' node={data.master} />
          <div className='flex shrink-0 flex-row items-center justify-center gap-2 lg:flex-col lg:px-2'>
            <StatusBadge label='TCP STATUS' active={linkStatus.tcp === 'ok'} />
            <StatusBadge label='IO STATUS' active={linkStatus.io === 'ok'} />
            <StatusBadge label='IO SYNC' active={linkStatus.ioSync === 'ok'} />
          </div>
          <NodeCard title='备机' node={data.standby} />
        </div>
      </Section>

      <Section title='备机PLC Logs'>
        <PlcLogsCompact logs={standbyPlcLogs} onClearLogs={clearStandbyPlcLogs} exportFilePrefix='standby-plc-logs' />
      </Section>

      <Section title='系统与网络映射信息'>
        <div className='grid w-full grid-cols-1 gap-3 xl:grid-cols-2'>
          <SystemInfoBlock title='主机系统信息' system={masterSystemDisplay} />
          <NetworkInfoBlock title='主机网络信息' network={masterNetworkDisplay} />
          <SystemInfoBlock title='备机系统信息' system={data.standbySystem} />
          <NetworkInfoBlock title='备机网络信息' network={data.standbyNetwork} />
        </div>
      </Section>
    </div>
  )
}

export { HotRedundancyPanel }
