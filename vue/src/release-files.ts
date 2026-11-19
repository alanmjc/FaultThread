import { setTimeout as delay } from 'node:timers/promises'
import type { UploadOptions } from './sourcemaps.js'

// GlitchTip acknowledges assembly when queued. Its project release files expose
// the checksums after processing. Follow only cursors, never a server-provided URL.
export const waitForReleaseFiles = async (
  endpoint: URL,
  options: UploadOptions,
  expected: ReadonlyMap<string, string>,
  seconds: number,
): Promise<void> => {
  const segments = [options.org, options.project].map(encodeURIComponent).join('/')
  const base = endpoint.href.replace(/\/?$/, '/')
  const files = new URL(`api/0/projects/${segments}/releases/${encodeURIComponent(options.release)}/files/`, base)
  const deadline = AbortSignal.timeout(seconds * 1000)
  const headers = { Authorization: `Bearer ${options.authToken}` }

  try {
    while (!deadline.aborted) {
      const missing = new Map(expected)
      files.search = ''
      do {
        const response = await fetch(files, { headers, signal: deadline, redirect: 'error' })
        if (!response.ok)
          throw new Error(`FaultThread: release file verification returned HTTP ${response.status}`)
        const entries: unknown = await response.json().catch(() => null)
        if (!Array.isArray(entries))
          throw new Error('FaultThread: collector returned an invalid release file list')
        for (const { name, sha1 } of entries) {
          if (missing.get(name) === sha1) missing.delete(name)
        }
        if (!missing.size) return

        const next = /rel="next";\s*results="true";\s*cursor="([^"]+)"/.exec(response.headers.get('link') ?? '')
        if (!next) break
        files.searchParams.set('cursor', next[1])
      } while (!deadline.aborted)
      await delay(500, undefined, { signal: deadline })
    }
  } catch (error) {
    if (!deadline.aborted) throw error
  }
  throw new Error(`FaultThread: collector did not confirm the uploaded release files within ${seconds}s`)
}
