import type { HttpObserver } from './policy.js'
import { asRecord, notify, responseContext } from './http.js'

type FetchResource = Partial<Pick<Request, 'url' | 'method' | 'signal'> & Pick<URL, 'href'>>

/** Observe each exchange at the fetch boundary, before any shared reactive state changes. */
export const observeFetch = (fetchImplementation: typeof fetch, observer: HttpObserver): typeof fetch => async (input, init) => {
  const start = Date.now()
  const request: FetchResource | undefined = typeof input === 'string' ? undefined : input
  const url = typeof input === 'string' ? input : request?.url ?? request?.href
  const method = init?.method ?? request?.method ?? 'GET'
  let response
  try {
    response = await fetchImplementation(input, init)
  } catch (error) {
    const context = responseContext(undefined, start, url, method)
    notify(() => observer.recordRequest(context))
    if (!(init?.signal ?? request?.signal)?.aborted && asRecord(error)?.name !== 'AbortError')
      notify(() => observer.reportHttpFailure(error, context))
    throw error
  }
  const context = responseContext(response, start, url, method)
  notify(() => observer.recordRequest(context))
  if (response.status >= 500 && response.status <= 599)
    notify(() => observer.reportHttpFailure(new Error(`HTTP ${response.status}`), context))

  return response
}
