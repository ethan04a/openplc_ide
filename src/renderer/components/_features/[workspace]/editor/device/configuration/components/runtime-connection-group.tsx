import { Label } from '@root/renderer/components/_atoms'
import type { RuntimeConnection } from '@root/renderer/store/slices/device/types'
import { cn } from '@root/utils'

type RuntimeConnectionGroupProps = {
  idPrefix: string
  ipAddress: string
  onIpAddressChange: (value: string) => void
  connectionStatus: RuntimeConnection['connectionStatus']
  plcStatus: RuntimeConnection['plcStatus']
  onConnectClick: () => void
  ipLabel?: string
  className?: string
}

const RuntimeConnectionGroup = ({
  idPrefix,
  ipAddress,
  onIpAddressChange,
  connectionStatus,
  plcStatus,
  onConnectClick,
  ipLabel = 'IP Address',
  className,
}: RuntimeConnectionGroupProps) => {
  return (
    <div className={cn('flex w-full flex-col gap-3', className)}>
      <div id={`${idPrefix}-runtime-ip-address-field`} className='flex w-full items-center justify-start gap-1'>
        <Label
          id={`${idPrefix}-runtime-ip-address-label`}
          className='whitespace-pre text-xs text-neutral-950 dark:text-white'
        >
          {ipLabel}
        </Label>
        <input
          id={`${idPrefix}-runtime-ip-address-input`}
          type='text'
          value={ipAddress}
          onChange={(e) => onIpAddressChange(e.target.value)}
          placeholder='127.0.0.1 or localhost'
          className='flex h-[30px] w-full items-center justify-between gap-1 rounded-md border border-neutral-100 bg-white px-2 py-1 font-caption text-cp-sm font-medium text-neutral-850 outline-none focus:border-brand-medium-dark dark:border-neutral-850 dark:bg-neutral-950 dark:text-neutral-300'
        />
      </div>
      <div id={`${idPrefix}-runtime-connect-button-container`} className='flex w-full items-center justify-start'>
        <button
          type='button'
          onClick={onConnectClick}
          disabled={connectionStatus === 'connecting'}
          className='h-[30px] rounded-md bg-brand px-4 py-1 font-caption text-cp-sm font-medium text-white hover:bg-brand-medium-dark disabled:opacity-50'
        >
          {connectionStatus === 'connecting'
            ? 'Connecting...'
            : connectionStatus === 'connected'
              ? 'Disconnect'
              : 'Connect'}
        </button>
        {connectionStatus === 'connected' && (
          <div className='ml-2 flex items-center gap-2'>
            <span className='text-xs text-green-600 dark:text-green-400'>● Connected</span>
            {plcStatus && <span className='text-xs text-neutral-600 dark:text-neutral-400'>| PLC: {plcStatus}</span>}
          </div>
        )}
        {connectionStatus === 'error' && (
          <span className='ml-2 text-xs text-red-600 dark:text-red-400'>● Connection failed</span>
        )}
      </div>
    </div>
  )
}

export { RuntimeConnectionGroup }
