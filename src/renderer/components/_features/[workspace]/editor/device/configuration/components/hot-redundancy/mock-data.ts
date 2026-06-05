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
  masterSystem: { os: string; kernel: string; cpu: string; ram: string }
  masterNetwork: { interface: string; ip: string; mac: string }[]
  standbySystem: { os: string; kernel: string; cpu: string; ram: string }
  standbyNetwork: { interface: string; ip: string; mac: string }[]
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
  masterSystem: {
    os: 'Debian 12',
    kernel: '6.1.0',
    cpu: '12%',
    ram: '34%',
  },
  masterNetwork: [
    { interface: 'lo', ip: '127.0.0.1', mac: '00:00:00:00:00:00' },
    { interface: 'eth0', ip: '192.168.1.10', mac: 'aa:bb:cc:dd:ee:01' },
    { interface: 'eth1', ip: '192.168.2.10', mac: 'aa:bb:cc:dd:ee:02' },
  ],
  standbySystem: {
    os: 'Debian 12',
    kernel: '6.1.0',
    cpu: '8%',
    ram: '28%',
  },
  standbyNetwork: [
    { interface: 'lo', ip: '127.0.0.1', mac: '00:00:00:00:00:00' },
    { interface: 'eth0', ip: '192.168.1.11', mac: 'aa:bb:cc:dd:ee:11' },
    { interface: 'eth1', ip: '192.168.2.11', mac: 'aa:bb:cc:dd:ee:12' },
  ],
}
