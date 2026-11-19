import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp, ref } from 'vue'
import axios, { AxiosError } from 'axios'
import * as Sentry from '@sentry/vue'
import { createObserver } from '@faultthread/vue'
import { observeAxios } from '@faultthread/vue/axios'
import { observeFetch } from '@faultthread/vue/fetch'
import { createObservedFetch } from '@faultthread/vue/vueuse'
import { sanitizeUrl, sanitizeMessage, sanitizeEvent, isReportableHttpFailure, isRequestId } from '@faultthread/vue/policy'

const memoryTransport = () => {
  const events = []
  const envelopes = []
  return {
    events, envelopes,
    transport: () => ({
      send(envelope) {
        envelopes.push(envelope)
        for (const [header, payload] of envelope[1])
          if (header.type === 'event') events.push(payload)
        return Promise.resolve({})
      },
      flush: () => Promise.resolve(true),
    }),
  }
}

test('privacy allow-list removes payloads, secrets, state and source context', () => {
  assert.equal(sanitizeUrl('https://user:pass@api.test/records/12?secret=yes#private'), 'https://api.test/records/:id')
  assert.equal(sanitizeUrl('/search/field%40example.invalid'), '/search/:redacted')
  assert.equal(sanitizeUrl('data:text/plain,private'), '[invalid URL]')
  assert.equal(sanitizeMessage('secret=private api_key=private'), 'secret=[redacted] api_key=[redacted]')
  const event = sanitizeEvent({
    user: { id: 0, email: 'field@example.invalid' },
    request: { url: '/records/42?token=private', data: 'private', headers: { Cookie: 'private' } },
    extra: { password: 'private' },
    contexts: { vue: { props: 'private' } },
    exception: { values: [{ value: 'token=private', stacktrace: { frames: [{ filename: '/app.js', lineno: 1, vars: { secret: 'private' }, pre_context: ['private'] }] } }] },
    tags: { request_id: 'id-42', unsafe: 'private' },
  }, 'other-app')
  assert.equal(JSON.stringify(event).includes('private'), false)
  assert.deepEqual(event.tags, { application: 'other-app', request_id: 'id-42' })
  assert.equal(event.user, undefined)
  assert.equal(event.request, undefined)
  assert.equal(event.exception.values[0].value, '[omitted]')
  for (const status of [400, 401, 403, 404, 409, 422, 429])
    assert.equal(isReportableHttpFailure({ status }), false)
  assert.equal(isReportableHttpFailure({ status: 503 }), true)
  assert.equal(isReportableHttpFailure({ status: 600 }), false)
  for (const text of [
    JSON.stringify({ password: 'prefix"private with spaces' }),
    'Cookie: first=id; session=private',
    'Authorization: Digest key="private", another="private"',
  ]) {
    const redacted = sanitizeMessage(text)
    assert.equal(redacted.includes('private'), false)
    assert.equal(sanitizeMessage(redacted), redacted)
  }
  assert.deepEqual(sanitizeEvent({ tags: { 'http.status_code': ['503'] } }, 'app').tags, { application: 'app' })
  const paths = sanitizeEvent({ exception: { values: [{ stacktrace: { frames: [
    { filename: 'https://app.test/account/private?session=private' },
    { filename: 'https://cdn.test/assets/app.js?session=private' },
  ] } }] } }, 'frontend').exception.values[0].stacktrace.frames
  assert.equal(paths[0].filename, undefined)
  assert.equal(paths[1].filename, 'https://cdn.test/assets/app.js')
  assert.equal(isReportableHttpFailure({ canceled: true }), false)
  for (const value of ['', 'invalid\n', 'invalid\r', 'x'.repeat(65), null, 42])
    assert.equal(isRequestId(value), false)
  assert.equal(isRequestId('x'.repeat(64)), true)
})

