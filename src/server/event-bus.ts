import { EventEmitter } from 'events'

export type BridgeEventPayload = {
  channel: string
  args: unknown[]
}

class ServerEventBus extends EventEmitter {
  emitEvent(channel: string, ...args: unknown[]): void {
    this.emit('bridge-event', { channel, args } satisfies BridgeEventPayload)
  }
}

export const serverEventBus = new ServerEventBus()
