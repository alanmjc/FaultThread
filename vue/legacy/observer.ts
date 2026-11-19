// A classic script for applications whose browser cannot load the Vue/ESM client.
interface LegacyObserverOptions {
  application: string
  dsn: string
  onDeliveryError?: (error: Error) => void
}
type LegacyLogLevel = 'info' | 'warning' | 'error' | 'fatal'
interface LegacyObserver {
  reportError(error?: unknown): string | null
  /** Records a standalone event with the given severity. The supplied text is always omitted. */
  reportLog(message: string, level?: LegacyLogLevel): string | null
  status(): { pending: number; blocked: number; memoryOnly: number }
  retryBlocked(): void
  flush(): void
  stop(): void
}
declare var EventObservability: { install(options: LegacyObserverOptions): LegacyObserver }

;(function () {
  if (typeof window === 'undefined' || window.EventObservability) return
  let active: { scope: string; observer: LegacyObserver } | undefined
  const kinds = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError']
  const levels: LegacyLogLevel[] = ['info', 'warning', 'error', 'fatal']
  const logMessage = 'Application event'

  interface RecordData {
    id: string; timestamp: number; kind: string; level?: LegacyLogLevel; check: number
    next: number; attempts: number; blocked: boolean; lease?: string; invalid?: boolean
  }
  function collector(dsn: string): string {
    // Parse only the public-key DSN grammar. Old anchor implementations lack username/password APIs.
    const match = /^(https?):\/\/([a-z0-9_]+)@(\[[a-f\d:]+\]|[a-z\d.-]+)(:\d{1,5})?(\/(?:[\w.~%-]+\/)*)?(\d+)$/i.exec(dsn)
    if (!match) throw new TypeError('Observability: invalid legacy DSN')
    const protocol = match[1].toLowerCase(), host = match[3].toLowerCase()
    if (protocol !== 'https' && host !== 'localhost' && host !== 'localhost.' && host !== '[::1]' &&
        !/^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host))
      throw new TypeError('Observability: HTTPS required for remote collectors')
    if (!match[5] || /\/(?:\.|%2e){1,2}\//i.test(match[5]) || (match[4] && Number(match[4].slice(1)) > 65535))
      throw new TypeError('Observability: invalid legacy DSN')
    return protocol + '://' + host + (match[4] || '') + match[5] + 'api/' + match[6] +
      '/envelope/?sentry_version=7&sentry_key=' + match[2]
  }

  function randomId(): string {
    let result = ''
    if (window.crypto && window.crypto.getRandomValues && typeof Uint8Array === 'function') {
      const bytes = window.crypto.getRandomValues(new Uint8Array(16))
      for (let i = 0; i < bytes.length; i++) result += ('0' + bytes[i].toString(16)).slice(-2)
    } else {
      for (let i = 0; i < 8; i++) result += ('000' + Math.floor(Math.random() * 65536).toString(16)).slice(-4)
    }
    return result
  }

  function checksum(row: Pick<RecordData, 'id' | 'timestamp' | 'kind' | 'level'>): number {
    // Earlier releases stored exceptions without a severity in their checksum.
    const text = row.id + '|' + row.timestamp + '|' + row.kind + (row.level ? '|' + row.level : '')
    let crc = -1
    for (let i = 0; i < text.length; i++) {
      crc ^= text.charCodeAt(i)
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    return (crc ^ -1) >>> 0
  }

  function install(options: LegacyObserverOptions): LegacyObserver {
    if (!options || typeof options.application !== 'string' || !/^[a-z\d_.-]{1,150}$/i.test(options.application))
      throw new TypeError('Observability: a legacy application identifier is required')
    const application = options.application, endpoint = collector(options.dsn)
    const scope = 'event-observability-legacy-v1:' + encodeURIComponent(application + '|' + endpoint) + ':'
    if (active) {
      if (active.scope === scope) return active.observer
      throw new Error('Observability: stop the active legacy observer first')
    }
    const memory: { [key: string]: RecordData } = Object.create(null)
    let storage: Storage | undefined
    let stopped = false, busy = false, timer = 0, storageWarning = false, corruptWarning = false
    let rateLimitedUntil = 0
    function report(message: string): void {
      try {
        const error = new Error('Observability: ' + message)
        if (options.onDeliveryError) options.onDeliveryError(error)
        else if (window.console && window.console.error) window.console.error(error.message)
      } catch { /* The host diagnostic callback cannot interrupt capture. */ }
    }
    function warnStorage(): void {
      if (!storageWarning) report('legacy storage unavailable or full; queued events may exist only in memory')
      storageWarning = true
    }
    try { storage = window.localStorage } catch { /* access denied */ }
    if (!storage) warnStorage()

    function rows(): RecordData[] {
      const found: typeof memory = Object.create(null)
      try {
        if (storage) for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i)
          if (!key || key.indexOf(scope) !== 0) continue
          const id = key.slice(scope.length)
          if (!/^[a-f\d]{32}$/.test(id)) continue
          const raw = storage.getItem(key)
          if (raw === null) continue
          try {
            const row = JSON.parse(raw) as RecordData
            if (!row || row.id !== id || typeof row.timestamp !== 'number' || !isFinite(row.timestamp) ||
                (row.level === undefined ? kinds.indexOf(row.kind) < 0 : row.kind !== logMessage || levels.indexOf(row.level) < 0) ||
                row.check !== checksum(row) || !isFinite(row.next) ||
                typeof row.attempts !== 'number' || typeof row.blocked !== 'boolean') throw new Error()
            found[id] = row
          } catch {
            if (!corruptWarning) report('invalid legacy queue record retained for inspection')
            corruptWarning = true
            found[id] = { id, timestamp: 0, kind: 'Error', check: 0, attempts: 0, next: 0, blocked: true, invalid: true }
          }
        }
      } catch { warnStorage() }
      for (const key in memory) found[key] = memory[key]
      return Object.keys(found).map(key => found[key]).sort((a, b) => a.timestamp - b.timestamp)
    }
    function save(row: RecordData): void {
      try {
        if (!storage) storage = window.localStorage
        if (storage) {
          storage.setItem(scope + row.id, JSON.stringify(row))
          delete memory[row.id]
          storageWarning = false
          return
        }
      } catch { /* Keep the same ID in memory for the next attempt. */ }
      memory[row.id] = row
      warnStorage()
    }
    function schedule(delay: number): void {
      window.clearTimeout(timer)
      if (!stopped) timer = window.setTimeout(flush, Math.min(30_000, Math.max(0, delay)))
    }
    function flush(): void {
      if (stopped || busy) return
      const list = rows()
      let row: RecordData | undefined
      for (let i = 0; i < list.length; i++) {
        if (!list[i].blocked) { row = list[i]; break }
      }
      if (!row) { schedule(30_000); return }
      const wait = Math.max(row.next, rateLimitedUntil) - Date.now()
      if (wait > 0) { schedule(wait); return }
      const current = row
      const lease = randomId()
      current.lease = lease
      current.next = Date.now() + 60_000
      save(current)
      busy = true
      let xhr: XMLHttpRequest, finished = false, timeout = 0
      function finish(status: number, after: number): void {
        if (finished) return
        finished = true
        window.clearTimeout(timeout)
        busy = false
        // A different tab may have renewed the lease (e.g. after OS sleep).
        const live = rows().filter(candidate => candidate.id === current.id)[0]
        if (live && live.lease === lease) {
          if (status >= 200 && status < 300) {
            try { if (storage) storage.removeItem(scope + current.id) } catch { warnStorage() }
            delete memory[current.id]
          } else {
            current.attempts++
            current.lease = undefined
            current.blocked = status > 0 && status < 500 && status !== 408 && status !== 425 && status !== 429
            current.next = Date.now() + Math.max(after, Math.min(300_000, 1000 * Math.pow(2, Math.min(9, current.attempts - 1))))
            save(current)
            if (current.blocked) report('legacy event retained after collector HTTP ' + status)
          }
        }
        schedule(0)
      }
      try {
        xhr = new XMLHttpRequest()
        xhr.open('POST', endpoint, true)
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4 || finished) return
          try {
            const status = xhr.status === 1223 ? 204 : xhr.status
            const after = xhr.getResponseHeader('Retry-After') || ''
            let waitMs = /^\d+(\.\d+)?$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now()
            if (!isFinite(waitMs) || waitMs < 0) waitMs = 0
            const limits = (xhr.getResponseHeader('X-Sentry-Rate-Limits') || '').split(',')
            for (let i = 0; i < limits.length; i++) {
              const parts = limits[i].trim().split(':')
              if (parts[0] && (!parts[1] || parts[1].split(';').indexOf('error') >= 0)) {
                const seconds = Number(parts[0])
                waitMs = Math.max(waitMs, isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 60_000)
              }
            }
            if (status === 429 && !waitMs) waitMs = 60_000
            if (waitMs) rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + waitMs)
            finish(status, waitMs)
          } catch { finish(0, 0) }
        }
        xhr.onerror = () => finish(0, 0)
        timeout = window.setTimeout(() => { finish(0, 0); try { xhr.abort() } catch { /* already closed */ } }, 20_000)
        const stamp = new Date(current.timestamp)
        const event = { event_id: current.id, timestamp: current.timestamp / 1000, platform: 'javascript', level: current.level || 'error',
          message: current.level ? logMessage : undefined,
          exception: current.level ? undefined : { values: [{ type: current.kind, value: '[omitted]' }] }, tags: { application },
          sdk: { settings: { infer_ip: 'never' } } }
        xhr.send(JSON.stringify({ event_id: current.id, sent_at: stamp.toISOString() }) + '\n{"type":"event"}\n' + JSON.stringify(event))
      } catch { finish(0, 0) }
    }

    function enqueue(kind: string, level?: LegacyLogLevel): string {
      const row = { id: randomId(), timestamp: Date.now(), kind, level, check: 0, next: 0, attempts: 0, blocked: false }
      row.check = checksum(row)
      save(row)
      schedule(0)
      return row.id
    }
    function reportError(error?: unknown): string | null {
      if (stopped) return null
      const kind = error && typeof error === 'object' && 'name' in error && typeof error.name === 'string' &&
        kinds.indexOf(error.name) >= 0 ? error.name : 'Error'
      return enqueue(kind)
    }
    const onError = (event: ErrorEvent) => { reportError(event.error) }
    const oldHandler = window.onerror
    const handler: OnErrorEventHandler = (message, file, line, column, error) => {
      reportError(error)
      if (oldHandler) return oldHandler.call(window, message, file, line, column, error)
    }
    if (window.addEventListener) {
      window.addEventListener('error', onError)
      window.addEventListener('online', flush)
      window.addEventListener('pageshow', flush)
    } else window.onerror = handler

    const observer: LegacyObserver = {
      reportError, flush,
      reportLog(_message, level = 'info') {
        return stopped ? null : enqueue(logMessage, levels.indexOf(level) >= 0 ? level : 'info')
      },
      status() {
        const list = rows()
        const blocked = list.filter(row => row.blocked).length
        return { pending: list.length - blocked, blocked, memoryOnly: Object.keys(memory).length }
      },
      retryBlocked() {
        rows().forEach(row => { if (row.blocked && !row.invalid) { row.blocked = false; row.next = 0; save(row) } })
        flush()
      },
      stop() {
        stopped = true
        window.clearTimeout(timer)
        if (window.removeEventListener) {
          window.removeEventListener('error', onError)
          window.removeEventListener('online', flush)
          window.removeEventListener('pageshow', flush)
        } else if (window.onerror === handler) window.onerror = oldHandler
        if (active && active.observer === observer) active = undefined
      },
    }
    active = { scope, observer }
    schedule(0)
    return observer
  }

  window.EventObservability = { install }
})()
