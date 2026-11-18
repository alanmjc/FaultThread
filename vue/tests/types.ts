import { createApp, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import axios from 'axios'
import { createObserver, type PrivacyPolicy } from '@event-observability/vue'
import { observeFetch } from '@event-observability/vue/fetch'
import { observeAxios } from '@event-observability/vue/axios'
import { createObservedFetch } from '@event-observability/vue/vueuse'
import { observabilitySourcemaps } from '@event-observability/vue/rollup'
import { observabilitySourcemaps as viteSourcemaps } from '@event-observability/vue/vite'
import { isRequestId, type HttpContext } from '@event-observability/vue/policy'
import type { RollupOptions } from 'rollup'
import type { UserConfig } from 'vite'

const privacy: PrivacyPolicy = { eventText: 'omit', urls: 'redact', captureUserId: true }
const observer = createObserver({ application: 'test', dsn: '', privacy })
const app = createApp({})
app.use(observer, {
  router: createRouter({ history: createMemoryHistory(), routes: [] }),
  adapters: [observer => observeAxios(axios, observer)],
  getUserId: () => 42,
})
const fetchApi: typeof fetch = observeFetch(fetch, observer)
void fetchApi(new Request('https://example.test'), { method: 'GET' })
const useApi = createObservedFetch({ options: { immediate: false } }, observer)
const request = useApi(ref('/api/test')).get().json<{ ok: boolean }>()
request.data.value?.ok
const build: RollupOptions = { plugins: [observabilitySourcemaps({ enabled: false, base: '/assets/' })] }
void build
const viteBuild: UserConfig = { plugins: [viteSourcemaps({ enabled: false })] }
void viteBuild
const context: HttpContext = { status: 503, requestId: 'test-123' }
if (isRequestId(context.requestId)) context.requestId.toLowerCase()
observer.reportHttpFailure(new Error('test'), context)
void observer.close()
