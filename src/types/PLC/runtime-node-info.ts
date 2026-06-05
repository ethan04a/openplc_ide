export type RuntimeNodeSystemInfo = {
  os: string
  kernel: string
  cpu_usage_percent: number
  ram_usage_percent: number
  ram_total_mb?: number
  ram_used_mb?: number
}

export type RuntimeNetworkInterface = {
  interface: string
  ip: string | null
  mac: string
  state?: 'up' | 'down'
}

export type RuntimeNodeInfo = {
  system?: RuntimeNodeSystemInfo
  network?: {
    interfaces: RuntimeNetworkInterface[]
  }
  timestamp?: string
}

export type RuntimeNodeInfoDisplaySystem = {
  os: string
  kernel: string
  cpu: string
  ram: string
}

export type RuntimeNodeInfoDisplayNetwork = {
  interface: string
  ip: string
  mac: string
}

const EMPTY_SYSTEM_DISPLAY: RuntimeNodeInfoDisplaySystem = {
  os: '-',
  kernel: '-',
  cpu: '-',
  ram: '-',
}

const EMPTY_NETWORK_DISPLAY: RuntimeNodeInfoDisplayNetwork[] = [{ interface: '-', ip: '-', mac: '-' }]

const formatPercent = (value: number | undefined): string =>
  typeof value === 'number' && Number.isFinite(value) ? `${value}%` : '-'

export const mapRuntimeNodeInfoToSystemDisplay = (nodeInfo: RuntimeNodeInfo | null): RuntimeNodeInfoDisplaySystem => {
  if (!nodeInfo?.system) {
    return EMPTY_SYSTEM_DISPLAY
  }

  const { system } = nodeInfo
  return {
    os: system.os || '-',
    kernel: system.kernel || '-',
    cpu: formatPercent(system.cpu_usage_percent),
    ram: formatPercent(system.ram_usage_percent),
  }
}

export const mapRuntimeNodeInfoToNetworkDisplay = (
  nodeInfo: RuntimeNodeInfo | null,
): RuntimeNodeInfoDisplayNetwork[] => {
  const interfaces = nodeInfo?.network?.interfaces
  if (!interfaces || interfaces.length === 0) {
    return EMPTY_NETWORK_DISPLAY
  }

  return interfaces.map((iface) => ({
    interface: iface.interface || '-',
    ip: iface.ip ?? '-',
    mac: iface.mac || '-',
  }))
}