test('real SDK captures correlated HTTP errors once, cleans adapters and watches user', async () => {
  const transport = memoryTransport()
  const observer = createObserver({
    application: 'test-frontend', dsn: 'https://public@observer.invalid/1',
    privacy: { captureUserId: true },
    ...transport,
  })
  const app = createApp({})
  const originalHandler = () => {}
  app.config.errorHandler = originalHandler
  const userId = ref(42)
  let original
  const api = axios.create({
    adapter: async config => {
      const response = { status: 503, config, headers: { 'x-request-id': 'test-503' }, data: 'private' }
      original = new AxiosError('token=private', 'ERR_BAD_RESPONSE', config, undefined, response)
      throw original
    },
  })
  app.use(observer, {
    adapters: [observer => observeAxios(api, observer)],
    getUserId: () => userId.value,
  })
  await assert.rejects(api.get('/records/42?token=private'), error => error === original)
  observer.reportHttpFailure(original, { status: 503 })
  await Sentry.flush(1000)
  assert.equal(transport.events.length, 1)
  assert.equal(transport.events[0].tags.request_id, 'test-503')
  assert.equal(transport.events[0].tags.application, 'test-frontend')
  assert.equal(transport.events[0].tags['http.status_code'], '503')
  assert.equal(transport.events[0].user.id, '42')
  assert.equal(JSON.stringify(transport.events).includes('private'), false)
  userId.value = null
  observer.reportError(new Error('logout'))
  await Sentry.flush(1000)
  assert.equal(transport.events[1].user, undefined)
  await observer.close()
  assert.equal(observer.active, false)
  assert.equal(app.config.errorHandler, originalHandler)
  await assert.rejects(api.get('/records'))
  assert.equal(transport.events.length, 2)
})

test('the SDK applies independent disclosure options before sending an event', async () => {
  const transport = memoryTransport()
  const observer = createObserver({
    application: 'privacy-test', dsn: 'https://public@observer.invalid/1',
    privacy: { eventText: 'full', breadcrumbText: 'redact' },
    ...transport,
  })
  createApp({}).use(observer, { getUserId: () => assert.fail('User lookup was disabled') })
  try {
    observer.recordAction('Field: field@example.invalid')
    observer.reportError(new Error('Failure for REC-000123, field@example.invalid'))
    await Sentry.flush(1000)
    assert.equal(transport.events.length, 1)
    const [event] = transport.events
    assert.equal(event.exception.values[0].value, 'Failure for REC-000123, field@example.invalid')
    assert.equal(event.breadcrumbs.find(item => item.category === 'action').message, 'Field: [email redacted]')
    assert.equal(event.user, undefined)
  } finally {
    await observer.close()
  }
})

test('disabled observer is inert; invalid DSN and concurrent clients fail explicitly', async () => {
  const disabled = createObserver({ application: 'disabled' })
  createApp({}).use(disabled)
  assert.equal(disabled.active, false)
  await disabled.close()
  assert.throws(() => createApp({}).use(createObserver({ application: 'invalid', dsn: 'https://observer.invalid/no-project' })), /invalid DSN/)
  for (const dsn of ['invalid DSN', 'https://public:private@observer.invalid/1', 'https://public@observer.invalid/1?private',
    'http://public@observer.invalid/1', 'http://public@127.0.0.1.example.invalid/1', 'https://public@bad!host/private/1']) {
    assert.throws(() => createApp({}).use(createObserver({ application: 'invalid', dsn })), { message: 'FaultThread: invalid DSN' })
  }
  for (const host of ['localhost', 'localhost.', '127.0.0.42', '[::1]']) {
    const local = createObserver({ application: 'local', dsn: `http://public@${host}/1`, ...memoryTransport() })
    createApp({}).use(local)
    await local.close()
  }
  const first = createObserver({ application: 'first', dsn: 'https://public@observer.invalid/1', ...memoryTransport() })
  const second = createObserver({ application: 'second', dsn: 'https://public@observer.invalid/2', ...memoryTransport() })
  createApp({}).use(first)
  assert.throws(() => createApp({}).use(second), /active observer/)
  await first.close()
  createApp({}).use(second)
  await second.close()
})

