export const eventSyncTag = 'event-observability:errors'
let lastWake = 0

export function activeServiceWorker(): ServiceWorker | null {
  try { return globalThis.navigator?.serviceWorker?.controller ?? null }
  catch { return null } // Sandboxed frames can expose a serviceWorker getter that throws.
}

// The foreground delivery path remains active when a browser has no Background Sync.
export function wakeEventWorker(): void {
  if (Date.now() - lastWake < 1000) return
  const worker = activeServiceWorker()
  if (!worker) return
  lastWake = Date.now()
  try {
    worker.postMessage({ channel: eventSyncTag })
    void navigator.serviceWorker.ready.then(registration => {
      const sync = (registration as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync
      return sync?.register(eventSyncTag)
    }).catch(() => {})
  } catch { /* foreground retry still owns the saved record */ }
}
