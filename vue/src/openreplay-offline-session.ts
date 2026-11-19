import type { DeliveryResult } from './outbox.js'

export interface ReplayPacket {
  token: string
  resource: 'i' | 'images'
  query: string
  headers: Record<string, string>
  body: string
}
export interface ReplaySession {
  token: string
  owner: string
  opened: Record<string, unknown> & { timestamp: number }
  credentials?: { token: string; sessionID: string }
  local: Record<string, unknown>
  rejected?: string
  recoverFrom?: number
  touched: number
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

export function pack(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 8192)
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192))
  return btoa(binary)
}

export async function packetKey(packet: ReplayPacket): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(packet))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, n => n.toString(16).padStart(2, '0')).join('')
}

export function transient(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function outcome(response: Response): DeliveryResult {
  if (response.ok) return { state: 'ack' }
  if (!transient(response.status)) return { state: 'blocked', reason: 'OpenReplay HTTP ' + response.status }
  const retry = response.headers.get('retry-after')
  const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 0
  return { state: 'retry', afterMs: Number.isFinite(delay) ? Math.max(0, delay) : undefined }
}

// This cache contains only the accepted history needed to reconstruct a replay if its ingest token expires.
// Pending packets live in the outbox until a verified HTTP acknowledgement.
export class ReplaySessions {
  private lastCollection = 0
  private get cache() { return caches.open(this.cacheName) }
  constructor(private readonly base: string, private readonly upstream: string, private readonly cacheName: string) {}

  private sessionUrl(token: string) { return this.base + '/session/' + token }
  private archiveUrl(token: string) { return this.base + '/archive/' + token + '/' }
  private ownersUrl(token: string) { return this.base + '/owners/' + token + '/' }

  async observeOwner(session: ReplaySession, owner: string): Promise<void> {
    if (!owner || owner === session.owner) return
    // A dedicated worker or a reopened page can still emit even after the original document closes.
    const cache = await this.cache
    const url = this.ownersUrl(session.token) + encodeURIComponent(owner)
    if (!await cache.match(url)) await cache.put(url, json(owner))
  }

  async load(token: string): Promise<ReplaySession | undefined> {
    const saved = await (await this.cache).match(this.sessionUrl(token))
    return saved && await saved.json()
  }

  async save(session: ReplaySession): Promise<void> {
    session.touched = Date.now()
    await (await this.cache).put(this.sessionUrl(session.token), json(session))
  }

  private async reject(session: ReplaySession, reason: string): Promise<DeliveryResult> {
    session.rejected = reason
    await this.save(session)
    return { state: 'blocked', reason }
  }

  async profile(): Promise<Record<string, unknown>> {
    const saved = await (await this.cache).match(this.base + '/capabilities')
    return saved ? await saved.json() : { protocolVersion: 1, canvasEnabled: false }
  }

  private async request(path: string, headers: Record<string, string>, body: BodyInit, timeout: number): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetch(this.upstream + '/v1/web/' + path, {
        method: 'POST', headers, body, credentials: 'omit', cache: 'no-store',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      })
      // A collector may send its headers and then stall. Keep the timeout through the handshake body too.
      const bodyText = path === 'start' && response.ok ? await response.text() : null
      if (bodyText === null) void response.body?.cancel().catch(() => {})
      return new Response(bodyText, { status: response.status, headers: response.headers })
    } finally { clearTimeout(timer) }
  }

  async connect(session: ReplaySession, deferred: boolean): Promise<DeliveryResult> {
    const response = await this.request('start', { 'Content-Type': 'application/json' },
      JSON.stringify({ ...session.opened, isOffline: deferred }), deferred ? 15000 : 2500)
    if (!response.ok) {
      const result = outcome(response)
      if (deferred && result.state === 'blocked') return this.reject(session, result.reason)
      return result
    }
    const remote = await response.json().catch(() => null)
    if (typeof remote?.token !== 'string' || !remote.token || typeof remote.sessionID !== 'string' ||
        !remote.sessionID || typeof remote.userUUID !== 'string' || typeof remote.delay !== 'number') {
      const reason = 'OpenReplay returned an invalid session handshake'
      return deferred ? this.reject(session, reason) : { state: 'blocked', reason }
    }

    const capture: Record<string, unknown> = {}
    for (const key of ['protocolVersion', 'canvasEnabled', 'canvasQuality', 'canvasFPS', 'framesSupport',
      'beaconSizeLimit', 'compressionThreshold', 'assistOnly', 'projectID']) {
      if (remote[key] !== undefined) capture[key] = remote[key]
    }
    session.credentials = { token: remote.token, sessionID: remote.sessionID }
    if (!deferred) Object.assign(session.local, capture, { delay: remote.delay, startTimestamp: remote.startTimestamp })
    await this.save(session)
    await (await this.cache).put(this.base + '/capabilities', json(capture))
    return { state: 'ack' }
  }

  private async transmit(packet: ReplayPacket, token: string): Promise<Response> {
    const bytes = Uint8Array.from(atob(packet.body), char => char.charCodeAt(0))
    return this.request(packet.resource + packet.query,
      { ...packet.headers, Authorization: 'Bearer ' + token }, bytes, 30000)
  }

  private async transmitForSession(packet: ReplayPacket, session: ReplaySession): Promise<DeliveryResult> {
    if (!session.credentials) return { state: 'retry' }
    const response = await this.transmit(packet, session.credentials.token)
    if (response.status !== 401) {
      const result = outcome(response)
      if (result.state === 'blocked') return this.reject(session, result.reason)
      return result
    }
    // A delta alone cannot reconstruct the page. Replace the expired session with a full ordered copy.
    delete session.credentials
    session.recoverFrom = 0
    await this.save(session)
    return { state: 'retry' }
  }

  async deliver(packet: ReplayPacket, key: string): Promise<DeliveryResult> {
    const session = await this.load(packet.token)
    if (!session) return { state: 'blocked', reason: 'OpenReplay session metadata missing' }
    if (session.rejected) return { state: 'blocked', reason: session.rejected }
    if (!session.credentials) {
      const started = await this.connect(session, true)
      if (started.state !== 'ack') return started
    }
    const cache = await this.cache
    const prefix = this.archiveUrl(session.token)
    if (session.recoverFrom !== undefined) {
      // Cache.keys preserves insertion order. Checkpoint after every real 2xx, also across worker restarts.
      const history = (await cache.keys()).filter(request => request.url.startsWith(prefix))
      for (let i = session.recoverFrom; i < history.length; i++) {
        const saved = await cache.match(history[i])
        if (!saved) return this.reject(session, 'OpenReplay session history missing')
        const prior: ReplayPacket = await saved.json()
        if (prefix + await packetKey(prior) !== history[i].url)
          return this.reject(session, 'OpenReplay session history checksum mismatch')
        const delivered = await this.transmitForSession(prior, session)
        if (delivered.state !== 'ack') return delivered
        session.recoverFrom = i + 1
        await this.save(session)
      }
      delete session.recoverFrom
      await this.save(session)
    }
    if (await cache.match(prefix + key)) return { state: 'ack' }
    const delivered = await this.transmitForSession(packet, session)
    if (delivered.state === 'ack') {
      await cache.put(prefix + key, json(packet))
      await this.save(session)
    }
    return delivered
  }

  async retryRejected(): Promise<void> {
    const cache = await this.cache
    for (const request of await cache.keys()) {
      if (!request.url.startsWith(this.base + '/session/')) continue
      const saved = await cache.match(request)
      if (!saved) continue
      const session: ReplaySession = await saved.json()
      if (session.rejected) {
        delete session.rejected
        await this.save(session)
      }
    }
  }

  collectionDue(): boolean { return Date.now() - this.lastCollection >= 300000 }

  private async clearHistory(cache: Cache, keys: readonly Request[], token: string, absent: string): Promise<void> {
    const history = this.archiveUrl(token)
    const owners = this.ownersUrl(token)
    await Promise.all(keys.filter(request => request.url.startsWith(history) || request.url.startsWith(owners))
      .map(request => cache.delete(request)))
    await cache.delete(absent)
  }

  async collect(quiet: () => boolean): Promise<void> {
    if (!this.collectionDue()) return
    this.lastCollection = Date.now()
    const clients = (globalThis as typeof globalThis & { clients?: { get(id: string): Promise<unknown> } }).clients
    if (!clients) return
    const cache = await this.cache
    const keys = await cache.keys()
    const markers = this.base + '/absent/'
    for (const key of keys.filter(request => request.url.startsWith(markers))) {
      const token = key.url.slice(markers.length)
      // Resume a cleanup interrupted after the metadata had been retired but before the history was deleted.
      if (!await cache.match(this.sessionUrl(token))) await this.clearHistory(cache, keys, token, key.url)
    }
    for (const key of keys.filter(request => request.url.startsWith(this.base + '/session/'))) {
      const response = await cache.match(key)
      if (!response) continue
      const session: ReplaySession = await response.json()
      if (!session.owner || !session.credentials || session.rejected || session.recoverFrom !== undefined) continue
      const owners = this.ownersUrl(session.token)
      const others = keys.filter(request => request.url.startsWith(owners))
      const clientIds = [session.owner, ...others.map(request => decodeURIComponent(request.url.slice(owners.length)))]
      const absent = markers + session.token
      const marker = await cache.match(absent)
      if ((await Promise.all(clientIds.map(id => clients.get(id)))).some(Boolean)) {
        if (marker) await cache.delete(absent)
        continue
      }
      // Start the grace period when every owner disappears. An idle page may have been open for hours.
      const goneAt = marker ? Number(await marker.text()) : 0
      if (!goneAt || goneAt < session.touched) {
        await cache.put(absent, json(Date.now()))
        continue
      }
      if (Date.now() - goneAt < 300000 || !quiet()) continue
      // Seal admission first so cleanup interrupted by worker shutdown cannot admit an orphan delta.
      await cache.delete(key)
      await this.clearHistory(cache, keys, session.token, absent)
    }
  }
}