test('adapter installation failure rolls back the SDK and prior adapters', async () => {
  const observer = createObserver({ application: 'failure', dsn: 'https://public@observer.invalid/1', ...memoryTransport() })
  let cleanupCount = 0
  assert.throws(() => createApp({}).use(observer, {
    adapters: [
      () => () => { cleanupCount++ },
      () => { throw new Error('adapter failed') },
    ],
  }), /adapter failed/)
  await observer.close()
  assert.equal(cleanupCount, 1)
  assert.equal(observer.active, false)
})

test('Vue errors use the SDK handler and unmount restores handlers, navigation and watchers', async () => {
  const transport = memoryTransport()
  const observer = createObserver({ application: 'vue-errors', dsn: 'https://public@observer.invalid/1', ...transport })
  const app = createApp({})
  let originalErrors = 0
  let unmounts = 0
  let cleanups = 0
  let navigate
  const handler = () => { originalErrors++ }
  const unmount = () => { unmounts++ }
  app.config.errorHandler = handler
  app.unmount = unmount
  app.use(observer, {
    router: {
      afterEach(callback) { navigate = callback; return () => { cleanups++ } },
      onError() { return () => { cleanups++ } },
    },
  })
  navigate({ matched: [{ path: '/records/:id' }] }, { matched: [{ path: '/' }] })
  app.config.errorHandler(new Error('Vue failure token=private'), null, 'render')
  await new Promise(resolve => setTimeout(resolve, 10))
  await Sentry.flush(1000)
  assert.equal(originalErrors, 1)
  assert.equal(transport.events.length, 1)
  assert.equal(JSON.stringify(transport.events).includes('private'), false)
  assert.ok(transport.events[0].breadcrumbs.some(item => item.category === 'navigation'))
  app.unmount()
  await observer.close()
  assert.equal(unmounts, 1)
  assert.equal(cleanups, 2)
  assert.equal(app.unmount, unmount)
  assert.equal(app.config.errorHandler, handler)
})

test('Axios preserves successful 5xx configured by validateStatus and reports it', async () => {
  const contexts = []
  const api = axios.create({
    adapter: async config => ({ status: 503, data: 'original', config, headers: {} }),
  })
  const cleanup = observeAxios(api, { recordRequest() {}, reportHttpFailure: (_, context) => contexts.push(context) })
  const response = await api.get('/records')
  assert.equal(response.data, 'original')
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].status, 503)
  cleanup()
})

test('observer callback failures never change Axios responses or rejection identity', async () => {
  const original = new Error('network')
  const api = axios.create({
    adapter: async config => {
      if (config.url === '/ok') return { status: 200, data: 'original', config, headers: {} }
      throw original
    },
  })
  const cleanup = observeAxios(api, {
    recordRequest() { throw new Error('observer failed') },
    reportHttpFailure() { throw new Error('observer failed') },
  })
  assert.equal((await api.get('/ok')).data, 'original')
  await assert.rejects(api.get('/fail'), error => error === original)
  cleanup()
})

test('VueUse retains reactive URLs, hooks, transformed errors and request correlation', async () => {
  const failures = []
  const urls = []
  const useApi = createObservedFetch({
    baseUrl: 'https://api.test',
    options: {
      immediate: false,
      fetch: async url => {
        urls.push(url)
        return new Response('original', { status: 503, headers: { 'x-request-id': 'vueuse-503' } })
      },
      onFetchError: ctx => ({ ...ctx, error: 'existing message' }),
    },
  }, { recordRequest() {}, reportHttpFailure: (error, context) => failures.push({ error, context }) })
  const url = ref('/one')
  const request = useApi(url)
  await request.execute()
  assert.equal(request.error.value, 'existing message')
  assert.equal(failures[0].context.requestId, 'vueuse-503')
  url.value = '/two'
  await request.execute()
  assert.deepEqual(urls, ['https://api.test/one', 'https://api.test/two'])
})

