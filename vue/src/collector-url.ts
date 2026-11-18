export const usesSecureTransport = (url: URL): boolean => {
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  const host = url.hostname
  return host === 'localhost' || host === 'localhost.' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)
}
