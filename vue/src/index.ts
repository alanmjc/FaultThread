import * as Sentry from '@sentry/vue'
import type { BrowserOptions, ErrorEvent } from '@sentry/vue'
import { watch, type App, type Plugin } from 'vue'
import { asRecord, httpMethod, responseRequestId } from './http.js'
import { errorTransport, type TransportFactory } from './transport.js'
import { EventDelivery } from './event-delivery.js'
import type { DeliveryStatus } from './outbox.js'
import { publicDsn } from './collector-url.js'
import {
  isReportableHttpFailure, isRequestId, sanitizeUrl, sanitizeBreadcrumb,
  type HttpContext, type HttpObserver, type PrivacyPolicy,
} from './policy.js'

export type { PrivacyPolicy, TextCaptureMode } from './policy.js'

export interface ObserverOptions {
  application: string
  dsn?: string
  environment?: string
  release?: string
  privacy?: PrivacyPolicy
  transport?: BrowserOptions['transport']
  onDeliveryError?: (error: Error) => void
}

interface MatchedRoute {
  matched: ReadonlyArray<{ path: string }>
}

export interface ObserverInstallOptions {
  router?: {
    afterEach(guard: (to: MatchedRoute, from: MatchedRoute, failure?: unknown) => void): () => void
    onError(handler: (error: Error) => void): () => void
  }
  adapters?: Array<(observer: Observer) => () => void>
  getUserId?: () => string | number | null | undefined
}

export interface Observer extends HttpObserver {
  readonly active: boolean
  install(app: App, options?: ObserverInstallOptions): void
  recordAction(action: string, outcome?: string): void
  identifyUser(id: string | number | null | undefined): void
  reportError(error: unknown): void
  close(): Promise<boolean>
}

export interface ObserverClient extends Observer {
  reportLog(message: string, level?: 'info' | 'warning' | 'error' | 'fatal'): string | null
  deliveryStatus(): Promise<DeliveryStatus | null>
  retryDelivery(): Promise<void>
}

// The SDK global handlers have one active client per browser realm.
let activeObserver: Observer | undefined

const reportableFailure = (error: Record<string, unknown> | undefined, context?: HttpContext) => {
  const response = asRecord(error?.response)
  const status = context?.status ?? response?.status ?? undefined
  const canceled = error?.code === 'ERR_CANCELED' || error?.name === 'AbortError'
  if (status !== undefined && typeof status !== 'number') return
  if (isReportableHttpFailure({ status, canceled }))
    return { status, config: asRecord(error?.config), response }
}

const prepareHttpEvent = (event: ErrorEvent, original: unknown, contexts: WeakMap<object, HttpContext>, privacy: PrivacyPolicy) => {
  const error = asRecord(original)
  const context = error && contexts.get(error)
  if (!context && error?.isAxiosError !== true) return event
  const failure = reportableFailure(error, context)
  if (!failure) return null
  const { status, config, response } = failure

  if (privacy.eventText === 'redact') {
    const method = context?.method ?? httpMethod(config?.method)
    const path = privacy.urls === 'redact' ? context?.url ?? sanitizeUrl(config?.url) : undefined
    const description = ['HTTP failure', status ?? 'network', method, path].filter(Boolean).join(' ')
    event.exception?.values?.forEach(value => { value.value = description })
  }
  const requestId = context?.requestId ?? responseRequestId(response)
  event.tags = {
    ...event.tags,
    ...(status !== undefined && status >= 500 ? { 'http.status_code': String(status) } : {}),
    ...(isRequestId(requestId) ? { request_id: requestId } : {}),
  }
  return event
}

// Later plugins can wrap either Vue hook. A retained wrapper must stop using this client on close.
const observeAppLifecycle = (app: App, originalHandler: App['config']['errorHandler'], close: () => void) => {
  const sdkHandler = app.config.errorHandler
  const originalUnmount = app.unmount
  let attached = true
  const handleError: NonNullable<App['config']['errorHandler']> = function (this: unknown, error, ...args) {
    if (attached && sdkHandler) return sdkHandler.call(this, error, ...args)
    if (originalHandler) return originalHandler.call(this, error, ...args)
    throw error
  }
  const unmount: App['unmount'] = function (this: unknown, ...args) {
    if (attached) close()
    return originalUnmount.apply(this, args)
  }
  app.config.errorHandler = handleError
  app.unmount = unmount
  return () => {
    attached = false
    if (app.config.errorHandler === handleError) app.config.errorHandler = originalHandler
    if (app.unmount === unmount) app.unmount = originalUnmount
  }
}

