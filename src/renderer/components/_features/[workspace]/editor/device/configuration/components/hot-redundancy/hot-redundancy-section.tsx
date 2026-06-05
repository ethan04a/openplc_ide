import * as Switch from '@radix-ui/react-switch'
import type { TimingStats } from '@root/renderer/store/slices/device/types'
import { cn } from '@root/utils'
import { useState } from 'react'

import { ScanCycleStats } from '../scan-cycle-stats'
import { HotRedundancyPanel } from './hot-redundancy-panel'

type HotRedundancySectionProps = {
  timingStats: TimingStats | null
}

const HotRedundancySection = ({ timingStats }: HotRedundancySectionProps) => {
  const [panelEnabled, setPanelEnabled] = useState(false)

  const showScanCycleStats = timingStats !== null && timingStats.scan_count > 0

  return (
    <div id='hot-redundancy-section' className='flex w-full flex-col gap-4'>
      <div
        id='hot-redundancy-header'
        className={cn('flex w-full items-center gap-4', panelEnabled ? 'justify-between' : 'justify-end')}
      >
        {panelEnabled && (
          <h2 id='hot-redundancy-title' className='select-none text-lg font-medium text-neutral-950 dark:text-white'>
            热冗余面板
          </h2>
        )}
        <div className='flex items-center gap-2'>
          <label
            htmlFor='hot-redundancy-panel-switch'
            className='cursor-pointer select-none text-xs text-neutral-600 dark:text-neutral-400'
          >
            {panelEnabled ? '热冗余面板展开' : '热冗余面板隐藏'}
          </label>
          <Switch.Root
            id='hot-redundancy-panel-switch'
            checked={panelEnabled}
            onCheckedChange={setPanelEnabled}
            className={cn(
              'relative h-[18px] w-[34px] rounded-full outline-none transition-colors',
              'data-[state=checked]:bg-brand data-[state=unchecked]:bg-neutral-300 dark:data-[state=unchecked]:bg-neutral-700',
            )}
          >
            <Switch.Thumb
              className={cn(
                'block h-[14px] w-[14px] translate-x-0.5 rounded-full bg-white shadow transition-transform duration-150',
                'data-[state=checked]:translate-x-[16px]',
              )}
            />
          </Switch.Root>
        </div>
      </div>

      {panelEnabled ? (
        <HotRedundancyPanel timingStats={timingStats} />
      ) : (
        showScanCycleStats && (
          <ScanCycleStats timingStats={timingStats} variant='default' title='Scan Cycle Statistics' />
        )
      )}
    </div>
  )
}

export { HotRedundancySection }
