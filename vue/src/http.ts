import type { HttpContext } from './policy.js'

// Collector failures must not produce another error through a globally observed fetch.
export const collectorRequest = Symbol('observability.collectorRequest')

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'])

export const asRecord = (value: unknown) =>
  value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<string, unknown>
    : undefined

export const httpMethod = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  const method = value.toUpperCase()
  return methods.has(method) ? method : undefined
}

export const responseRequestId = (response: unknown): unknown => {
  const headers = asRecord(asRecord(response)?.headers)
  if (!headers) return undefined
  if (typeof headers.get === 'function') return headers.get('x-request-id')
  const key = Object.keys(headers).find(name => name.toLowerCase() === 'x-request-id')
  return key === undefined ? undefined : headers[key]
}

export const responseContext = (response: unknown, start: number, url?: string, method?: string): HttpContext => {
  // Custom observers receive the original adapter values, including a missing Fetch header (null).
  return {
    status: asRecord(response)?.status as HttpContext['status'],
    url,
    method,
    requestId: responseRequestId(response) as HttpContext['requestId'],
    durationMs: Math.max(0, Date.now() - start),
  }
}

export const notify = (callback: () => void) => {
  try {
    callback()
  } catch {
    console.error('FaultThread: HTTP adapter failure')
  }
}
