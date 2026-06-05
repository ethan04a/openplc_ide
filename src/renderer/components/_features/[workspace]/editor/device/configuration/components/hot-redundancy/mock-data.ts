export type NodeRedundancyStatus = {
  role: string
  runStatus: string
  heartbeatIp: string
  transferIp: string
  plcStatus: string
  syncStatus: string
  ioDetail: string
}

export type HotRedundancyMockData = {
  master: NodeRedundancyStatus
  standby: NodeRedundancyStatus
  linkStatus: {
    tcp: 'ok' | 'warn' | 'error'
    io: 'ok' | 'warn' | 'error'
    ioSync: 'ok' | 'warn' | 'error'
  }
}

export const MOCK_HOT_REDUNDANCY_DATA: HotRedundancyMockData = {
  master: {
    role: 'Master',
    runStatus: 'Running',
    heartbeatIp: '192.168.1.10',
    transferIp: '192.168.2.10',
    plcStatus: 'RUNNING',
    syncStatus: 'SUCCESS',
    ioDetail: 'IO OK',
  },
  standby: {
    role: 'Standby',
    runStatus: 'Running',
    heartbeatIp: '192.168.1.11',
    transferIp: '192.168.2.11',
    plcStatus: 'RUNNING',
    syncStatus: 'SUCCESS',
    ioDetail: 'IO OK',
  },
  linkStatus: {
    tcp: 'ok',
    io: 'ok',
    ioSync: 'ok',
  },
}
