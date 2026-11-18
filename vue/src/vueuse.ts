import { createFetch, type useFetch, type UseFetchOptions } from '@vueuse/core'
import type { HttpObserver } from './policy.js'
import { observeFetch } from './fetch.js'

type CallOption = (RequestInit & UseFetchOptions) | undefined
type FetchClient = <T>(url: Parameters<typeof useFetch>[0], ...args: CallOption[]) => ReturnType<typeof useFetch<T>>

export const createObservedFetch = (
  config: NonNullable<Parameters<typeof createFetch>[0]>,
  observer: HttpObserver,
): ReturnType<typeof createFetch> => {
  const options = config.options ?? {}
  const client: FetchClient = createFetch({
    ...config,
    options: {
      ...options,
      fetch: observeFetch(options.fetch ?? globalThis.fetch.bind(globalThis), observer),
    },
  })

  // VueUse also accepts a custom fetch in the options of an individual call.
  return (url, ...args: CallOption[]) => client(url, ...args.map(arg => typeof arg?.fetch === 'function'
    ? { ...arg, fetch: observeFetch(arg.fetch, observer) }
    : arg))
}