test('only sanitized error envelopes reach the transport, including SDK processing failures', async () => {
  const transport = memoryTransport()
  const observer = createObserver({ application: 'wire', dsn: 'https://public@observer.invalid/1', ...transport })
  createApp({}).use(observer)
  try {
    const scope = Sentry.getCurrentScope()
    scope.addAttachment({ filename: 'private.txt', data: 'private file' })
    scope.setExtra('arbitrary', 'private state')
    observer.reportError(new Error('private message'))
    await Sentry.flush(1000)
    Sentry.getClient().addEventProcessor(() => { throw new Error('private processor failure') })
    observer.reportError(new Error('trigger processing'))
    await Sentry.flush(1000)
    assert.equal(transport.events.length, 2)
    assert.deepEqual(transport.envelopes.map(([, items]) => items.map(([item]) => item.type)), [['event'], ['event']])
    assert.equal(JSON.stringify(transport.envelopes).includes('private'), false)
    assert.equal(transport.events[1].sdk.settings.infer_ip, 'never')
    assert.equal(transport.envelopes[0][0].trace, undefined)
  } finally {
    await observer.close()
  }
})

test('native fetch preserves input, body, response and abort reason', async () => {
  const original = new Request('https://api.test/failure', { method: 'POST', body: 'payload' })
  const response = new Response('original body', { status: 503, headers: { 'X-Request-Id': 'fetch-503' } })
  const recorded = []
  const reported = []
  const observer = {
    recordRequest: context => recorded.push(context),
    reportHttpFailure: (error, context) => reported.push({ error, context }),
  }
  const wrapped = observeFetch(async (input, init) => {
    assert.equal(input, original)
    assert.equal(init, undefined)
    return response
  }, observer)
  assert.equal(await wrapped(original), response)
  assert.equal(original.bodyUsed, false)
  assert.equal(await response.text(), 'original body')
  assert.equal(recorded.length, 1)
  assert.equal(reported[0].context.requestId, 'fetch-503')
  assert.equal(reported[0].context.method, 'POST')

  const canceled = new AbortController()
  canceled.abort(new Error('intentional cancellation'))
  const rejected = observeFetch(async () => { throw canceled.signal.reason }, observer)
  await assert.rejects(rejected('https://api.test', { signal: canceled.signal }), error => error === canceled.signal.reason)
  assert.equal(recorded.length, 2)
  assert.equal(reported.length, 1)
})

test('VueUse correlates overlapping executions while async error hooks are pending', async () => {
  let enteringHook, resumeHook
  const hookEntered = new Promise(resolve => { enteringHook = resolve })
  const hookGate = new Promise(resolve => { resumeHook = resolve })
  let call = 0
  const ids = []
  const useApi = createObservedFetch({
    options: { immediate: false, fetch: async () => assert.fail('Expected the per-call fetch implementation') },
  }, { recordRequest() {}, reportHttpFailure: (_, context) => ids.push(context.requestId) })
  const request = useApi('/race', {
    fetch: async () => new Response('', { status: 503, headers: { 'x-request-id': `id-${++call}` } }),
    async onFetchError(ctx) {
      if (ctx.response.headers.get('x-request-id') === 'id-1') {
        enteringHook()
        await hookGate
      }
      return ctx
    },
  })
  const first = request.execute()
  await hookEntered
  try {
    await request.execute()
  } finally {
    resumeHook()
    await first
  }
  assert.deepEqual(ids, ['id-1', 'id-2'])
})

