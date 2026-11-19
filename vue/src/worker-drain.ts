interface Source {
  flush(timeout?: number): Promise<boolean>
  status(): Promise<{ pending: number }>
}

// A worker can wake before a persisted retry becomes eligible. Keep a bounded event alive
// across that deadline; concurrent fetch, sync and foreground notifications share the run.
export function workerDrain(source: Source): () => Promise<boolean> {
  let running: Promise<boolean> | undefined
  const flush = async () => {
    const deadline = Date.now() + 18_000
    let interval = 750
    while (Date.now() < deadline) {
      if (await source.flush(Math.max(1, deadline - Date.now()))) return true
      if (navigator.onLine === false || !(await source.status()).pending) break
      await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))))
      interval = Math.min(4000, interval * 2)
    }
    return false
  }
  return () => running ??= flush().finally(() => { running = undefined })
}
