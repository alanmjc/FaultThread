import { createApp, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import axios from 'axios'
import { createObserver, type PrivacyPolicy } from '@event-observability/vue'
import { createOpenReplay } from '@event-observability/vue/openreplay'
import { installEventDeliveryWorker, installOfflineAssets, installOpenReplayGateway } from '@event-observability/vue/openreplay-worker'
import { requestPersistentStorage } from '@event-observability/vue/storage'
import { DurableOutbox, type DeliveryResult } from '@event-observability/vue/outbox'
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
const logId: string | null = observer.reportLog('offline-save', 'warning')
void logId
void observer.deliveryStatus().then(status => status?.memoryOnly)
void observer.retryDelivery()
void observer.close()

const replay = createOpenReplay({ enabled: true, projectKey: 'public-project-key', gatewayPath: '/__observability/openreplay' })
app.use(replay)
const started: Promise<boolean> = replay.start()
void started
replay.stop()
void replay.deliveryStatus().then(status => status?.blocked)
void requestPersistentStorage().then(storage => storage.persistent)
const anotherCollector = new DurableOutbox<{ code: string }>('test:custom:v1', async (_payload, _id): Promise<DeliveryResult> => ({ state: 'ack' }))
void anotherCollector.put('unique-event-id', { code: 'save' })
installEventDeliveryWorker({ application: 'test', dsn: 'https://key@errors.example/1' })
installOpenReplayGateway({ projectKey: 'public-project-key', ingestPoint: 'https://replay.example/ingest' })
installOfflineAssets({ version: 'v1', assets: ['/main.js'], navigationFallback: { shell: '/index.html', paths: ['/app'] } })
