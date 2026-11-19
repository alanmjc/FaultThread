import { workerDrain } from './worker-drain.js'
import { publicDsn } from './collector-url.js'
import { EventDelivery } from './event-delivery.js'

import { eventSyncTag } from './background-delivery.js'
type Extendable = Event & { waitUntil(work: Promise<unknown>): void }

// Supply the same trusted configuration as the page. No destination comes from a queued event.
export function installEventDeliveryWorker({ application, dsn }: { application: string; dsn: string }): void {
  if (!application.trim()) throw new TypeError('FaultThread: application is required')
  const canonical = publicDsn(dsn)
  const url = new URL(canonical)
  const key = url.username
  url.username = ''
  const parts = url.pathname.split('/')
  const project = parts.pop()
  url.pathname = parts.join('/') + '/api/' + project + '/envelope/'
  url.searchParams.set('sentry_key', key)
  url.searchParams.set('sentry_version', '7')
  const delivery = new EventDelivery(application, canonical, url.href, error => console.error(error.message))
  const drain = workerDrain(delivery)
  globalThis.addEventListener('activate', event => (event as Extendable).waitUntil(drain()))
  globalThis.addEventListener('sync', event => {
    if ((event as Event & { tag: string }).tag === eventSyncTag)
      (event as Extendable).waitUntil(drain().then(empty => {
        if (!empty) throw new Error('FaultThread: error delivery is still pending')
      }))
  })
  globalThis.addEventListener('message', event => {
    const message = event as MessageEvent & Extendable
    if (message.origin === location.origin && message.data?.channel === eventSyncTag)
      message.waitUntil(drain())
  })
}
