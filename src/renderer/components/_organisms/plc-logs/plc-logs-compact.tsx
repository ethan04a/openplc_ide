import { ClearConsoleButton } from '@root/renderer/components/_atoms/buttons/console/clear-console'
import { LogComponent, LogLevel } from '@root/renderer/components/_organisms/console/log'
import { TimestampFormat } from '@root/renderer/store/slices/console/types'
import type { RuntimeLogEntry, RuntimeLogLevel } from '@root/types/PLC/runtime-logs'
import { cn, formatTimestamp } from '@root/utils'
import { ChevronDown, Download, Filter, Search, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

type PlcLogFilters = {
  levels: Record<LogLevel, boolean>
  searchTerm: string
  timestampFormat: TimestampFormat
}

type ExportFormat = 'txt' | 'csv' | 'json'

type PlcLogsCompactProps = {
  logs: RuntimeLogEntry[]
  onClearLogs: () => void
  exportFilePrefix?: string
  ariaLabel?: string
  className?: string
}

const DEFAULT_FILTERS: PlcLogFilters = {
  levels: { debug: true, info: true, warning: true, error: true },
  searchTerm: '',
  timestampFormat: 'full',
}

const levelConfig: Record<LogLevel, { label: string; colorDot: string }> = {
  debug: { label: 'Debug', colorDot: 'bg-neutral-500 dark:bg-neutral-400' },
  info: { label: 'Info', colorDot: 'bg-blue-500' },
  warning: { label: 'Warning', colorDot: 'bg-yellow-500' },
  error: { label: 'Error', colorDot: 'bg-red-500' },
}

const formatOptions: { value: TimestampFormat; label: string }[] = [
  { value: 'full', label: 'DD-MM-YY HH:MM:SS' },
  { value: 'time', label: 'HH:MM:SS' },
  { value: 'none', label: 'None' },
]

const mapV4LevelToLogLevel = (level: RuntimeLogLevel): LogLevel => {
  switch (level) {
    case 'DEBUG':
      return 'debug'
    case 'INFO':
      return 'info'
    case 'WARNING':
      return 'warning'
    case 'ERROR':
      return 'error'
    default:
      return 'info'
  }
}

const filterLogs = (logs: RuntimeLogEntry[], filters: PlcLogFilters): RuntimeLogEntry[] =>
  logs.filter((entry) => {
    const level = mapV4LevelToLogLevel(entry.level)
    if (!filters.levels[level]) return false

    if (filters.searchTerm) {
      const searchLower = filters.searchTerm.toLowerCase()
      const messageMatch = entry.message.toLowerCase().includes(searchLower)
      const timestampMatch = entry.timestamp.toLowerCase().includes(searchLower)
      if (!messageMatch && !timestampMatch) return false
    }

    return true
  })

const PlcLogsCompactToolbar = ({
  filters,
  onFiltersChange,
  logs,
  filteredLogs,
  exportFilePrefix,
}: {
  filters: PlcLogFilters
  onFiltersChange: (filters: PlcLogFilters) => void
  logs: RuntimeLogEntry[]
  filteredLogs: RuntimeLogEntry[]
  exportFilePrefix: string
}) => {
  const [isExpanded, setIsExpanded] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [showFormatMenu, setShowFormatMenu] = useState(false)
  const [panelPosition, setPanelPosition] = useState({ top: 0, right: 0 })
  const [exportPosition, setExportPosition] = useState({ top: 0, right: 0 })

  const filterButtonRef = useRef<HTMLButtonElement>(null)
  const exportButtonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        isExpanded &&
        panelRef.current &&
        !panelRef.current.contains(target) &&
        !filterButtonRef.current?.contains(target)
      ) {
        setIsExpanded(false)
      }
      if (
        showExportMenu &&
        exportMenuRef.current &&
        !exportMenuRef.current.contains(target) &&
        !exportButtonRef.current?.contains(target)
      ) {
        setShowExportMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isExpanded, showExportMenu])

  useEffect(() => {
    if (isExpanded && filterButtonRef.current) {
      const rect = filterButtonRef.current.getBoundingClientRect()
      setPanelPosition({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      })
    }
  }, [isExpanded])

  useEffect(() => {
    if (showExportMenu && exportButtonRef.current) {
      const rect = exportButtonRef.current.getBoundingClientRect()
      setExportPosition({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      })
    }
  }, [showExportMenu])

  const activeFiltersCount = useMemo(() => Object.values(filters.levels).filter(Boolean).length, [filters.levels])

  const hasActiveFilters = useMemo(
    () => activeFiltersCount < 4 || Boolean(filters.searchTerm) || filters.timestampFormat !== 'full',
    [activeFiltersCount, filters.searchTerm, filters.timestampFormat],
  )

  const toggleLevel = (level: LogLevel) => {
    onFiltersChange({
      ...filters,
      levels: { ...filters.levels, [level]: !filters.levels[level] },
    })
  }

  const exportLogs = useCallback(
    (format: ExportFormat) => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      let content: string
      let mimeType: string
      let extension: string

      switch (format) {
        case 'json':
          content = JSON.stringify(
            filteredLogs.map((log) => ({
              timestamp: log.timestamp,
              level: log.level,
              message: log.message,
            })),
            null,
            2,
          )
          mimeType = 'application/json'
          extension = 'json'
          break
        case 'csv':
          content = 'Timestamp,Level,Message\n'
          content += filteredLogs
            .map((log) => {
              const escapedMessage = `"${log.message.replace(/"/g, '""')}"`
              return `${log.timestamp},${log.level},${escapedMessage}`
            })
            .join('\n')
          mimeType = 'text/csv'
          extension = 'csv'
          break
        default:
          content = filteredLogs
            .map((log) => `[${formatTimestamp(log.timestamp, 'full')}] [${log.level}]: ${log.message}`)
            .join('\n')
          mimeType = 'text/plain'
          extension = 'txt'
      }

      const blob = new Blob([content], { type: mimeType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${exportFilePrefix}-${timestamp}.${extension}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setShowExportMenu(false)
    },
    [exportFilePrefix, filteredLogs],
  )

  const currentFormatLabel = formatOptions.find((opt) => opt.value === filters.timestampFormat)?.label || 'Full'

  const toolbarButtonClass =
    'flex h-6 w-fit select-none items-center gap-1 rounded-md bg-neutral-100 px-1.5 transition-colors hover:bg-neutral-200 dark:bg-neutral-850 dark:hover:bg-neutral-900'

  return (
    <div className='relative flex items-center gap-1.5'>
      <div className='relative'>
        <button
          ref={exportButtonRef}
          type='button'
          onClick={() => setShowExportMenu(!showExportMenu)}
          className={toolbarButtonClass}
          title='Export logs'
          disabled={logs.length === 0}
        >
          <Download className='h-3 w-3' />
        </button>
        {showExportMenu && (
          <div
            ref={exportMenuRef}
            className='fixed z-[9999] w-28 rounded-lg border border-neutral-100 bg-white py-1 shadow-lg dark:border-brand-medium-dark dark:bg-neutral-950'
            style={{ top: exportPosition.top, right: exportPosition.right }}
          >
            {(['txt', 'csv', 'json'] as ExportFormat[]).map((format) => (
              <button
                key={format}
                type='button'
                onClick={() => exportLogs(format)}
                className='flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] font-medium text-neutral-850 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900'
              >
                <span className='uppercase'>.{format}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        ref={filterButtonRef}
        type='button'
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(toolbarButtonClass, hasActiveFilters && 'bg-brand text-white hover:bg-brand-medium-dark')}
      >
        <Filter className='h-3 w-3' />
        <span className='text-[11px] font-normal'>Filters</span>
        {hasActiveFilters && (
          <span className='flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white text-[9px] font-semibold text-brand'>
            {activeFiltersCount}
          </span>
        )}
      </button>

      {isExpanded && (
        <div
          ref={panelRef}
          className='fixed z-[9999] max-h-[320px] w-72 overflow-y-auto rounded-lg border border-neutral-100 bg-white p-2.5 shadow-lg dark:border-brand-medium-dark dark:bg-neutral-950'
          style={{ top: panelPosition.top, right: panelPosition.right }}
        >
          <div className='flex flex-col gap-2.5'>
            <div className='relative'>
              <Search className='absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 stroke-neutral-400 dark:stroke-neutral-500' />
              <input
                type='text'
                placeholder='Search logs...'
                value={filters.searchTerm}
                onChange={(e) => onFiltersChange({ ...filters, searchTerm: e.target.value })}
                className='h-6 w-full rounded-md border border-neutral-300 bg-white py-0 pl-7 pr-7 text-[11px] text-neutral-850 placeholder-neutral-400 outline-none focus:border-brand-medium-dark dark:border-neutral-850 dark:bg-neutral-950 dark:text-neutral-300'
              />
              {filters.searchTerm && (
                <button
                  type='button'
                  onClick={() => onFiltersChange({ ...filters, searchTerm: '' })}
                  className='absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:text-neutral-500'
                >
                  <X className='h-3 w-3' />
                </button>
              )}
            </div>

            <div>
              <label className='mb-1.5 block text-[11px] font-medium text-neutral-850 dark:text-neutral-300'>
                Log Levels
              </label>
              <div className='space-y-1'>
                {(['debug', 'info', 'warning', 'error'] as LogLevel[]).map((level) => (
                  <label
                    key={level}
                    className='flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-900'
                  >
                    <input
                      type='checkbox'
                      checked={filters.levels[level]}
                      onChange={() => toggleLevel(level)}
                      className='peer sr-only'
                    />
                    <div
                      className={cn(
                        'relative h-3.5 w-6 rounded-full bg-neutral-300 after:absolute after:left-0.5 after:top-0.5 after:h-2.5 after:w-2.5 after:rounded-full after:bg-white after:transition-transform after:content-[""] peer-checked:bg-brand peer-checked:after:translate-x-2.5 dark:bg-neutral-700',
                      )}
                    />
                    <div className='flex flex-1 items-center gap-1.5'>
                      <span className={cn('h-1.5 w-1.5 rounded-full', levelConfig[level].colorDot)} />
                      <span className='text-[11px] font-medium text-neutral-850 dark:text-neutral-300'>
                        {levelConfig[level].label}
                      </span>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className='border-t border-neutral-200 pt-2 dark:border-neutral-800'>
              <div className='flex items-center justify-between'>
                <span className='text-[11px] font-medium text-neutral-850 dark:text-neutral-300'>Format</span>
                <div className='relative'>
                  <button
                    type='button'
                    onClick={() => setShowFormatMenu(!showFormatMenu)}
                    className='flex h-6 items-center gap-1 rounded-md border border-neutral-300 bg-white px-2 text-[11px] font-medium text-neutral-850 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300'
                  >
                    <span>{currentFormatLabel}</span>
                    <ChevronDown className={cn('h-3 w-3 transition-transform', showFormatMenu && 'rotate-180')} />
                  </button>
                  {showFormatMenu && (
                    <div className='absolute bottom-full right-0 z-50 mb-1 w-36 rounded-lg border border-neutral-100 bg-white py-1 shadow-lg dark:border-brand-medium-dark dark:bg-neutral-950'>
                      {formatOptions.map((option) => (
                        <button
                          key={option.value}
                          type='button'
                          onClick={() => {
                            onFiltersChange({ ...filters, timestampFormat: option.value })
                            setShowFormatMenu(false)
                          }}
                          className={cn(
                            'flex w-full px-2.5 py-1 text-left text-[11px] font-medium transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-900',
                            filters.timestampFormat === option.value
                              ? 'bg-neutral-100 text-brand dark:bg-neutral-900'
                              : 'text-neutral-850 dark:text-neutral-300',
                          )}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const PlcLogsCompact = memo(function PlcLogsCompact({
  logs,
  onClearLogs,
  exportFilePrefix = 'standby-plc-logs',
  ariaLabel = 'Standby PLC Logs',
  className,
}: PlcLogsCompactProps) {
  const [filters, setFilters] = useState<PlcLogFilters>(DEFAULT_FILTERS)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const bottomLogRef = useRef<HTMLDivElement | null>(null)

  const filteredLogs = useMemo(() => filterLogs(logs, filters), [logs, filters])

  useEffect(() => {
    if (bottomLogRef.current) {
      bottomLogRef.current.scrollIntoView({ behavior: 'instant', block: 'end' })
    }
  }, [filteredLogs.length])

  return (
    <div
      id='standby-plc-logs-compact'
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950',
        className,
      )}
    >
      <div className='flex items-center justify-end gap-1.5 border-b border-neutral-200 px-2 py-1 dark:border-neutral-800'>
        <PlcLogsCompactToolbar
          filters={filters}
          onFiltersChange={setFilters}
          logs={logs}
          filteredLogs={filteredLogs}
          exportFilePrefix={exportFilePrefix}
        />
        <ClearConsoleButton onClear={onClearLogs} isEmpty={logs.length === 0} label='Clear logs' />
      </div>

      <div
        ref={containerRef}
        aria-label={ariaLabel}
        className='h-[180px] select-text overflow-auto px-2 py-1.5 text-cp-sm focus:outline-none'
      >
        {filteredLogs.length > 0 ? (
          filteredLogs.map((entry, index) => (
            <LogComponent
              key={`standby-plc-log-${entry.id ?? index}-${index}`}
              level={mapV4LevelToLogLevel(entry.level)}
              message={entry.message}
              tstamp={formatTimestamp(entry.timestamp, filters.timestampFormat)}
              searchTerm={filters.searchTerm}
            />
          ))
        ) : (
          <p className='py-2 text-xs text-neutral-400 dark:text-neutral-500'>No logs to display.</p>
        )}
        <div ref={bottomLogRef} />
      </div>
    </div>
  )
})

export { PlcLogsCompact }
