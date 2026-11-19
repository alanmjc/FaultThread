import { defaultReplayGatewayPath, usesSecureTransport } from './collector-url.js'
import { DurableOutbox } from './outbox.js'
import { ReplaySessions, json, pack, packetKey, type ReplayPacket, type ReplaySession } from './openreplay-offline-session.js'

export interface OpenReplayGatewayOptions {
  projectKey: string
  ingestPoint: string
  path?: string
}

const virtualPrefix = 'or-local-'
const tokenPattern = /^or-local-[a-f0-9]{32}$/
const dataTypes = new Set(['player', 'assets', 'visual', 'devtools', 'analytics', 'all'])

function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('')
}

export function createOpenReplayGateway({ projectKey, ingestPoint, path = defaultReplayGatewayPath }: OpenReplayGatewayOptions) {
  const base = new URL(path, globalThis.location.origin)
  const destination = new URL(ingestPoint)
  if (!projectKey || !path.startsWith('/') || path.startsWith('//') || base.origin !== location.origin ||
      base.search || base.hash || base.pathname === '/' || !usesSecureTransport(destination) ||
      destination.username || destination.password || destination.search || destination.hash)
    throw new TypeError('FaultThread: invalid OpenReplay gateway configuration')
  const local = base.href.replace(/\/+$/, '')
  const remote = destination.href.replace(/\/+$/, '')
  if (local === remote) throw new TypeError('FaultThread: recursive OpenReplay gateway')
  const stream = JSON.stringify(['openreplay', local, remote, projectKey])
  const sessions = new ReplaySessions(local, remote, stream + ':sessions')
  const queue = new DurableOutbox<ReplayPacket>(stream, (packet, key) => sessions.deliver(packet, key))

  let lastWrite: Promise<unknown> = Promise.resolve()
  let arrivals = 0

  function sequence<T>(operation: () => Promise<T>): Promise<T> {
    const result = lastWrite.then(operation)
    lastWrite = result.catch(() => {})
    return result
  }

  async function open(request: Request, owner: string): Promise<Response> {
    const input = await request.json().catch(() => null)
    if (!input || input.projectKey !== projectKey || typeof input.trackerVersion !== 'string' ||
        !Number.isSafeInteger(input.timestamp) || input.timestamp <= 0 || input.doNotRecord !== false)
      return json({ error: 'Invalid OpenReplay start request' }, 400)
    if (typeof input.token === 'string' && tokenPattern.test(input.token)) {
      const resumed = await sequence(async () => {
        const existing = await sessions.load(input.token)
        if (!existing) return
        if (existing.rejected) return json({ error: existing.rejected }, 403)
        await sessions.observeOwner(existing, owner)
        return json(existing.local)
      })
      if (resumed) return resumed
    }
    const id = nonce()
    const token = virtualPrefix + id
    const prior = await sessions.profile()
    const userUUID = typeof input.userUUID === 'string' && input.userUUID.length > 0
      ? input.userUUID : [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-')
    const opened: ReplaySession['opened'] = { projectKey, timestamp: input.timestamp, trackerVersion: input.trackerVersion,
      doNotRecord: false, userUUID }
    for (const key of ['revID', 'timezone', 'isSnippet', 'deviceMemory', 'jsHeapSizeLimit', 'width', 'height']) {
      if (['string', 'number', 'boolean'].includes(typeof input[key])) opened[key] = input[key]
    }
    const session: ReplaySession = {
      token, owner, opened, touched: Date.now(),
      local: { ...prior, token, userUUID, sessionID: id, startTimestamp: input.timestamp, delay: 0 },
    }
    return startSession(session)
  }

  async function startSession(session: ReplaySession): Promise<Response> {
    if (globalThis.navigator?.onLine !== false) {
      // An online handshake supplies the collector's actual recording policy and canvas capabilities.
      let result
      try { result = await sessions.connect(session, false) } catch { /* retry the handshake during delivery */ }
      if (result?.state === 'blocked') return json({ error: result.reason }, 403)
    }
    await sessions.save(session)
    return json(session.local)
  }

  async function record(request: Request, resource: 'i' | 'images', token: string, owner: string): Promise<Response> {
    const saved = await sessions.load(token)
    if (!saved) return json({ error: 'Unknown OpenReplay session' }, 401)
    const url = new URL(request.url)
    const query = new URLSearchParams()
    for (const key of ['batch', 'split']) {
      const value = url.searchParams.get(key)
      if (value !== null) query.set(key, value)
    }
    const headers: Record<string, string> = {}
    const contentType = request.headers.get('content-type')
    const dataType = request.headers.get('datatype')
    const encoding = request.headers.get('content-encoding')
    if ((dataType && !dataTypes.has(dataType)) || (encoding && encoding !== 'gzip') ||
        (resource === 'images' && !contentType?.startsWith('multipart/form-data;')))
      return json({ error: 'Invalid OpenReplay payload headers' }, 400)
    if (contentType) headers['Content-Type'] = contentType
    if (dataType) headers.DataType = dataType
    if (encoding) headers['Content-Encoding'] = encoding
    const packet: ReplayPacket = {
      token, resource, headers, query: query.toString() ? '?' + query.toString() : '',
      body: pack(new Uint8Array(await request.arrayBuffer())),
    }
    if (!packet.body) return json({ error: 'Empty OpenReplay packet' }, 400)
    await sessions.observeOwner(saved, owner)
    await queue.put(await packetKey(packet), packet)
    return new Response(null, { status: 202 })
  }

  function handle(request: Request, clientId = ''): Promise<Response> | undefined {
    const url = new URL(request.url)
    if (url.origin !== base.origin || !url.href.startsWith(local + '/')) return
    const route = url.pathname.slice(new URL(local).pathname.length)
    const accept = async () => {
      const origin = request.headers.get('origin')
      if ((origin && origin !== base.origin) || request.headers.get('sec-fetch-site') === 'cross-site')
        return json({ error: 'Cross-origin gateway request' }, 403)
      if (route === '/ready' && request.method === 'GET') {
        const [storage] = await Promise.all([queue.status(), sessions.profile()])
        if (storage.unavailable) return json({ error: 'OpenReplay durable storage unavailable' }, 503)
        const response = json({ protocol: 1, projectKey })
        response.headers.set('X-Observability-OpenReplay', '1')
        return response
      }
      if (route === '/v1/web/start' && request.method === 'POST') {
        return open(request, clientId)
      }
      const bearer = request.headers.get('authorization') ?? ''
      const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : ''
      if (!tokenPattern.test(token)) return json({ error: 'Unknown OpenReplay session' }, 401)
      if (route === '/v1/web/tags' && request.method === 'GET') return json({ tags: [] })
      if (request.method === 'POST' && (route === '/v1/web/i' || route === '/v1/web/images')) {
        // Worker closing flushes may arrive concurrently. Preserve arrival order across asynchronous body reads.
        arrivals++
        return sequence(() => record(request, route === '/v1/web/i' ? 'i' : 'images', token, clientId))
      }
      return json({ error: 'Unsupported OpenReplay gateway route' }, 404)
    }
    return accept().catch(() => json({ error: 'OpenReplay durable storage unavailable' }, 503))
  }

  return {
    handle,
    async flush(timeoutMs?: number) {
      await lastWrite
      const empty = await queue.flush(timeoutMs)
      if (empty && sessions.collectionDue()) {
        // A packet can arrive after flush counted the queue. Recheck while its admission/ACK is serialized.
        return sequence(async () => {
          const observed = arrivals
          const status = await queue.status()
          if (status.pending || status.blocked || status.unavailable) return false
          await sessions.collect(() => observed === arrivals)
          return observed === arrivals
        })
      }
      return empty
    },
    status: () => queue.status(),
    async retryBlocked() { await sessions.retryRejected(); await queue.retryBlocked() },
  }
}
