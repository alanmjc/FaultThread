import assert from 'node:assert/strict'
import { test } from 'node:test'
import Tracker from '@openreplay/tracker/class'
import { createOpenReplay } from '@faultthread/vue/openreplay'
import { localReplayEndpoint, replayDelivery, wakeReplayGateway } from '../dist/replay-gateway-client.js'

const enabled = { enabled: true, projectKey: 'test-project' }
function browser(t) {
  globalThis.window = { location: new URL('https://app.example/'), navigator: {} }
  globalThis.document = { querySelector: () => null }
  t.after(() => { delete globalThis.window; delete globalThis.document })
}

test('recording requires a browser, explicit enablement, a project key and an allowed endpoint', async t => {
  const start = t.mock.method(Tracker.prototype, 'start')
  assert.equal(await createOpenReplay(enabled).start(), false)
  browser(t)
  assert.equal(await createOpenReplay({ projectKey: 'test-project' }).start(), false)
  assert.equal(await createOpenReplay({ enabled: true }).start(), false)
  // With just a project key, recording waits for the local durable gateway.
  assert.equal(await createOpenReplay(enabled).start(), false)
  for (const ingestPoint of ['http://ingest.example', 'https://user@ingest.example', 'https://ingest.example/?token=secret']) {
    assert.equal(await createOpenReplay({ ...enabled, ingestPoint }).start(), false)
  }
  const replay = createOpenReplay({ ...enabled, ingestPoint: 'https://replay.example/ingest' })
  window.navigator.doNotTrack = '1'
  assert.equal(await replay.start(), false)
  delete window.navigator.doNotTrack
  window.navigator.globalPrivacyControl = true
  assert.equal(await replay.start(), false)
  delete window.navigator.globalPrivacyControl
  window.location = new URL('http://app.example/')
  assert.equal(await replay.start(), false)
  assert.equal(start.mock.callCount(), 0)
})

test('unmount cancels a pending start and a regrant waits for the old handshake', async t => {
  browser(t)
  const app = { worker: { postMessage() {} }, attributeSender: { sendSetAttribute() {} }, send() {} }
  const protect = t.mock.method(Tracker.prototype, 'use', plugin => plugin(app))
  const stop = t.mock.method(Tracker.prototype, 'stop', () => {})
  const start = t.mock.method(Tracker.prototype, 'start', async () => ({ success: true }))
  let rejectFirst, signalStarted
  const entered = new Promise(resolve => { signalStarted = resolve })
  start.mock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    rejectFirst = reject
    signalStarted()
  }))

  const replay = createOpenReplay({ ...enabled, ingestPoint: 'https://replay.example/ingest' })
  let unmount
  replay.install({ onUnmount(cleanup) { unmount = cleanup } })
  assert.equal(start.mock.callCount(), 0)
  const initial = replay.start()
  assert.equal(replay.start(), initial)
  await entered
  unmount()
  assert.equal(await initial, false)
  const next = replay.start()
  await Promise.resolve()
  assert.equal(start.mock.callCount(), 1)
  rejectFirst(new Error('Canceled handshake'))
  assert.equal(await next, true)
  assert.equal(start.mock.callCount(), 2)
  assert.equal(stop.mock.callCount(), 1)
  assert.equal(protect.mock.callCount(), 1)
  assert.deepEqual(start.mock.calls[1].arguments, [{ forceNew: true }])

  replay.stop()
  start.mock.mockImplementationOnce(async () => ({ success: false }))
  assert.equal(await replay.start(), false)
  assert.equal(await replay.start(), true)
  assert.equal(protect.mock.callCount(), 1)
})

test('a failed privacy guard stops the instance before recording and blocks all retries', async t => {
  browser(t)
  const protect = t.mock.method(Tracker.prototype, 'use', plugin => plugin({ worker: null }))
  const stop = t.mock.method(Tracker.prototype, 'stop', () => {})
  const start = t.mock.method(Tracker.prototype, 'start')
  const replay = createOpenReplay({ ...enabled, ingestPoint: 'https://replay.example/ingest' })
  assert.equal(await replay.start(), false)
  assert.equal(await replay.start(), false)
  assert.equal(protect.mock.callCount(), 1)
  assert.equal(stop.mock.callCount(), 1)
  assert.equal(start.mock.callCount(), 0)
})

test('restricted or stopped service workers leave optional replay controls usable', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else delete globalThis.navigator
  })
  const denied = () => { throw Error('restricted worker') }
  const replace = value => Object.defineProperty(globalThis, 'navigator', { configurable: true, value })
  replace({ get serviceWorker() { return denied() } })
  assert.doesNotThrow(wakeReplayGateway)
  assert.equal(await replayDelivery('status'), null)
  await assert.rejects(localReplayEndpoint('/gateway', 'project'), /controlling replay service worker/)
  replace({ serviceWorker: { controller: { postMessage: denied } } })
  assert.doesNotThrow(wakeReplayGateway)
  assert.equal(await replayDelivery('retry'), null)
})
