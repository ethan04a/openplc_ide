import type { TimingStats } from '@root/renderer/store/slices/device/types'
import { cn } from '@root/utils'
import type { ReactNode } from 'react'

type ScanCycleStatsProps = {
  timingStats: TimingStats
  variant?: 'default' | 'compact'
  title?: string
  className?: string
}

const StatCard = ({
  label,
  value,
  subValue,
  compact,
}: {
  label: string
  value: ReactNode
  subValue?: string
  compact?: boolean
}) => (
  <div
    className={cn(
      'flex flex-col gap-1 rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900',
      compact ? 'p-2' : 'p-3',
    )}
  >
    <span className='text-xs text-neutral-500 dark:text-neutral-400'>{label}</span>
    <span className={cn('font-semibold text-neutral-900 dark:text-white', compact ? 'text-base' : 'text-lg')}>
      {value}
    </span>
    {subValue && <span className='text-xs text-neutral-500 dark:text-neutral-400'>{subValue}</span>}
  </div>
)

const ScanCycleStats = ({
  timingStats,
  variant = 'default',
  title = 'Scan Cycle Statistics',
  className,
}: ScanCycleStatsProps) => {
  const compact = variant === 'compact'

  return (
    <div id='scan-cycle-stats-section' className={cn('flex w-full flex-col gap-3', className)}>
      <h3
        id='scan-cycle-stats-title'
        className={cn('select-none font-medium text-neutral-950 dark:text-white', compact ? 'text-sm' : 'text-lg')}
      >
        {title}
      </h3>
      <div
        id='scan-cycle-stats-cards'
        className={cn(
          'grid gap-2',
          compact ? 'grid-cols-3 sm:grid-cols-5' : 'grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4',
        )}
      >
        <StatCard compact={compact} label='Scan Count' value={timingStats.scan_count.toLocaleString()} />
        <StatCard compact={compact} label='Overruns' value={timingStats.overruns} />
        {timingStats.scan_time_avg !== null && (
          <StatCard
            compact={compact}
            label='Scan Time (avg)'
            value={
              <>
                {timingStats.scan_time_avg} <span className='text-sm font-normal'>us</span>
              </>
            }
            subValue={
              timingStats.scan_time_min !== null && timingStats.scan_time_max !== null
                ? `min: ${timingStats.scan_time_min} / max: ${timingStats.scan_time_max}`
                : undefined
            }
          />
        )}
        {timingStats.cycle_time_avg !== null && (
          <StatCard
            compact={compact}
            label='Cycle Time (avg)'
            value={
              <>
                {timingStats.cycle_time_avg} <span className='text-sm font-normal'>us</span>
              </>
            }
            subValue={
              timingStats.cycle_time_min !== null && timingStats.cycle_time_max !== null
                ? `min: ${timingStats.cycle_time_min} / max: ${timingStats.cycle_time_max}`
                : undefined
            }
          />
        )}
        {timingStats.cycle_latency_avg !== null && (
          <StatCard
            compact={compact}
            label='Cycle Latency (avg)'
            value={
              <>
                {timingStats.cycle_latency_avg} <span className='text-sm font-normal'>us</span>
              </>
            }
          />
        )}
      </div>
    </div>
  )
}

export { ScanCycleStats }
