import { stores, type DeliveryStatus, type SavedRecord } from './outbox-store.js'
export type { DeliveryStatus } from './outbox-store.js'

export type DeliveryResult = { state: 'ack' } | { state: 'retry'; afterMs?: number } | { state: 'blocked'; reason: string }
const leaseMs = 120_000
const storageError = () => new Error('Observability: durable storage unavailable or full')

// The checksum covers precisely the serialized, sanitized payload that will be replayed.
async function digest(body: string, algorithm = globalThis.crypto?.subtle ? 'sha256' : 'crc32'): Promise<string> {
  if (algorithm === 'sha256') {
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
    return 'sha256:' + Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('')
  }
  if (algorithm !== 'crc32') throw new Error('Observability: unknown payload checksum')
  let crc = -1
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i)
    for (const byte of [code & 255, code >>> 8]) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return 'crc32:' + ((crc ^ -1) >>> 0).toString(16)
}

export class DurableOutbox<T> {
  private readonly backends
  private readonly writes = new Set<Promise<void>>()
  private active = false
  private timer?: ReturnType<typeof setTimeout>
  private draining?: Promise<void>
  private wakeAgain = false
  private nextCheck = Infinity

  constructor(readonly stream: string, private readonly deliver: (payload: T, key: string) => Promise<DeliveryResult>,
    private readonly onError: (error: Error) => void = error => console.error(error.message)) {
    this.backends = stores(stream)
  }

  private report(error: Error): void {
    try { this.onError(error) } catch { /* diagnostics must not interrupt persistence */ }
  }

  put(key: string, payload: T): Promise<void> {
    const write = this.persist(key, payload)
    this.writes.add(write)
    const done = () => this.writes.delete(write)
    void write.then(done, done)
    return write
  }

  private async persist(key: string, payload: T): Promise<void> {
    const body = JSON.stringify(payload)
    if (typeof body !== 'string' || !key) throw new TypeError('Observability: invalid queue record')
    const record: SavedRecord = {
      key, stream: this.stream, body, digest: await digest(body), attempts: 0, state: 'pending', created: Date.now(), next: 0,
    }
    for (const store of this.backends) {
      try { await store.put(record); this.wake(); return } catch { /* try the independent fallback */ }
    }
    const error = storageError()
    this.report(error)
    throw error
  }

  start(): void {
    if (this.active) return
    this.active = true
    globalThis.addEventListener?.('online', this.wake)
    globalThis.addEventListener?.('pageshow', this.wake)
    this.wake()
  }

  stop(): void {
    this.active = false
    clearTimeout(this.timer)
    globalThis.removeEventListener?.('online', this.wake)
    globalThis.removeEventListener?.('pageshow', this.wake)
  }

  private readonly wake = () => {
    if (!this.active) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.drain().catch(() => this.report(storageError())) }, 0)
  }

  private drain(): Promise<void> {
    if (this.draining) { this.wakeAgain = true; return this.draining }
    this.draining = this.drainStores().finally(() => {
      this.draining = undefined
      clearTimeout(this.timer)
      if (this.active) this.timer = setTimeout(this.wake, this.wakeAgain ? 0 : Math.max(50, Math.min(60_000, this.nextCheck - Date.now())))
      this.wakeAgain = false
    })
    return this.draining
  }

  private async deliverRecord(record: SavedRecord): Promise<DeliveryResult> {
    let payload: T
    try {
      if (typeof record.body !== 'string' || await digest(record.body, record.digest.split(':')[0]) !== record.digest)
        return { state: 'blocked', reason: 'checksum mismatch' }
      payload = JSON.parse(record.body)
    } catch { return { state: 'blocked', reason: 'unreadable payload or checksum' } }
    try { return await this.deliver(payload, record.key) } catch { return { state: 'retry' } }
  }

  private async drainStores(): Promise<void> {
    this.nextCheck = Infinity
    let accessible = false
    for (const store of this.backends) {
      try {
        while (true) {
          let claimed: SavedRecord | undefined
          const now = Date.now()
          await store.visit('pending', record => {
            // Keep pending records in FIFO order, including while another tab holds the lease.
            if (record.next > now) {
              this.nextCheck = Math.min(this.nextCheck, record.next)
              return 'stop'
            }
            record.lease = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + now
            record.next = now + leaseMs
            claimed = record
            return 'claim'
          })
          accessible = true
          if (!claimed) break
          const record: SavedRecord = claimed
          let outcome: DeliveryResult
          // Long session reconstructions may involve several uploads. A live owner renews its
          // claim; an interrupted owner still releases it automatically at the lease deadline.
          const renew = setInterval(() => {
            void Promise.resolve().then(() => store.settle(record, {
              state: 'pending', attempts: record.attempts, next: Date.now() + leaseMs, lease: record.lease,
            })).catch(() => this.report(storageError()))
          }, leaseMs / 3)
          try { outcome = await this.deliverRecord(record) }
          finally { clearInterval(renew) }
          if (outcome.state === 'ack') { await store.settle(record); continue }
          const attempts = record.attempts + 1
          const backoff = Math.min(300_000, 1000 * 2 ** Math.min(attempts - 1, 9)) * (1 + Math.random() / 4)
          const retryIn = outcome.state === 'retry' ? Math.max(outcome.afterMs ?? 0, backoff) : 0
          await store.settle(record, {
            state: outcome.state === 'blocked' ? 'blocked' : 'pending', reason: outcome.state === 'blocked' ? outcome.reason : undefined,
            attempts, next: Date.now() + retryIn, lease: undefined,
          })
          if (outcome.state === 'retry') {
            this.nextCheck = Math.min(this.nextCheck, Date.now() + retryIn)
            break
          }
          this.report(new Error('Observability: retained a record that could not be delivered (' + outcome.reason + ')'))
        }
      } catch { this.report(storageError()) }
    }
    if (!accessible) throw storageError()
  }

  private async waitForWrites(): Promise<boolean> {
    const results = await Promise.all(Array.from(this.writes, write => write.then(() => true, () => false)))
    return results.every(Boolean)
  }

  async status(): Promise<DeliveryStatus> {
    await this.waitForWrites()
    const counts: DeliveryStatus = { pending: 0, blocked: 0 }
    let accessible = false
    for (const store of this.backends) {
      try {
        counts.pending += await store.count('pending')
        counts.blocked += await store.count('blocked')
        accessible = true
      } catch { counts.unavailable = true; this.report(storageError()) }
    }
    if (!accessible) counts.unavailable = true
    return counts
  }

  async retryBlocked(): Promise<void> {
    for (const store of this.backends) {
      try {
        await store.visit('blocked', record => {
          record.state = 'pending'
          record.next = 0
          record.reason = undefined
          return 'save'
        })
      } catch { this.report(storageError()) }
    }
    this.wake()
  }

  async flush(timeoutMs = 5000): Promise<boolean> {
    const work = async () => {
      const committed = await this.waitForWrites()
      await this.drain()
      const count = await this.status()
      return committed && !count.unavailable && count.pending === 0 && count.blocked === 0
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([work(), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })])
    } catch { return false }
    finally { clearTimeout(timer) }
  }
}
