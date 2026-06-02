import webBridge, { initWebBridge, type PlatformBridge } from './web-bridge'

export { webBridge as bridge, initWebBridge }
export type { PlatformBridge }

declare global {
  interface Window {
    bridge: PlatformBridge
  }
}
