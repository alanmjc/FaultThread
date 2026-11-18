import type { Breadcrumb, ErrorEvent, Exception } from '@sentry/vue'
import { httpMethod } from './http.js'

export type TextCaptureMode = 'omit' | 'redact' | 'full'
export interface PrivacyPolicy {
  eventText?: TextCaptureMode
  breadcrumbText?: TextCaptureMode
  urls?: 'omit' | 'redact'
  captureUserId?: boolean
}
export interface HttpContext {
  status?: number
  url?: string
  method?: string
  requestId?: string
  durationMs?: number
}
export interface HttpObserver {
  recordRequest(context: HttpContext): void
  reportHttpFailure(error: unknown, context?: HttpContext): void
}

export const sanitizeUrl = (value: unknown): string | undefined => {
  if (!value) return undefined
  if (value === '[invalid URL]') return value
  try {
    const text = String(value)
    if (text.length > 4096) return '[invalid URL]'
    const url = new URL(text, 'http://observer.invalid')
    if (!['http:', 'https:'].includes(url.protocol)) return '[invalid URL]'
    const path = url.pathname.split('/').map(segment => {
      if (/@|%40/i.test(segment)) return ':redacted'
      if (/^\d+$/.test(segment) || /^[a-f\d]{8}-[a-f\d-]{27,}$/i.test(segment)) return ':id'
      return segment
    }).join('/')

    return url.origin === 'http://observer.invalid' ? path : `${url.origin}${path}`
  } catch {
    return '[invalid URL]'
  }
}

