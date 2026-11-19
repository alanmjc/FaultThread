import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenReplayGateway } from '../dist/openreplay-offline.js'

const app = 'https://app.test'
const upstream = 'https://collector.test/ingest'
const base = app + '/__observability/openreplay'
const options = { projectKey: 'test-project', ingestPoint: upstream }

function environment(t) {
  const originals = new Map()
  const replace = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  const entries = new Map()
  const storage = {
    get length() { return entries.size },
    key: i => [...entries.keys()][i],
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  }
  const allCaches = new Map()
  const keyOf = input => typeof input === 'string' ? input : input.url
  replace('indexedDB', undefined)
  replace('localStorage', storage)
  replace('location', new URL(app))
  replace('navigator', { onLine: false })
  replace('caches', {
    async open(name) {
      if (!allCaches.has(name)) allCaches.set(name, new Map())
      const saved = allCaches.get(name)
      return {
        match: async key => saved.get(keyOf(key))?.clone(),
        put: async (key, response) => { saved.set(keyOf(key), response.clone()) },
        keys: async () => Array.from(saved.keys(), key => new Request(key)),
        delete: async key => saved.delete(keyOf(key)),
      }
    },
  })
  return { storage, replace }
}

const request = (route, body, headers = {}) => new Request(base + route, {
  method: 'POST', headers, body,
})
const start = () => request('/v1/web/start', JSON.stringify({
  projectKey: options.projectKey, doNotRecord: false, timestamp: 1234567, trackerVersion: '19.1.2',
}), { 'Content-Type': 'application/json' })

test('a fresh offline replay survives reopening and rebuilds its complete history when the remote token expires', async t => {
  const { replace } = environment(t)
  let gateway = createOpenReplayGateway(options)
  const initial = await gateway.handle(start(), 'document-client-id')
  assert.equal(initial.status, 200)
  const local = await initial.json()
  assert.equal(local.canvasEnabled, false)
  const header = { Authorization: 'Bearer ' + local.token, DataType: 'player', 'Content-Encoding': 'gzip' }
  const first = request('/v1/web/i?batch=0_1_3_kyes', Uint8Array.of(0, 3, 255), header)
  assert.equal((await gateway.handle(first)).status, 202)

  const startBodies = []
  const sent = []
  let restoring = true
  replace('fetch', async (url, init) => {
    assert.ok(url.startsWith(upstream))
    assert.equal(init.credentials, 'omit')
    assert.equal(init.redirect, 'error')
    if (url.endsWith('/start')) {
      startBodies.push(JSON.parse(init.body))
      return Response.json({ token: 'real-' + startBodies.length, sessionID: String(startBodies.length),
        userUUID: 'server-user', delay: 0, canvasEnabled: true, canvasFPS: 5, protocolVersion: 2 })
    }
    const token = init.headers.Authorization
    const bytes = [...init.body]
    if (token === 'Bearer real-1' && bytes[0] === 5) return new Response(null, { status: 401 })
    if (token === 'Bearer real-2' && bytes[0] === 8 && restoring) return new Response(null, { status: 503 })
    sent.push([token, bytes, init.headers.DataType, init.headers['Content-Type']])
    return new Response(null, { status: 204 })
  })

  gateway = createOpenReplayGateway(options)
  assert.equal(await gateway.flush(), true)
  assert.equal(startBodies[0].isOffline, true)
  assert.equal(startBodies[0].timestamp, 1234567)
  assert.equal((await gateway.handle(request('/v1/web/i?batch=1_1_3_kyes', Uint8Array.of(8), header))).status, 202)
  assert.equal(await gateway.flush(), true)
  const imageHeader = { Authorization: header.Authorization, 'Content-Type': 'multipart/form-data; boundary=fixture' }
  assert.equal((await gateway.handle(request('/v1/web/images', Uint8Array.of(5, 6), imageHeader))).status, 202)
  assert.equal(await gateway.flush(), false)
  let now = Date.now() + 5000
  t.mock.method(Date, 'now', () => now)
  assert.equal(await createOpenReplayGateway(options).flush(), false)
  now += 5000
  restoring = false
  assert.equal(await createOpenReplayGateway(options).flush(), true)
  assert.deepEqual(sent, [
    ['Bearer real-1', [0, 3, 255], 'player', undefined],
    ['Bearer real-1', [8], 'player', undefined],
    ['Bearer real-2', [0, 3, 255], 'player', undefined],
    ['Bearer real-2', [8], 'player', undefined],
    ['Bearer real-2', [5, 6], undefined, 'multipart/form-data; boundary=fixture'],
  ])
  assert.equal(startBodies.length, 2)
  assert.equal((await (await gateway.handle(start())).json()).canvasEnabled, true)
})

