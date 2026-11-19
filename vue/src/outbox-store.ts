export interface SavedRecord {
  stream: string
  key: string
  body: string
  digest: string
  created: number
  attempts: number
  state: 'pending' | 'blocked'
  next: number
  lease?: string
  reason?: string
}
export type QueueState = Pick<SavedRecord, 'state' | 'next' | 'attempts' | 'lease' | 'reason'>
export interface DeliveryStatus {
  pending: number
  blocked: number
  unavailable?: boolean
  memoryOnly?: number
}
type Visitor = (record: SavedRecord) => 'save' | 'claim' | 'stop' | void
const databaseName = 'event-observability-outbox-v1'
const table = 'records'
let opening: Promise<IDBDatabase> | undefined

function database(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(table, { autoIncrement: true })
        store.createIndex('identity', ['stream', 'key'], { unique: true })
        store.createIndex('state', ['stream', 'state'])
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Observability: database upgrade is blocked'))
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => { db.close(); opening = undefined }
        db.onclose = () => { opening = undefined }
        resolve(db)
      }
    }).catch(error => { opening = undefined; throw error })
  }
  return opening
}

async function transaction<T>(mode: IDBTransactionMode, execute: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
  const db = await database()
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction
    try { tx = db.transaction(table, mode, { durability: 'strict' }) }
    catch { tx = db.transaction(table, mode) }
    let value: T
    tx.oncomplete = () => resolve(value)
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Observability: database transaction failed'))
    execute(tx.objectStore(table), result => { value = result })
  })
}

// The stream index preserves insertion order for equal keys using the auto-increment primary key.
export class IndexedStore {
  constructor(readonly stream: string) {}
  put(record: SavedRecord): Promise<void> {
    return transaction('readwrite', store => {
      const existing = store.index('identity').getKey([this.stream, record.key])
      existing.onsuccess = () => { if (existing.result === undefined) store.add(record) }
    })
  }
  count(state: SavedRecord['state']): Promise<number> {
    return transaction('readonly', (store, result) => {
      const count = store.index('state').count([this.stream, state])
      count.onsuccess = () => result(count.result)
    })
  }
  visit(state: SavedRecord['state'], visitor: Visitor): Promise<void> {
    return transaction('readwrite', store => {
      const request = store.index('state').openCursor(IDBKeyRange.only([this.stream, state]))
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        const record: SavedRecord = cursor.value
        const action = visitor(record)
        if (action === 'claim' || action === 'save') cursor.update(record)
        if (action !== 'stop' && action !== 'claim') cursor.continue()
      }
    })
  }
  settle(record: SavedRecord, update?: QueueState): Promise<void> {
    return transaction('readwrite', store => {
      const request = store.index('identity').openCursor([this.stream, record.key])
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor || cursor.value.lease !== record.lease) return
        if (update) cursor.update({ ...cursor.value, ...update })
        else cursor.delete()
      }
    })
  }
}

// One entry per key prevents a concurrent writer from overwriting an entire queue.
// Browsers without IndexedDB transactions may retry the same ID from two tabs.
export class LocalStore {
  private readonly prefix: string
  constructor(readonly stream: string, readonly storage: Storage) {
    this.prefix = databaseName + ':' + encodeURIComponent(stream) + ':'
  }
  private name(key: string): string { return this.prefix + encodeURIComponent(key) }

  private decode(key: string, raw: string): SavedRecord | undefined {
    try {
      const record: SavedRecord = JSON.parse(raw)
      if (!record || record.stream !== this.stream || typeof record.key !== 'string' || !record.key ||
          this.name(record.key) !== key || typeof record.body !== 'string' ||
          typeof record.digest !== 'string' || !/^(?:sha256:[a-f0-9]{64}|crc32:[a-f0-9]{1,8})$/.test(record.digest) ||
          !Number.isSafeInteger(record.created) || !Number.isSafeInteger(record.attempts) || record.attempts < 0 ||
          !Number.isFinite(record.next) || (record.state !== 'pending' && record.state !== 'blocked') ||
          (record.lease !== undefined && typeof record.lease !== 'string') ||
          (record.reason !== undefined && typeof record.reason !== 'string')) return
      JSON.parse(record.body)
      return record
    } catch { return undefined }
  }

  put(record: SavedRecord): void {
    const key = this.name(record.key)
    const existing = this.storage.getItem(key)
    if (existing === null) this.storage.setItem(key, JSON.stringify(record))
    else if (!this.decode(key, existing)) throw new Error('Observability: local record is damaged')
  }
  private *records(): IterableIterator<SavedRecord | undefined> {
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i)
      if (!key?.startsWith(this.prefix)) continue
      const item = this.storage.getItem(key)
      if (item !== null) yield this.decode(key, item)
    }
  }
  count(state: SavedRecord['state']): number {
    let count = 0
    // Undecodable rows stay byte-for-byte intact. Only their blocked count is exposed.
    for (const record of this.records()) if ((record?.state ?? 'blocked') === state) count++
    return count
  }
  visit(state: SavedRecord['state'], visitor: Visitor): void {
    const records = Array.from(this.records()).filter((record): record is SavedRecord => record?.state === state)
    records.sort((a, b) => a.created - b.created || a.key.localeCompare(b.key))
    for (const record of records) {
      const action = visitor(record)
      if (action === 'claim' || action === 'save') this.storage.setItem(this.name(record.key), JSON.stringify(record))
      if (action === 'stop' || action === 'claim') break
    }
  }
  settle(record: SavedRecord, update?: QueueState): void {
    const key = this.name(record.key)
    const raw = this.storage.getItem(key)
    if (raw === null) return
    const saved = this.decode(key, raw)
    if (!saved || saved.lease !== record.lease) return
    if (update) this.storage.setItem(key, JSON.stringify({ ...saved, ...update }))
    else this.storage.removeItem(key)
  }
}

export function stores(stream: string): Array<IndexedStore | LocalStore> {
  const result: Array<IndexedStore | LocalStore> = []
  try { if (globalThis.indexedDB) result.push(new IndexedStore(stream)) } catch { /* sandboxed storage */ }
  try { if (globalThis.localStorage) result.push(new LocalStore(stream, globalThis.localStorage)) } catch { /* workers and private browsing */ }
  return result
}
