import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { parse } from 'acorn'

const script = readFileSync(new URL('../dist/legacy/observer.js', import.meta.url), 'utf8')
const dsn = 'https://public@collector.example/sentry/42'

function browser(data, clock, result, previousHandler) {
  const requests = [], errors = [], headers = result.headers ?? {}
  const storage = data && {
    get length() { return data.size },
    key: i => [...data.keys()][i],
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  }
  class Request {
    open(method, url) { this.method = method; this.url = url }
    send(body) {
      requests.push({ method: this.method, url: this.url, body })
      this.status = result.status
      this.readyState = 4
      this.onreadystatechange()
    }
    getResponseHeader(name) { return headers[name] ?? null }
  }
  class Clock extends Date { static now() { return clock.now } }
  const window = {
    localStorage: storage, onerror: previousHandler,
    setTimeout() { return 1 }, clearTimeout() {},
  }
  const context = {
    window, XMLHttpRequest: Request, Date: Clock, Promise: undefined, Set: undefined, Map: undefined,
    Uint8Array: undefined, fetch: undefined, indexedDB: undefined, URL: undefined,
  }
  vm.runInNewContext(script, context)
  return { window, requests, errors, install: () => window.EventObservability.install({
    dsn, application: 'legacy-app', onDeliveryError: error => errors.push(error.message),
  }) }
}

test('the standalone classic artifact parses as ES5 and remains inert before installation', () => {
  parse(script, { ecmaVersion: 5, sourceType: 'script' })
  const previousHandler = () => true
  const app = browser(new Map(), { now: Date.now() }, { status: 200 }, previousHandler)
  assert.equal(app.window.onerror, previousHandler)
  for (const dsn of ['http://public@remote.example/1', 'https://public:secret@remote.example/1', 'https://public@remote.example/1?key=x']) {
    assert.throws(() => app.window.EventObservability.install({ application: 'legacy-app', dsn }), /Observability/)
  }
  assert.equal(app.requests.length, 0)
  const observer = app.install()
  assert.equal(app.install(), observer)
  assert.equal(app.window.onerror('private-message', 'private-url', 42, 3, new TypeError('private-error')), true)
  observer.flush()
  const event = JSON.parse(app.requests[0].body.split('\n')[2])
  assert.equal(event.exception.values[0].type, 'TypeError')
  assert.doesNotMatch(app.requests[0].body, /private/)
  observer.stop()
  assert.equal(app.window.onerror, previousHandler)
  assert.equal(observer.reportError(new Error()), null)
})

test('classic errors survive a new page with their original ID and respect collector rate limits', () => {
  const data = new Map(), clock = { now: Date.now() }
  const old = browser(data, clock, { status: 429, headers: { 'Retry-After': '60' } })
  const first = old.install()
  const id = first.reportError(new TypeError('secret'))
  first.flush()
  assert.match(id, /^[0-9a-f]{32}$/)
  assert.equal(old.requests[0].url, 'https://collector.example/sentry/api/42/envelope/?sentry_version=7&sentry_key=public')
  assert.equal(first.status().pending, 1)
  assert.doesNotMatch([...data.values()].join(''), /secret/)
  first.stop()

  const response = { status: 403 }
  const reopened = browser(data, clock, response)
  const second = reopened.install()
  second.flush()
  assert.equal(reopened.requests.length, 0)
  clock.now += 61_000
  second.flush()
  assert.equal(second.status().blocked, 1)
  assert.ok(reopened.errors.some(message => message.includes('HTTP 403')))
  response.status = 200
  second.retryBlocked()
  assert.equal(second.status().pending, 0)
  assert.equal(data.size, 0)
  assert.equal(old.requests[0].body, reopened.requests[1].body)
  assert.equal(JSON.parse(reopened.requests[1].body.split('\n')[2]).event_id, id)
  second.stop()
})

test('classic capture reports volatile fallback and quarantines corrupted persisted records', () => {
  const clock = { now: Date.now() }, response = { status: 0 }
  const page = browser(null, clock, response)
  const volatile = page.install()
  volatile.reportError()
  volatile.flush()
  assert.equal(volatile.status().memoryOnly, 1)
  assert.ok(page.errors.some(message => message.includes('memory')))
  response.status = 200
  clock.now += 65_000
  volatile.flush()
  assert.equal(volatile.status().memoryOnly, 0)
  volatile.stop()

  const data = new Map()
  const app = browser(data, clock, response)
  const observer = app.install()
  observer.reportError(new TypeError())
  const [key, value] = Array.from(data)[0]
  data.set(key, value.replace('TypeError', 'RangeError'))
  assert.equal(observer.status().blocked, 1)
  observer.retryBlocked()
  assert.equal(app.requests.length, 0)
  assert.equal(data.size, 1)
  observer.stop()
})

test('classic log events hide supplied text and keep their ID, time and severity across offline reload', () => {
  const data = new Map(), timestamp = 1700000000000, clock = { now: timestamp }
  const first = browser(data, clock, { status: 0 })
  const observer = first.install()
  const id = observer.reportLog('sensitive account data', 'warning')
  observer.flush()
  assert.match(id, /^[a-f0-9]{32}$/)
  assert.doesNotMatch([...data.values()].join(''), /sensitive/)
  assert.equal(observer.status().pending, 1)
  observer.stop()
  assert.equal(observer.reportLog('stopped'), null)

  clock.now += 61_000
  const reopened = browser(data, clock, { status: 200 })
  const resumed = reopened.install()
  resumed.flush()
  const body = reopened.requests[0].body
  assert.equal(body, first.requests[0].body)
  assert.doesNotMatch(body, /sensitive/)
  const event = JSON.parse(body.split('\n')[2])
  assert.equal(event.event_id, id)
  assert.equal(event.timestamp, timestamp / 1000)
  assert.equal(event.level, 'warning')
  assert.equal(event.message, 'Application event')
  assert.equal(event.exception, undefined)
  assert.equal(data.size, 0)

  resumed.reportLog('private')
  resumed.flush()
  assert.equal(JSON.parse(reopened.requests[1].body.split('\n')[2]).level, 'info')
  resumed.reportLog('private', 'fatal')
  const [key, value] = [...data][0]
  data.set(key, value.replace('"fatal"', '"info"'))
  resumed.flush()
  assert.equal(resumed.status().blocked, 1)
  assert.equal(reopened.requests.length, 2)
  resumed.stop()
})

test('the classic observer delivers an existing v1 exception with its original checksum', () => {
  const id = '00000000000000000000000000000001'
  const scope = 'legacy-app|https://collector.example/sentry/api/42/envelope/?sentry_version=7&sentry_key=public'
  const data = new Map([['event-observability-legacy-v1:' + encodeURIComponent(scope) + ':' + id,
    JSON.stringify({ id, timestamp: 1700000000000, kind: 'RangeError', check: 187845465, next: 0, attempts: 0, blocked: false })]])
  const page = browser(data, { now: 1700000001000 }, { status: 200 })
  const observer = page.install()
  observer.flush()
  const event = JSON.parse(page.requests[0].body.split('\n')[2])
  assert.equal(event.event_id, id)
  assert.equal(event.exception.values[0].type, 'RangeError')
  assert.equal(event.level, 'error')
  assert.equal(event.message, undefined)
  assert.equal(data.size, 0)
  observer.stop()
})
