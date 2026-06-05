export type NodeStatusIndicator = 'ok' | 'warn' | 'error'

export type NodeRedundancyStatus = {
  configuredRole: string
  activeRole: string
  heartbeatEth0: string
  functionEth2Lines: string[]
  plc: string
  program: string
  io: string
  statusIndicator: NodeStatusIndicator
}

export type HotRedundancyLinkMessages = {
  tcp: string
  io: string
}

export type HotRedundancyMockData = {
  master: NodeRedundancyStatus
  standby: NodeRedundancyStatus
  linkMessages: HotRedundancyLinkMessages
}

export const MOCK_HOT_REDUNDANCY_DATA: HotRedundancyMockData = {
  master: {
    configuredRole: '主机',
    activeRole: '主机',
    heartbeatEth0: '192.168.200.10',
    functionEth2Lines: ['192.168.100.10/24', '10.10.20.10/24'],
    plc: 'RUNNING',
    program: 'SUCCESS',
    io: 'plc_main · seq 1234',
    statusIndicator: 'ok',
  },
  standby: {
    configuredRole: '备机',
    activeRole: '备机',
    heartbeatEth0: '192.168.200.20',
    functionEth2Lines: ['备用接管', '10.10.20.20/24'],
    plc: 'RUNNING shadow',
    program: '已同步',
    io: '落后 3 帧',
    statusIndicator: 'warn',
  },
  linkMessages: {
    tcp: 'TCP 57575 已连接',
    io: 'IO UDP 同步中',
  },
}
