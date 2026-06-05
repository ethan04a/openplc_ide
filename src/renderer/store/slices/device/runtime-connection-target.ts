type RuntimeConnectionTarget = 'master' | 'standby'

type RuntimeConnectionModalData = {
  connectionTarget?: RuntimeConnectionTarget
}

export type { RuntimeConnectionModalData, RuntimeConnectionTarget }
