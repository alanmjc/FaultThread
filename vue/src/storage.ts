export interface StorageProtection {
  persistent: boolean
  usage?: number
  quota?: number
}

// Call from the host's user gesture. The browser decides whether to grant persistence.
export async function requestPersistentStorage(): Promise<StorageProtection> {
  let manager: StorageManager | undefined
  try { manager = globalThis.navigator?.storage } catch { return { persistent: false } }
  let persistent = false
  try { persistent = !!(await manager?.persisted?.() || await manager?.persist?.()) } catch { /* denied */ }
  try {
    const estimate = await manager?.estimate?.()
    return { persistent, usage: estimate?.usage, quota: estimate?.quota }
  } catch { return { persistent } }
}