export const createObserver = (options: ObserverOptions): ObserverClient & Plugin<[ObserverInstallOptions?]> => {
  if (!options?.application?.trim()) throw new TypeError('Observability: application is required')
  const privacy = { ...options.privacy }
  let client: ReturnType<typeof Sentry.init>
  let delivery: EventDelivery | undefined
  let deliveryDsn: string | undefined
  let installedApp: App | undefined
  let closing: Promise<boolean> | undefined
  let contexts = new WeakMap<object, HttpContext>()
  const cleanups: Array<() => void> = []
  const logFailure = () => console.error('Observability: internal failure')

  const reportDeliveryError = (error: Error) => {
    try {
      if (options.onDeliveryError) options.onDeliveryError(error)
      else console.error(error.message)
    } catch { logFailure() }
  }

  const observer: ObserverClient = {
    async deliveryStatus() { return delivery ? delivery.status() : null },
    async retryDelivery() { await delivery?.retryBlocked() },
    get active() { return !!client && !closing },
    recordAction(action, outcome = 'attempt') {
      if (observer.active) Sentry.addBreadcrumb({
        category: 'action', message: action, level: outcome === 'error' ? 'error' : 'info', data: { outcome },
      })
    },
    identifyUser(id) {
      if (observer.active && privacy.captureUserId === true)
        Sentry.setUser(id !== undefined && id !== null ? { id: String(id) } : null)
    },
    recordRequest(context) {
      if (observer.active) Sentry.addBreadcrumb({
        category: 'http',
        message: 'HTTP request',
        level: !context.status || context.status >= 500 ? 'error' : 'info',
        data: {
          path: context.url, method: context.method ?? 'GET',
          status: context.status, requestId: context.requestId, durationMs: context.durationMs,
        },
      })
    },
    reportHttpFailure(error, context = {}) {
      if (!observer.active) return
      const failure = reportableFailure(asRecord(error), context)
      if (!failure) return
      const { status, config } = failure
      const exception = error instanceof Error ? error : new Error(`HTTP failure ${status ?? 'network'}`)
      if (contexts.has(exception)) return
      contexts.set(exception, {
        status,
        url: privacy.urls === 'redact' ? sanitizeUrl(context.url ?? config?.url) : undefined,
        method: httpMethod(context.method ?? config?.method ?? 'GET'),
        requestId: context.requestId,
      })
      Sentry.captureException(exception, { mechanism: { type: 'http', handled: true } })
    },
    reportError(error) {
      if (observer.active) Sentry.captureException(error)
    },
    reportLog(message, level = 'info') {
      return observer.active ? Sentry.captureMessage(message, level) : null
    },
    async close() {
      if (closing) return closing
      if (!client) return true
      const current = client
      // The Vue SDK schedules error capture on the next timer turn.
      closing = new Promise<void>(resolve => setTimeout(resolve, 0)).then(() => current.close(2000)).finally(() => {
        if (Sentry.getClient() === current) {
          Sentry.getIsolationScope().clear()
          const scope = Sentry.getCurrentScope()
          scope.clear()
          scope.setClient(undefined)
        }
        delivery?.stop()
        client = undefined
        installedApp = undefined
        activeObserver = undefined
        closing = undefined
        contexts = new WeakMap()
      })

      for (const cleanup of cleanups.splice(0).reverse()) {
        try { cleanup() } catch { logFailure() }
      }

      return closing
    },
    install(app, { router, adapters = [], getUserId } = {}) {
      if (!options.dsn) return
      if (installedApp === app) return
      const existing = Sentry.getClient()
      if (activeObserver || (existing?.getDsn() && existing.getOptions().enabled !== false))
        throw new Error('Observability: close the active observer or Sentry client before installing another')
      const dsn = publicDsn(options.dsn)
      activeObserver = observer
      installedApp = app
      try {
        const originalHandler = app.config.errorHandler
        Sentry.getIsolationScope().clear()
        Sentry.getCurrentScope().clear()
        const transport: TransportFactory = options.transport ?? (settings => {
          if (!delivery || deliveryDsn !== dsn) {
            delivery = new EventDelivery(options.application, dsn, settings.url, reportDeliveryError)
            deliveryDsn = dsn
          }
          delivery.start()
          return delivery
        })
        client = Sentry.init({
          app,
          dsn,
          environment: options.environment,
          release: options.release,
          transport: errorTransport(transport, options.application, privacy),
          transportOptions: { fetchOptions: { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' } },
          sendDefaultPii: false,
          enableLogs: false,
          enableMetrics: false,
          defaultIntegrations: false,
          integrations: [
            Sentry.vueIntegration({ app, attachProps: false }),
            Sentry.globalHandlersIntegration(),
          ],
          maxBreadcrumbs: 100,
          sendClientReports: false,
          beforeBreadcrumb: breadcrumb => sanitizeBreadcrumb(breadcrumb, privacy),
          beforeSend: (event, hint) => prepareHttpEvent(event, hint.originalException, contexts, privacy),
        })
        cleanups.push(observeAppLifecycle(app, originalHandler, () => { void observer.close().catch(logFailure) }))
        if (typeof document !== 'undefined') {
          const click = (event: MouseEvent) => {
            const element = event.target instanceof Element ? event.target.closest('button, a, [role="button"]') : null
            if (element) Sentry.addBreadcrumb({
              category: 'ui.click',
              message: element.getAttribute('data-observer-action') || element.tagName.toLowerCase(),
            })
          }
          document.addEventListener('click', click, true)
          cleanups.push(() => document.removeEventListener('click', click, true))
        }
        if (router) {
          cleanups.push(router.afterEach((to, from, failure) => {
            if (!failure) Sentry.addBreadcrumb({
              category: 'navigation',
              data: { from: from.matched.at(-1)?.path || '/', to: to.matched.at(-1)?.path || '/' },
            })
          }))
          cleanups.push(router.onError(observer.reportError))
        }
        for (const adapter of new Set(adapters)) cleanups.push(adapter(observer))
        if (getUserId && privacy.captureUserId === true)
          cleanups.push(watch(getUserId, observer.identifyUser, { immediate: true, flush: 'sync' }))
      } catch (error) {
        if (client) void observer.close().catch(logFailure)
        else {
          delivery?.stop()
          installedApp = undefined
          activeObserver = undefined
        }
        throw error
      }
    },
  }

  return observer
}