export const sanitizeMessage = (value: unknown): string => String(value ?? '').slice(0, 2048)
  .replace(/https?:\/\/[^\s)<>"']+/gi, url => sanitizeUrl(url) ?? '[invalid URL]')
  .replace(/(?:Bearer|Basic)\s+[^\s,;]+/gi, '******')
  .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email redacted]')
  .replace(/(\b(?:cookie|set-cookie|authorization)["']?\s*[:=][^\S\r\n]*)[^\r\n]*/gi, '$1[redacted]')
  .replace(/((?:password|token|contrasena|secret|api[_-]?key)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|[^\s,;]+)/gi,
    (_, key: string, secret: string) => {
      const quote = secret[0] === '"' || secret[0] === "'" ? secret[0] : ''
      return `${key}${quote}[redacted]${quote}`
    })
  .slice(0, 500)

const applyTextMode = (value: unknown, mode?: TextCaptureMode) => {
  if (typeof value !== 'string') return undefined
  if (mode === 'redact') return sanitizeMessage(value)
  if (mode === 'full') return value
  return undefined
}

export const isRequestId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 64 && !/[^a-z\d-]/i.test(value)
export const isReportableHttpFailure = ({ status, canceled = false }: { status?: number; canceled?: boolean }) =>
  !canceled && (status == null || status === 0 || (Number.isInteger(status) && status >= 500 && status <= 599))

const httpStatus = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
const levels = new Set(['fatal', 'error', 'warning', 'log', 'info', 'debug'])
const label = (value: unknown) => typeof value === 'string' && /^[\w.$<>-]{1,150}$/.test(value) ? value : undefined

export const sanitizeBreadcrumb = (breadcrumb: Breadcrumb, privacy: PrivacyPolicy = {}): Breadcrumb | null => {
  const { category } = breadcrumb
  const base = {
    category,
    timestamp: Number.isFinite(breadcrumb.timestamp) ? breadcrumb.timestamp : undefined,
    level: breadcrumb.level && levels.has(breadcrumb.level) ? breadcrumb.level : undefined,
    type: label(breadcrumb.type),
  }
  const data: Record<string, unknown> = breadcrumb.data ?? {}
  const includeUrls = privacy.urls === 'redact'
  if (category === 'xhr' || category === 'fetch') {
    return {
      ...base,
      data: { method: httpMethod(data.method), url: includeUrls ? sanitizeUrl(data.url) : undefined, status_code: httpStatus(data.status_code) },
    }
  }
  if (category === 'navigation') {
    return {
      ...base,
      data: includeUrls ? { from: sanitizeUrl(data.from), to: sanitizeUrl(data.to) } : undefined,
    }
  }
  if (category === 'action' || category === 'ui.click' || category === 'http') {
    return {
      ...base,
      message: applyTextMode(breadcrumb.message, privacy.breadcrumbText),
      data: {
        outcome: applyTextMode(data.outcome, privacy.breadcrumbText),
        status: httpStatus(data.status),
        method: httpMethod(data.method),
        path: includeUrls ? sanitizeUrl(data.path) : undefined,
        requestId: isRequestId(data.requestId) ? data.requestId : undefined,
        durationMs: typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) && data.durationMs >= 0 ? data.durationMs : undefined,
      },
    }
  }

  return null
}

const frameFilename = (value: unknown, privacy: PrivacyPolicy) => {
  const filename = sanitizeUrl(value)
  // Inline scripts can have the page's URL as their filename.
  return privacy.urls === 'redact' || /\.(?:[cm]?[jt]sx?|vue|wasm)$/i.test(filename ?? '') ? filename : undefined
}

const sanitizeException = (value: Exception, privacy: PrivacyPolicy): Exception => ({
  type: label(value.type),
  value: applyTextMode(value.value, privacy.eventText) ?? '[omitted]',
  mechanism: value.mechanism ? {
    // Sentry requires a type in memory. The wire representation omits rejected labels.
    type: label(value.mechanism.type) as string,
    handled: typeof value.mechanism.handled === 'boolean' ? value.mechanism.handled : undefined,
  } : undefined,
  stacktrace: value.stacktrace ? {
    frames: value.stacktrace.frames?.map(frame => ({
      filename: frameFilename(frame.filename, privacy),
      function: label(frame.function),
      lineno: Number.isInteger(frame.lineno) ? frame.lineno : undefined,
      colno: Number.isInteger(frame.colno) ? frame.colno : undefined,
      in_app: typeof frame.in_app === 'boolean' ? frame.in_app : undefined,
    })),
  } : undefined,
})

const statusTag = (value: unknown) => (typeof value === 'string' || Number.isInteger(value)) && /^[45]\d{2}$/.test(String(value))

export const sanitizeEvent = (event: ErrorEvent, application: string, privacy: PrivacyPolicy = {}): ErrorEvent => {
  const sanitized: Omit<ErrorEvent, 'type'> = {
    event_id: typeof event.event_id === 'string' && /^[a-f\d]{32}$/i.test(event.event_id) ? event.event_id : undefined,
    timestamp: Number.isFinite(event.timestamp) ? event.timestamp : undefined,
    platform: label(event.platform),
    level: event.level && levels.has(event.level) ? event.level : undefined,
    release: typeof event.release === 'string' ? event.release : undefined,
    environment: typeof event.environment === 'string' ? event.environment : undefined,
    exception: event.exception ? {
      values: event.exception.values?.map(value => sanitizeException(value, privacy)),
    } : undefined,
    message: event.message ? applyTextMode(event.message, privacy.eventText) ?? 'Application event' : undefined,
    transaction: privacy.urls === 'redact' ? sanitizeUrl(event.transaction) : undefined,
    request: privacy.urls === 'redact' && event.request ? { url: sanitizeUrl(event.request.url) } : undefined,
    user: privacy.captureUserId === true && (typeof event.user?.id === 'string' || typeof event.user?.id === 'number') ? { id: String(event.user.id) } : undefined,
    tags: {
      application,
      ...(isRequestId(event.tags?.request_id) ? { request_id: event.tags.request_id } : {}),
      ...(event.tags && statusTag(event.tags['http.status_code']) ? { 'http.status_code': String(event.tags['http.status_code']) } : {}),
    },
    breadcrumbs: event.breadcrumbs?.map(breadcrumb => sanitizeBreadcrumb(breadcrumb, privacy)).filter(breadcrumb => breadcrumb !== null),
  }
  // The SDK types model errors with type: undefined. Its wire format omits that field.
  return sanitized as ErrorEvent
}
