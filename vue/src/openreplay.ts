import type Tracker from '@openreplay/tracker/class'
import type { App } from 'vue'
import type { DeliveryStatus } from './outbox.js'
import { localReplayEndpoint, replayDelivery, wakeReplayGateway } from './replay-gateway-client.js'
import { defaultReplayGatewayPath, usesSecureTransport } from './collector-url.js'

export interface OpenReplayOptions {
  enabled?: boolean
  projectKey?: string
  ingestPoint?: string
  gatewayPath?: string
}

export interface OpenReplay {
  install(app: App): void
  start(): Promise<boolean>
  stop(): void
  deliveryStatus(): Promise<DeliveryStatus | null>
  retryDelivery(): Promise<DeliveryStatus | null>
}

function browserAllowsReplay(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  const { navigator } = window
  return usesSecureTransport(new URL(window.location.href))
    && navigator.doNotTrack !== '1' && navigator.doNotTrack !== 'yes'
    && !('doNotTrack' in window && window.doNotTrack === '1')
    && !('globalPrivacyControl' in navigator && navigator.globalPrivacyControl === true)
}

function ingestEndpoint(value: string): string {
  const url = new URL(value)
  if (!usesSecureTransport(url) || url.username || url.password || url.search || url.hash)
    throw new TypeError('Observability: invalid OpenReplay endpoint')
  return url.href.replace(/\/+$/, '')
}

export function createOpenReplay({
  enabled = false, projectKey, ingestPoint,
  gatewayPath = ingestPoint === undefined ? defaultReplayGatewayPath : undefined,
}: OpenReplayOptions = {}): OpenReplay {
  let tracker: Tracker | undefined
  let privacyGuardFailed = false
  let generation = 0
  let pending: Promise<boolean> | undefined
  let cancelPending: (() => void) | undefined
  // A late rejection from an SDK handshake can stop its tracker. Never overlap two handshakes.
  let previous = Promise.resolve(false)

  const stopTracker = (instance = tracker) => {
    try { instance?.stop() } catch { console.error('Observability: OpenReplay could not stop cleanly') }
  }

  const checkpoint = () => {
    try { if (tracker?.isActive()) tracker.forceFlushBatch() } catch { /* SDK is already closing */ }
  }

  const stop = () => {
    checkpoint()
    generation++
    cancelPending?.()
    cancelPending = undefined
    pending = undefined
    stopTracker()
  }

  const activate = async (attempt: number): Promise<boolean> => {
    if (attempt !== generation || typeof projectKey !== 'string' || !projectKey.trim()) return false
    try {
      if (!browserAllowsReplay()) return false
      if (!tracker) {
        if (gatewayPath !== undefined && ingestPoint !== undefined) return false
        const endpoint = gatewayPath !== undefined ? await localReplayEndpoint(gatewayPath, projectKey.trim())
          : ingestPoint === undefined ? undefined : ingestEndpoint(ingestPoint)
        const [{ default: Tracker }, { replayOptions }, { protectReplayData }] = await Promise.all([
          import('@openreplay/tracker/class'),
          import('./openreplay-options.js'),
          import('./openreplay-privacy.js'),
        ])
        if (attempt !== generation || !browserAllowsReplay()) return false
        if ('__OPENREPLAY__' in window && window.__OPENREPLAY__) return false
        const instance = new Tracker({
          ...replayOptions(projectKey.trim(), endpoint),
          __DISABLE_SECURE_MODE: window.location.protocol === 'http:',
        })
        try {
          protectReplayData(instance)
        } catch {
          privacyGuardFailed = true
          stopTracker(instance)
          return false
        }
        tracker = instance
      }
      const { success } = await tracker.start({ forceNew: true })
      if (attempt !== generation) return false
      if (success && browserAllowsReplay()) return true
    } catch {
      // Missing optional peer, unsupported browser, storage restrictions or unavailable collector.
    }
    if (attempt === generation) stopTracker()
    return false
  }

  const start = (): Promise<boolean> => {
    if (enabled !== true || privacyGuardFailed || !browserAllowsReplay()) {
      stop()
      return Promise.resolve(false)
    }
    if (pending) return pending
    if (tracker?.isActive()) return Promise.resolve(true)

    const attempt = generation
    previous = previous.then(() => activate(attempt))
    // stop() settles the caller immediately, even while the SDK waits for a tab to become visible.
    const canceled = new Promise<boolean>(resolve => { cancelPending = () => resolve(false) })
    pending = Promise.race([previous, canceled]).finally(() => {
      if (attempt === generation) {
        pending = undefined
        cancelPending = undefined
      }
    })
    return pending
  }

  return {
    start, stop,
    deliveryStatus: () => gatewayPath ? replayDelivery('status') : Promise.resolve(null),
    retryDelivery: () => gatewayPath ? replayDelivery('retry') : Promise.resolve(null),
    install(app) {
      if (enabled && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        const onVisibility = () => { if (document.visibilityState === 'hidden') checkpoint() }
        window.addEventListener('pagehide', checkpoint)
        document.addEventListener('visibilitychange', onVisibility)
        app.onUnmount(() => {
          window.removeEventListener('pagehide', checkpoint)
          document.removeEventListener('visibilitychange', onVisibility)
        })
      }
      if (enabled && gatewayPath && typeof window !== 'undefined') {
        // Safari can flush on a foreground visit even without Background Sync.
        const foreground = () => { if (document.visibilityState !== 'hidden') wakeReplayGateway() }
        const timer = window.setInterval(foreground, 30_000)
        document.addEventListener('visibilitychange', foreground)
        window.addEventListener('online', wakeReplayGateway)
        window.addEventListener('pageshow', wakeReplayGateway)
        wakeReplayGateway()
        app.onUnmount(() => {
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', foreground)
          window.removeEventListener('online', wakeReplayGateway)
          window.removeEventListener('pageshow', wakeReplayGateway)
        })
      }
      app.onUnmount(stop)
    },
  }
}
