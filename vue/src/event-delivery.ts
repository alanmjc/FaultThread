import { wakeEventWorker } from './background-delivery.js'
import { collectorRequest } from './http.js'
import { DurableOutbox, type DeliveryResult, type DeliveryStatus } from './outbox.js'
import type { TransportFactory } from './transport.js'

type Envelope = Parameters<ReturnType<TransportFactory>['send']>[0]
interface MemoryRecord { body: string; next: number; blocked: boolean }

// An error can receive a category-specific quota even on a successful HTTP response.
function quotaDelay(response: Response): number {
  let delay = 0
  for (const quota of (response.headers.get('X-Sentry-Rate-Limits') ?? '').split(',')) {
    if (!quota.trim()) continue
    const [seconds, categories] = quota.trim().split(':')
    if (!categories || categories.split(';').includes('error')) {
      const value = Number(seconds)
      delay = Math.max(delay, Number.isFinite(value) && value >= 0 ? value * 1000 : 60_000)
    }
  }
  const after = response.headers.get('Retry-After')
  if (after) {
    const ms = /^\d+(\.\d+)?$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now()
    if (Number.isFinite(ms)) delay = Math.max(delay, ms)
  }
  return delay || (response.status === 429 ? 60_000 : 0)
}

function wireEnvelope([header, items]: Envelope): [string, string] {
  const id = typeof header.event_id === 'string' && header.event_id
    ? header.event_id
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
  const lines = [JSON.stringify({ ...header, event_id: id })]
  for (const [metadata, payload] of items) {
    const event = typeof payload === 'object' && payload && !('event_id' in payload && payload.event_id)
      ? { ...payload, event_id: id }
      : payload
    lines.push(JSON.stringify(metadata), JSON.stringify(event))
  }
  return [id, lines.join('\n')]
}

export class EventDelivery {
  private readonly queue: DurableOutbox<string>
  private readonly writes = new Map<string, Promise<void>>()
  private readonly memory = new Map<string, MemoryRecord>()
  private nextSend = 0
  private timer?: ReturnType<typeof setTimeout>
  private active = false

  constructor(application: string, dsn: string, private readonly endpoint: string,
    private readonly report: (error: Error) => void) {
    this.queue = new DurableOutbox(JSON.stringify(['sentry', application, dsn]), body => this.deliver(body), report)
  }

  start(): void {
    this.active = true
    this.queue.start()
    globalThis.addEventListener?.('online', this.recover)
    globalThis.addEventListener?.('pageshow', this.recover)
    this.recover()
  }

  stop(): void {
    this.active = false
    this.queue.stop()
    clearTimeout(this.timer)
    globalThis.removeEventListener?.('online', this.recover)
    globalThis.removeEventListener?.('pageshow', this.recover)
  }

  async send(envelope: Envelope) {
    const [key, body] = wireEnvelope(envelope)
    await this.save(key, { body, next: 0, blocked: false })
    // The envelope is accepted locally. Only the collector can supply an HTTP acknowledgement.
    return {}
  }

  private async deliver(body: string): Promise<DeliveryResult> {
    const wait = this.nextSend - Date.now()
    if (wait > 0) return { state: 'retry', afterMs: wait }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      const request: RequestInit & { [collectorRequest]: true } = {
        [collectorRequest]: true, method: 'POST', body, signal: controller.signal, credentials: 'omit',
        redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
      }
      const response = await fetch(this.endpoint, request)
      const afterMs = quotaDelay(response)
      if (afterMs) this.nextSend = Math.max(this.nextSend, Date.now() + afterMs)
      if (response.ok) return { state: 'ack' }
      if ([0, 408, 425, 429].includes(response.status) || response.status >= 500)
        return { state: 'retry', afterMs }
      return { state: 'blocked', reason: 'collector HTTP ' + response.status }
    } catch {
      return { state: 'retry' }
    } finally { clearTimeout(timeout) }
  }

  private save(key: string, record: MemoryRecord): Promise<void> {
    const writing = this.writes.get(key)
    if (writing) return writing
    const write = this.storeOrSend(key, record).finally(() => this.writes.delete(key))
    this.writes.set(key, write)
    return write
  }

  private async storeOrSend(key: string, record: MemoryRecord): Promise<void> {
    try {
      await this.queue.put(key, record.body)
      wakeEventWorker()
      this.memory.delete(key)
    } catch {
      // Both persistent stores failed. Keep the sanitized body for a direct attempt and recovery.
      this.memory.set(key, record)
      if (!record.blocked && record.next <= Date.now()) {
        const result = await this.deliver(record.body)
        if (result.state === 'ack') this.memory.delete(key)
        else if (result.state === 'blocked') {
          record.blocked = true
          this.report(new Error('FaultThread: retained error in memory (' + result.reason + ')'))
        } else record.next = Date.now() + Math.max(1000, result.afterMs ?? 0)
      }
      this.scheduleRecovery()
    }
  }

  private scheduleRecovery(): void {
    clearTimeout(this.timer)
    if (this.active && this.memory.size) this.timer = setTimeout(this.recover, 30_000)
  }

  private readonly recover = () => {
    for (const [key, record] of this.memory) void this.save(key, record)
  }

  async retryBlocked(): Promise<void> {
    for (const record of this.memory.values()) record.blocked = false
    this.recover()
    await this.queue.retryBlocked()
  }

  async status(): Promise<DeliveryStatus> {
    await Promise.all(this.writes.values())
    const counts = await this.queue.status()
    for (const record of this.memory.values()) counts[record.blocked ? 'blocked' : 'pending']++
    if (this.memory.size) counts.memoryOnly = this.memory.size
    return counts
  }

  async flush(timeout = 5000): Promise<boolean> {
    const deadline = Date.now() + timeout
    const work = async () => {
      this.recover()
      await Promise.all(this.writes.values())
      return await this.queue.flush(Math.max(0, deadline - Date.now())) && this.memory.size === 0
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([work(), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeout) })])
    } catch { return false }
    finally { clearTimeout(timer) }
  }
}
