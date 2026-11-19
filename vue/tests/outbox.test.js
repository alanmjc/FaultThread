import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { DurableOutbox } from '../dist/outbox.js'
import { IndexedStore } from '../dist/outbox-store.js'

const db = new IDBFactory()
const ack = async () => ({ state: 'ack' })
function indexed(t) {
  t.mock.method(globalThis, 'fetch', () => { throw Error('real network disabled') })
  Object.defineProperty(globalThis, 'indexedDB', { value: db, configurable: true })
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true })
  t.after(() => { delete globalThis.indexedDB; delete globalThis.IDBKeyRange })
}

test('a committed write survives reopening, duplicate IDs and concurrent drainers', async t => {
  indexed(t)
  const delivered = []
  const send = async (item, key) => { await new Promise(r => setTimeout(r, 6)); delivered.push([item, key]); return { state: 'ack' } }
  const producer = new DurableOutbox('collector-A', send)
  const reader = new DurableOutbox('collector-A', send)
  const other = new DurableOutbox('collector-B', send)
  await producer.put('first', { safe: 1 })
  await producer.put('first', { safe: 1 })
  await producer.put('second', { safe: 2 })
  assert.deepEqual(await other.status(), { pending: 0, blocked: 0 })
  await Promise.all([producer.flush(), reader.flush()])
  assert.deepEqual(delivered, [[{ safe: 1 }, 'first'], [{ safe: 2 }, 'second']])
  assert.deepEqual(await reader.status(), { pending: 0, blocked: 0 })
})

test('temporary and permanent collector responses retain events until accepted', async t => {
  indexed(t)
  const blocked = new DurableOutbox('blocked', async () => ({ state: 'blocked', reason: 'HTTP 401' }), () => {})
  await blocked.put('a', 'payload')
  assert.equal(await blocked.flush(), false)
  assert.deepEqual(await blocked.status(), { pending: 0, blocked: 1 })
  const recovered = new DurableOutbox('blocked', ack)
  await recovered.retryBlocked()
  assert.equal(await recovered.flush(), true)
  const down = new DurableOutbox('down', async () => ({ state: 'retry', afterMs: 60_000 }))
  await down.put('b', 'body')
  assert.equal(await down.flush(), false)
  assert.deepEqual(await down.status(), { pending: 1, blocked: 0 })
})

test('IndexedDB integrity failures leave the FIFO open and a thrown transport error remains retryable', async t => {
  indexed(t)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const stream = 'damaged-indexed'
  const store = new IndexedStore(stream)
  const base = { stream, created: now, attempts: 0, state: 'pending', next: 0 }
  await store.put({ ...base, key: 'broken-checksum', body: 'null', digest: null })
  // An empty string has a valid CRC32 of zero but cannot be parsed as JSON.
  await store.put({ ...base, key: 'broken-body', body: '', digest: 'crc32:0' })
  const sent = []
  const box = new DurableOutbox(stream, async payload => {
    sent.push(payload)
    if (sent.length === 1) throw Error('connection interrupted')
    return { state: 'ack' }
  }, () => {})
  await box.put('valid', 'event')
  assert.equal(await box.flush(), false)
  assert.deepEqual(sent, ['event'])
  assert.deepEqual(await box.status(), { pending: 1, blocked: 2 })
  now += 2000
  assert.equal(await box.flush(), false)
  assert.deepEqual(sent, ['event', 'event'])
  assert.deepEqual(await box.status(), { pending: 0, blocked: 2 })
  const held = []
  await store.visit('blocked', record => { held.push([record.key, record.body, record.digest]) })
  assert.deepEqual(held, [['broken-checksum', 'null', null], ['broken-body', '', 'crc32:0']])
})

