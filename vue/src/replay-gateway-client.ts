import type { DeliveryStatus } from './outbox.js'
import { activeServiceWorker } from './background-delivery.js'

const channel = 'event-observability:openreplay'

export async function localReplayEndpoint(path: string, projectKey: string): Promise<string> {
  if (!path.startsWith('/') || path.startsWith('//') || !activeServiceWorker())
    throw new Error('Observability: a controlling replay service worker is required')
  const url = new URL(path, location.origin)
  if (url.origin !== location.origin || url.search || url.hash || url.pathname === '/')
    throw new Error('Observability: invalid replay gateway path')
  const endpoint = url.href.replace(/\/+$/, '')
  const response = await fetch(endpoint + '/ready', { cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })
  if (!response.ok || response.headers.get('X-Observability-OpenReplay') !== '1')
    throw new Error('Observability: replay gateway unavailable')
  const info = await response.json()
  if (info.protocol !== 1 || info.projectKey !== projectKey) throw new Error('Observability: replay gateway project mismatch')
  return endpoint
}

export function wakeReplayGateway(): void {
  try { activeServiceWorker()?.postMessage({ channel, action: 'flush' }) } catch { /* a worker can become redundant */ }
}

export function replayDelivery(action: 'status' | 'retry'): Promise<DeliveryStatus | null> {
  const worker = activeServiceWorker()
  if (!worker) return Promise.resolve(null)
  let ports: MessageChannel
  try { ports = new MessageChannel() } catch { return Promise.resolve(null) }
  return new Promise(resolve => {
    const { port1, port2 } = ports
    const finish = (status: DeliveryStatus | null) => { clearTimeout(timer); port1.close(); port2.close(); resolve(status) }
    const timer = setTimeout(() => finish(null), 12_000)
    port1.onmessage = event => finish(event.data)
    try { worker.postMessage({ channel, action }, [port2]) } catch { finish(null) }
  })
}