test('gateway restricts the destination and acknowledges accepted binary payloads only after durable storage', async t => {
  const { storage } = environment(t)
  const gateway = createOpenReplayGateway(options)
  assert.equal(gateway.handle(new Request('https://other.test/__observability/openreplay/ready')), undefined)
  assert.equal(gateway.handle(new Request(app + '/other')), undefined)
  const ready = await gateway.handle(new Request(base + '/ready'))
  assert.equal(ready.headers.get('X-Observability-OpenReplay'), '1')
  assert.equal((await ready.json()).projectKey, options.projectKey)
  assert.equal((await gateway.handle(new Request(base + '/ready', { headers: { Origin: 'https://third-party.test' } }))).status, 403)
  const { token } = await (await gateway.handle(start())).json()
  const headers = { Authorization: 'Bearer ' + token }
  storage.setItem = () => { throw Error('QuotaExceededError') }
  assert.equal((await gateway.handle(request('/v1/web/i', Uint8Array.of(9), headers))).status, 503)
  assert.deepEqual(await gateway.status(), { pending: 0, blocked: 0 })
})

test('collector policy refusal keeps the original offline packets blocked for an explicit retry', async t => {
  const { replace } = environment(t)
  const gateway = createOpenReplayGateway(options)
  const { token } = await (await gateway.handle(start())).json()
  const headers = { Authorization: 'Bearer ' + token }
  for (const n of [1, 2]) await gateway.handle(request('/v1/web/i', Uint8Array.of(n), headers))
  let attempts = 0
  replace('fetch', async () => { attempts++; return new Response(null, { status: 403 }) })
  assert.equal(await gateway.flush(), false)
  assert.equal(attempts, 1)
  assert.deepEqual(await gateway.status(), { pending: 0, blocked: 2 })
})

test('a permanently refused packet holds every following delta until an explicit ordered retry', async t => {
  const { replace } = environment(t)
  const gateway = createOpenReplayGateway(options)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const { token } = await (await gateway.handle(start())).json()
  const headers = { Authorization: 'Bearer ' + token }
  const submit = async n => {
    now++
    assert.equal((await gateway.handle(request('/v1/web/i', Uint8Array.of(n), headers))).status, 202)
  }
  await submit(1)
  await submit(2)
  let refuse = true
  const attempted = []
  replace('fetch', async (url, init) => {
    if (url.endsWith('/start')) return Response.json({ token: 'remote', sessionID: '12', userUUID: 'user', delay: 0 })
    attempted.push(init.body[0])
    return new Response(null, { status: refuse ? 422 : 200 })
  })
  assert.equal(await gateway.flush(), false)
  await submit(3)
  assert.equal(await createOpenReplayGateway(options).flush(), false)
  assert.deepEqual(attempted, [1])
  assert.deepEqual(await gateway.status(), { pending: 0, blocked: 3 })
  refuse = false
  await gateway.retryBlocked()
  assert.equal(await gateway.flush(), true)
  assert.deepEqual(attempted, [1, 1, 2, 3])
})

test('retirement waits for all page/worker clients, their grace period and packets arriving during cleanup', async t => {
  const { replace } = environment(t)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const period = 300001
  const clients = new Set(['page', 'worker'])
  let pause
  replace('clients', { async get(id) {
    if (pause) await pause()
    return clients.has(id) ? { id } : undefined
  } })
  replace('fetch', async url => url.endsWith('/start') ?
    Response.json({ token: 'remote', sessionID: '12', userUUID: 'user', delay: 0 }) : new Response(null, { status: 200 }))
  const gateway = createOpenReplayGateway(options)
  const { token } = await (await gateway.handle(start(), 'page')).json()
  const headers = { Authorization: 'Bearer ' + token }
  const submit = n => gateway.handle(request('/v1/web/i', Uint8Array.of(n), headers), 'worker')
  assert.equal((await submit(1)).status, 202)
  assert.equal(await gateway.flush(), true)
  clients.delete('page')
  now += period
  assert.equal(await gateway.flush(), true)
  clients.delete('worker')
  now += period
  assert.equal(await gateway.flush(), true)
  now += period
  let entered, release
  const inspecting = new Promise(resolve => { entered = resolve })
  const wait = new Promise(resolve => { release = resolve })
  pause = () => { entered(); return wait }
  const cleanup = gateway.flush()
  await inspecting
  const arriving = submit(2)
  release()
  pause = undefined
  assert.equal(await cleanup, false)
  assert.equal((await arriving).status, 202)
  assert.equal(await gateway.flush(), true)
  now += period
  assert.equal(await gateway.flush(), true)
  now += period
  assert.equal(await gateway.flush(), true)
  assert.equal((await submit(3)).status, 401)
  assert.deepEqual(await gateway.status(), { pending: 0, blocked: 0 })
})
