import axios, { type AxiosInstance, type AxiosStatic } from 'axios'
import type { HttpObserver } from './policy.js'
import { asRecord, notify, responseContext } from './http.js'

export const observeAxios = (client: AxiosInstance | AxiosStatic, observer: HttpObserver) => {
  let attached = true
  const intercept = client.interceptors.request.use(config => {
    const originalAdapter = config.adapter
    config.adapter = async request => {
      // Let Axios retries and the host adapter see the original configuration.
      request.adapter = originalAdapter
      const start = Date.now()
      let response
      try {
        response = await axios.getAdapter(originalAdapter || axios.defaults.adapter, request)(request)
      } catch (error) {
        if (!attached) throw error
        const context = responseContext(asRecord(error)?.response, start, request.url, request.method)
        notify(() => observer.recordRequest(context))
        notify(() => observer.reportHttpFailure(error, context))
        throw error
      }

      if (!attached) return response
      const context = responseContext(response, start, request.url, request.method)
      notify(() => observer.recordRequest(context))
      if (response.status >= 500 && response.status <= 599)
        notify(() => observer.reportHttpFailure(new Error(`HTTP ${response.status}`), context))

      return response
    }
    return config
  }, undefined, { synchronous: true })

  return () => {
    attached = false
    client.interceptors.request.eject(intercept)
  }
}