test('the localStorage fallback verifies payloads and retains corrupted records for inspection', async t => {
  const data = new Map()
  const storage = {
    get length() { return data.size }, key: i => [...data.keys()][i] ?? null,
    getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k),
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  t.after(() => delete globalThis.localStorage)
  let sends = 0
  const box = new DurableOutbox('legacy', async () => { sends++; return { state: 'ack' } }, () => {})
  await box.put('original', 'private-safe-body')
  const [[key, original]] = data
  data.set(key, original.replace('private-safe-body', 'other-body'))
  assert.equal(await box.flush(), false)
  assert.equal(sends, 0)
  assert.deepEqual(await box.status(), { pending: 0, blocked: 1 })
  assert.equal(JSON.parse(data.get(key)).reason, 'checksum mismatch')
})

test('lack of durable storage is a visible failure and cannot acknowledge a write', async () => {
  const reports = []
  const box = new DurableOutbox('unavailable', ack, err => reports.push(err.message))
  await assert.rejects(box.put('missing', { field: 'body' }), /storage/)
  assert.equal(await box.flush(), false)
  assert.equal(reports.length, 1)
})

test('malformed local records are counted as blocked, never modified and cannot stop neighboring deliveries', async t => {
  const data = new Map()
  const storage = {
    get length() { return data.size }, key: i => [...data.keys()][i] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key),
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  t.after(() => delete globalThis.localStorage)
  const sent = []
  const box = new DurableOutbox('malformed', async payload => { sent.push(payload); return { state: 'ack' } }, () => {})
  await box.put('broken', 'old')
  const [[key, original]] = data
  const template = JSON.parse(original)
  const prefix = key.slice(0, -'broken'.length)
  const damaged = new Map([
    [key, '{truncated'],
    [prefix + 'empty', 'null'],
    [prefix + 'partial', '{"state":"pending"}'],
    [prefix + 'impostor', original],
    [prefix + 'body', JSON.stringify({ ...template, key: 'body', body: 'not JSON' })],
    [prefix + 'checksum', JSON.stringify({ ...template, key: 'checksum', digest: 'future:unknown' })],
    [prefix + 'attempts', JSON.stringify({ ...template, key: 'attempts', attempts: 'zero' })],
  ])
  for (const [name, bytes] of damaged) data.set(name, bytes)
  await box.put('healthy', 'new')
  assert.deepEqual(await box.status(), { pending: 1, blocked: damaged.size })
  assert.equal(await box.flush(), false)
  assert.deepEqual(sent, ['new'])
  await box.retryBlocked()
  await assert.rejects(box.put('broken', 'replacement'), /storage/)
  assert.deepEqual(await box.status(), { pending: 0, blocked: damaged.size })
  assert.deepEqual(data, damaged)
})

test('status waits for writes and a failing IndexedDB does not prevent retrying the fallback', async t => {
  indexed(t)
  const data = new Map()
  const storage = {
    get length() { return data.size }, key: i => [...data.keys()][i] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key),
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  t.after(() => delete globalThis.localStorage)
  let available = false
  let release
  const stall = new Promise(resolve => { release = resolve })
  for (const name of ['put', 'count', 'visit']) {
    const original = IndexedStore.prototype[name]
    t.mock.method(IndexedStore.prototype, name, async function (...args) {
      if (available) return original.apply(this, args)
      await stall
      throw Error('IndexedDB restricted')
    })
  }
  const sent = []
  let repaired = false
  const box = new DurableOutbox('alternate', async payload => {
    sent.push(payload)
    return repaired ? { state: 'ack' } : { state: 'blocked', reason: 'test refusal' }
  }, () => {})
  const writing = box.put('one', 'payload')
  const reading = box.status()
  release()
  assert.deepEqual(await reading, { pending: 1, blocked: 0, unavailable: true })
  await writing
  assert.equal(await box.flush(), false)
  assert.deepEqual(await box.status(), { pending: 0, blocked: 1, unavailable: true })
  repaired = true
  await box.retryBlocked()
  assert.deepEqual(await box.status(), { pending: 1, blocked: 0, unavailable: true })
  assert.equal(await box.flush(), false)
  assert.equal(data.size, 0)
  available = true
  assert.equal(await box.flush(), true)
  assert.deepEqual(sent, ['payload', 'payload'])
})
