export interface OfflineAssetsOptions {
  version: string
  assets: readonly string[]
  navigationFallback?: { shell: string; paths: readonly string[] }
}

type WorkerEvent = Event & { waitUntil(work: Promise<unknown>): void }
type FetchEvent = WorkerEvent & { request: Request; respondWith(response: Promise<Response>): void }
type Worker = EventTarget & { registration: { scope: string } }

function localPath(path: string, origin: string): string {
  const decoded = decodeURIComponent(path)
  if (!path.startsWith('/') || path.startsWith('//') || /[?#\\\x00-\x1f]|%(2f|5c|25)/i.test(path) ||
      decoded.split('/').some(segment => segment === '.' || segment === '..'))
    throw new TypeError('FaultThread: expected an exact same-origin asset path')
  const url = new URL(path, origin)
  if (url.origin !== origin) throw new TypeError('FaultThread: invalid asset origin')
  return url.href
}

function publicAsset(response: Response, html: boolean): boolean {
  const directives = (response.headers.get('cache-control') ?? '').toLowerCase().split(',').map(value => value.split('=')[0].trim())
  const vary = (response.headers.get('vary') ?? '').toLowerCase().split(',').map(value => value.trim())
  const mime = (response.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim()
  return response.status === 200 && !response.redirected && (response.type === 'basic' || response.type === 'default') &&
    directives.includes('public') && !directives.some(value => ['private', 'no-store', 'no-cache'].includes(value)) &&
    !vary.some(name => ['*', 'cookie', 'authorization', 'proxy-authorization'].includes(name)) &&
    !response.headers.has('set-cookie') && !response.headers.has('www-authenticate') &&
    (html ? mime === 'text/html' :
      ['text/javascript', 'application/javascript', 'application/x-javascript', 'text/css', 'application/wasm',
        'application/json', 'application/font-woff'].includes(mime) || mime.startsWith('image/') || mime.startsWith('font/'))
}

// Install in an existing service worker. Only resources explicitly declared public by the host are stored.
export function installOfflineAssets({ version, assets, navigationFallback }: OfflineAssetsOptions): void {
  if (!version.trim() || (!assets.length && !navigationFallback)) throw new TypeError('FaultThread: missing public asset manifest')
  const host = globalThis as unknown as Worker
  const origin = globalThis.location.origin
  const approved = new Set(assets.map(path => localPath(path, origin)))
  const shell = navigationFallback && localPath(navigationFallback.shell, origin)
  if (shell && !new URL(shell).pathname.toLowerCase().endsWith('.html')) throw new TypeError('FaultThread: expected a static HTML shell')
  if (shell) approved.add(shell)
  const pages = new Set(navigationFallback?.paths.map(path => localPath(path, origin)))
  const prefix = 'event-observability:public-assets:' + encodeURIComponent(host.registration.scope) + ':'
  const name = prefix + version
  const marker = origin + '/.event-observability-assets-manifest'
  if (approved.has(marker)) throw new TypeError('FaultThread: reserved asset manifest path')
  const manifest = JSON.stringify(Array.from(approved).sort())

  host.addEventListener('install', event => {
    const install = event as WorkerEvent
    const prepare = async () => {
      const cache = await caches.open(name)
      const previous = await cache.match(marker)
      if (previous) {
        if (await previous.text() !== manifest) throw new Error('FaultThread: change the asset version when updating the manifest')
        return
      }
      try {
        // Stream one file at a time into the new cache. The old worker retains its complete version.
        for (const url of approved) {
          const response = await fetch(url, { credentials: 'omit', mode: 'same-origin', redirect: 'error',
            referrerPolicy: 'no-referrer', cache: 'reload' })
          if (!publicAsset(response, url === shell)) throw new Error('FaultThread: asset is not explicitly public and cacheable')
          await cache.put(url, response)
        }
        await cache.put(marker, new Response(manifest))
      } catch (error) {
        await caches.delete(name)
        throw error
      }
    }
    install.waitUntil(prepare())
  })

  host.addEventListener('activate', event => {
    const activate = event as WorkerEvent
    const clean = async () => {
      for (const old of await caches.keys()) if (old.startsWith(prefix) && old !== name) await caches.delete(old)
    }
    activate.waitUntil(clean())
  })

  host.addEventListener('fetch', event => {
    const fetchEvent = event as FetchEvent
    const { request } = fetchEvent
    if (request.method !== 'GET' || request.headers.has('authorization') || request.headers.has('range')) return
    if (request.mode === 'navigate') {
      if (!shell || !pages.has(request.url)) return
      const navigate = async () => {
        try { return await fetch(request) }
        catch (error) {
          const fallback = await (await caches.open(name)).match(shell)
          if (!fallback) throw error
          return fallback
        }
      }
      fetchEvent.respondWith(navigate())
    } else if (approved.has(request.url)) {
      const resource = async () => (await (await caches.open(name)).match(request.url)) ?? fetch(request)
      fetchEvent.respondWith(resource())
    }
  })
}
