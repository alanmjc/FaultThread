import assert from 'node:assert/strict'
import test from 'node:test'
import { installOfflineAssets } from '../dist/offline-assets.js'

function harness(t, responder) {
  const origin = 'https://app.test'
  const events = new Map()
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
  const data = new Map()
  const calls = []
  replace('location', new URL(origin))
  replace('registration', { scope: origin + '/' })
  replace('addEventListener', (name, handler) => events.set(name, handler))
  replace('fetch', async (url, init) => {
    calls.push([url, init])
    return responder(url, init)
  })
  replace('caches', {
    keys: async () => [...data.keys()],
    delete: async name => data.delete(name),
    open: async name => {
      if (!data.has(name)) data.set(name, new Map())
      const cache = data.get(name)
      return {
        put: async (key, value) => cache.set(key, value.clone()),
        match: async key => cache.get(key)?.clone(),
      }
    },
  })
  return {
    origin, calls, data,
    dispatch(type, request) {
      let work
      events.get(type)?.({ request, waitUntil: p => { work = p }, respondWith: p => { work = p } })
      return work
    },
  }
}

const publicFile = (body, mime) => new Response(body, {
  headers: { 'cache-control': 'public, max-age=3600', 'content-type': mime },
})
const navigation = url => Object.defineProperty(new Request(url), 'mode', { value: 'navigate' })

test('precaches anonymous public files and serves the static shell only for explicit offline navigation', async t => {
  let online = true
  const fixture = harness(t, (url) => {
    if (!online) throw Error('offline')
    if (typeof url !== 'string') return new Response('personalized page', { headers: { 'cache-control': 'private' } })
    return url.endsWith('.html') ? publicFile('public site shell', 'text/html') :
      publicFile('public JavaScript', 'text/javascript')
  })
  installOfflineAssets({ version: 'v1', assets: ['/bundles/entry.123.js', '/bundles/replay.456.js'],
    navigationFallback: { shell: '/offline.123.html', paths: ['/app'] } })
  await fixture.dispatch('install')
  assert.equal(fixture.calls.length, 3)
  assert.ok(fixture.calls.every(([, init]) => init.credentials === 'omit' && init.mode === 'same-origin' && init.redirect === 'error'))
  const page = navigation(fixture.origin + '/app')
  assert.equal(await (await fixture.dispatch('fetch', page)).text(), 'personalized page')
  online = false
  assert.equal(await (await fixture.dispatch('fetch', page)).text(), 'public site shell')
  assert.equal(await (await fixture.dispatch('fetch', new Request(fixture.origin + '/bundles/replay.456.js'))).text(), 'public JavaScript')
  assert.equal(fixture.dispatch('fetch', navigation(fixture.origin + '/app?private=1')), undefined)
  assert.equal(fixture.dispatch('fetch', new Request(fixture.origin + '/__observability/openreplay/ready')), undefined)
  assert.equal(fixture.dispatch('fetch', new Request(fixture.origin + '/bundles/replay.456.js', { headers: { Authorization: 'Bearer x' } })), undefined)
  await fixture.dispatch('activate')
})

test('a partial or private manifest cannot activate and previous app caches are left intact', async t => {
  const fixture = harness(t, url => url.endsWith('public.js') ? publicFile('JS', 'text/javascript') :
    new Response('private', { headers: { 'content-type': 'text/javascript', 'cache-control': 'public', vary: 'Cookie' } }))
  fixture.data.set('host-pwa', new Map())
  installOfflineAssets({ version: 'next', assets: ['/public.js', '/private.js'] })
  await assert.rejects(fixture.dispatch('install'), /not explicitly public/)
  assert.deepEqual([...fixture.data.keys()], ['host-pwa'])
})

test('requires exact same-origin paths and rejects traversal, opaque, unmarked and private resources', async t => {
  let response
  const f = harness(t, () => response)
  for (const path of ['//other.test/main.js', 'https://other.test/a', '/dir/../app.js', '/x/%2e%2e/app.js',
    '/a%2fb.js', '/secret%252ejs', '/app.js?token=x', '/app.js#test']) {
    assert.throws(() => installOfflineAssets({ version: 'v', assets: [path] }), /exact same-origin/)
  }
  installOfflineAssets({ version: 'v', assets: ['/app.js'] })
  for (response of [
    new Response('x', { headers: { 'content-type': 'application/javascript' } }),
    new Response('x', { headers: { 'content-type': 'application/javascript', 'cache-control': 'public, private' } }),
    new Response('x', { headers: { 'content-type': 'application/javascript', 'cache-control': 'public, no-store' } }),
    publicFile('private html', 'text/html'),
    Object.defineProperty(publicFile('x', 'text/javascript'), 'type', { value: 'opaque' }),
    Object.defineProperty(publicFile('x', 'text/javascript'), 'redirected', { value: true }),
  ]) await assert.rejects(f.dispatch('install'), /not explicitly public/)
})
