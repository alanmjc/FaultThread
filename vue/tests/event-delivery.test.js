import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from 'vue'
import * as Sentry from '@sentry/vue'
import { createObserver } from '@event-observability/vue'
import { observeFetch } from '@event-observability/vue/fetch'
import { EventDelivery } from '../dist/event-delivery.js'

function fixture(t) {
  const data = new Map()
  const storage = {
    get length() { return data.size },
    key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  }
  for (const [key, value] of Object.entries({ localStorage: storage, indexedDB: undefined })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else delete globalThis[key] })
  }
  const diagnostics = []
  const install = (project = 1) => {
    const observer = createObserver({
      application: 'frontend', dsn: 'https://key@collector.invalid/' + project,
      onDeliveryError: error => diagnostics.push(error.message),
    })
    createApp({}).use(observer)
    return observer
  }
  return { data, storage, diagnostics, install }
}

test('sanitized Sentry errors survive reopening, stay within their DSN and retain their event ID and quota', async t => {
  const { data, install } = fixture(t)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const observed = { recordRequest() { assert.fail('collector request re-entered the observer') }, reportHttpFailure() { assert.fail('recursive capture') } }
  const requests = []
  let rateLimited = true
  t.mock.method(globalThis, 'fetch', observeFetch(async (url, request) => {
    requests.push({ url, request })
    return rateLimited ? new Response(null, { status: 429, headers: { 'Retry-After': '60' } }) : new Response(null, { status: 200 })
  }, observed))

  const first = install()
  const id = Sentry.captureException(new Error('private-message-fixture'))
  assert.equal(await Sentry.flush(2000), false)
  assert.equal(requests.length, 1)
  assert.equal(data.size, 1)
  assert.doesNotMatch([...data.values()].join(''), /private-message-fixture/)
  assert.deepEqual(await first.deliveryStatus(), { pending: 1, blocked: 0 })
  assert.equal(await first.close(), false)

  rateLimited = false
  const other = install(2)
  assert.deepEqual(await other.deliveryStatus(), { pending: 0, blocked: 0 })
  assert.equal(await other.close(), true)
  const reopened = install()
  try {
    assert.equal(await Sentry.flush(2000), false)
    assert.equal(requests.length, 1)
    now += 61_000
    assert.equal(await Sentry.flush(2000), true)
    assert.equal(requests.length, 2)
    assert.equal(requests[0].request.body, requests[1].request.body)
    const [header, type, event] = requests[1].request.body.split('\n').map(line => JSON.parse(line))
    assert.equal(type.type, 'event')
    assert.equal(header.event_id, id)
    assert.equal(event.event_id, id)
    assert.equal(requests[1].request.credentials, 'omit')
    assert.equal(requests[1].request.referrerPolicy, 'no-referrer')
    assert.match(requests[1].url, /\/api\/1\/envelope\//)
    assert.equal(data.size, 0)
  } finally { await reopened.close() }
})

test('important logs persist as independent events with their severity, privacy policy and stable ID', async t => {
  const { data, install } = fixture(t)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  let online = false
  let accepted
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    if (!online) throw new TypeError('offline')
    accepted = request.body.split('\n').map(line => JSON.parse(line))
    return new Response(null, { status: 200 })
  })
  const first = install()
  const id = first.reportLog('private business details', 'warning')
  assert.match(id, /^[0-9a-f]{32}$/)
  assert.equal(await first.close(), false)
  assert.doesNotMatch([...data.values()].join(''), /private business details/)
  online = true
  now += 60_000
  const reopened = install()
  try {
    assert.equal(await Sentry.flush(2000), true)
    assert.equal(accepted[2].event_id, id)
    assert.equal(accepted[2].level, 'warning')
    assert.equal(accepted[2].message, 'Application event')
    assert.equal(data.size, 0)
  } finally { await reopened.close() }
})

test('permanent collector failures remain visible and can be retried after repair', async t => {
  const { data, diagnostics, install } = fixture(t)
  let status = 403
  t.mock.method(globalThis, 'fetch', async () => new Response('private-server-message', { status }))
  const observer = install()
  try {
    observer.reportError(new Error('test'))
    assert.equal(await Sentry.flush(2000), false)
    assert.deepEqual(await observer.deliveryStatus(), { pending: 0, blocked: 1 })
    assert.ok(diagnostics.some(message => message.includes('HTTP 403')))
    assert.doesNotMatch(diagnostics.join(''), /private-server-message/)
    status = 200
    await observer.retryDelivery()
    assert.equal(await Sentry.flush(2000), true)
    assert.equal(data.size, 0)
  } finally { await observer.close() }
})

test('storage failure attempts direct delivery and retains a failed send in memory for recovery', async t => {
  const { storage, diagnostics, install } = fixture(t)
  let writable = false
  const original = storage.setItem
  t.mock.method(storage, 'setItem', (...args) => {
    if (!writable) throw new Error('quota exceeded')
    return original(...args)
  })
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(init.body)
    if (!writable) throw new TypeError('offline')
    return new Response(null, { status: 200 })
  })
  const observer = install()
  try {
    observer.reportError(new Error('test'))
    assert.equal(await Sentry.flush(2000), false)
    assert.equal(bodies.length, 1)
    assert.deepEqual(await observer.deliveryStatus(), { pending: 1, blocked: 0, memoryOnly: 1 })
    assert.ok(diagnostics.length > 0)
    writable = true
    await observer.retryDelivery()
    assert.equal(await Sentry.flush(2000), true)
    assert.deepEqual(bodies, [bodies[0], bodies[0]])
  } finally { await observer.close() }
})

test('a restricted service worker cannot cause a second, direct send of an already committed event', async t => {
  const { data } = fixture(t)
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else delete globalThis.navigator
  })
  const denied = () => { throw Error('service worker access denied') }
  const sends = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sends.push(init.body); return new Response() })
  for (const [i, navigator] of [
    { get serviceWorker() { return denied() } },
    { serviceWorker: { get controller() { return denied() } } },
    { serviceWorker: { controller: { postMessage: denied } } },
  ].entries()) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigator })
    const delivery = new EventDelivery('restricted', 'dsn', 'https://collector.invalid', assert.fail)
    await delivery.send([{ event_id: String(i) }, [[{ type: 'event' }, {}]]])
    assert.equal(data.size, 1)
    assert.equal(sends.length, i)
    assert.deepEqual(await delivery.status(), { pending: 1, blocked: 0 })
    assert.equal(await delivery.flush(), true)
    assert.equal(sends.length, i + 1)
  }
})
