export const defaultReplayGatewayPath = '/__observability/openreplay'

export const usesSecureTransport = (url: URL): boolean => {
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  const host = url.hostname
  return host === 'localhost' || host === 'localhost.' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

export const publicDsn = (value: string) => {
  let url
  try { url = new URL(value) } catch { throw new TypeError('FaultThread: invalid DSN') }
  // Match the SDK's host syntax before it can print an unparseable DSN.
  const validHost = /^[\w.-]+$/.test(url.hostname) || /^\[[\da-f:]+\]$/i.test(url.hostname)
  if (!validHost || !usesSecureTransport(url) || !/^\w+$/.test(url.username) ||
      url.password || url.search || url.hash || !/^\/(?:[^/]+\/)*\d+$/.test(url.pathname))
    throw new TypeError('FaultThread: invalid DSN')
  return url.href
}
