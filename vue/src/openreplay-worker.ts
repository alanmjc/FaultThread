import { workerDrain } from './worker-drain.js'
import { createOpenReplayGateway } from './openreplay-offline.js'

type GatewayOptions = Parameters<typeof createOpenReplayGateway>[0]
type PendingEvent = Event & { waitUntil(promise: Promise<unknown>): void }
type WorkerHost = EventTarget & {
  clients: { claim(): Promise<void> }
  registration: { sync?: { register(tag: string): Promise<void> } }
}

export { createOpenReplayGateway }
export { installOfflineAssets, type OfflineAssetsOptions } from './offline-assets.js'
export { installEventDeliveryWorker } from './event-worker.js'

// Register on the site's own service worker. Other requests and caches belong to the host app.
export function installOpenReplayGateway(options: GatewayOptions): void {
  const host = globalThis as unknown as WorkerHost
  const gateway = createOpenReplayGateway(options)
  const drain = workerDrain(gateway)
  const syncTag = 'event-observability:openreplay'
  host.addEventListener('fetch', event => {
    const request = event as PendingEvent & { request: Request; clientId: string; respondWith(response: Promise<Response>): void }
    const result = gateway.handle(request.request, request.clientId)
    if (!result) return
    request.respondWith(result)
    if (request.request.method === 'POST') {
      request.waitUntil(result.then(async () => {
        if (!await drain()) await host.registration.sync?.register(syncTag)
      }).catch(() => {}))
    }
  })
  host.addEventListener('activate', event => {
    const activation = event as PendingEvent
    activation.waitUntil(Promise.all([host.clients.claim(), drain()]))
  })
  host.addEventListener('sync', event => {
    if ((event as Event & { tag: string }).tag === syncTag)
      (event as PendingEvent).waitUntil(drain().then(empty => {
        if (!empty) throw new Error('FaultThread: replay delivery is still pending')
      }))
  })
  host.addEventListener('message', event => {
    const message = event as MessageEvent & PendingEvent
    if (message.origin !== globalThis.location.origin || message.data?.channel !== syncTag) return
    const respond = async () => {
      if (message.data.action === 'retry') await gateway.retryBlocked()
      message.ports[0]?.postMessage(await gateway.status())
      if (message.data.action === 'retry' || message.data.action === 'flush') await drain()
    }
    message.waitUntil(respond().catch(() => message.ports[0]?.postMessage(null)))
  })
}