test('closing flushes pending Vue errors and client processors stay with their own app', async () => {
  const a = memoryTransport()
  const b = memoryTransport()
  const app = createApp({})
  app.config.errorHandler = () => {}
  const first = createObserver({ application: 'first', dsn: 'https://public@first.invalid/1', ...a })
  const second = createObserver({ application: 'second', dsn: 'https://public@second.invalid/2', ...b })
  app.use(first)
  Sentry.getClient().addEventProcessor(event => {
    event.tags = { request_id: 'first-only' }
    return event
  })
  app.config.errorHandler(new Error('first'), null, 'render')
  await first.close()
  createApp({}).use(second)
  try {
    second.reportError(new Error('second'))
    await second.close()
    assert.equal(a.events.length, 1)
    assert.equal(a.events[0].tags.request_id, 'first-only')
    assert.equal(b.events.length, 1)
    assert.deepEqual(b.events[0].tags, { application: 'second' })
  } finally {
    await second.close()
  }
})

test('Axios observes each transport attempt before application interceptors retry or unwrap the response', async () => {
  const body = { status: 503, config: 'business data', message: 'original' }
  const failures = []
  const requests = []
  let attempts = 0
  const originalAdapter = async config => {
    assert.equal(config.adapter, originalAdapter)
    const response = { status: 503, config, headers: { 'X-ReQuEsT-ID': 'attempt-' + ++attempts }, data: body }
    if (attempts === 1) throw new AxiosError('retry me', 'ERR_BAD_RESPONSE', config, undefined, response)
    return response
  }
  const api = axios.create({ adapter: originalAdapter })
  api.interceptors.response.use(response => response.data, error => api.request(error.config))
  const cleanup = observeAxios(api, {
    recordRequest: context => requests.push(context.requestId),
    reportHttpFailure: (_, context) => failures.push(context.requestId),
  })
  try {
    assert.deepEqual(await api.get('/retry'), body)
    assert.deepEqual(requests, ['attempt-1', 'attempt-2'])
    assert.deepEqual(failures, requests)
  } finally {
    cleanup()
  }
  assert.deepEqual(await api.get('/after-cleanup'), body)
  assert.equal(requests.length, 2)
})

test('closing preserves later Vue hooks and retained hooks cannot report to a new client', async () => {
  const transport = memoryTransport()
  const observer = createObserver({ application: 'lifecycle', dsn: 'https://public@observer.invalid/1', ...transport })
  const previousApp = createApp({})
  const received = []
  let unmounted = 0
  previousApp.config.errorHandler = error => received.push(error)
  previousApp.unmount = () => { unmounted++ }
  previousApp.use(observer)
  const capture = previousApp.config.errorHandler
  const unmount = previousApp.unmount
  const laterHandler = (...args) => capture(...args)
  const laterUnmount = () => unmount()
  previousApp.config.errorHandler = laterHandler
  previousApp.unmount = laterUnmount
  await observer.close()
  assert.equal(previousApp.config.errorHandler, laterHandler)
  assert.equal(previousApp.unmount, laterUnmount)

  createApp({}).use(observer)
  try {
    const previousError = new Error('from the closed app')
    previousApp.config.errorHandler(previousError, null, 'render')
    previousApp.unmount()
    assert.deepEqual(received, [previousError])
    assert.equal(unmounted, 1)
    assert.equal(observer.active, true)
    observer.reportError(new Error('current app'))
    await observer.close()
    assert.equal(transport.events.length, 1)
  } finally {
    await observer.close()
  }
})

test('detached Axios adapters ignore in-flight responses and keep the original outcome', async () => {
  let finish, reject
  const api = axios.create({
    adapter: config => new Promise((resolve, fail) => {
      if (config.url === '/fail') reject = fail
      else finish = () => resolve({ data: 'ok', status: 503, headers: {}, config })
    }),
  })
  const calls = []
  const cleanup = observeAxios(api, {
    recordRequest: () => calls.push('request'),
    reportHttpFailure: () => calls.push('failure'),
  })
  const success = api.get('/success')
  const failure = api.get('/fail')
  cleanup()
  const original = new Error('unavailable')
  finish()
  reject(original)
  assert.equal((await success).data, 'ok')
  await assert.rejects(failure, error => error === original)
  assert.deepEqual(calls, [])
})
