import { installEventDeliveryWorker, installOfflineAssets, installOpenReplayGateway } from '@event-observability/vue/openreplay-worker'

installOpenReplayGateway({ projectKey: 'local-fixture', ingestPoint: location.origin + '/ingest' })
const dsn = new URL('/1', location.origin)
dsn.username = 'public'
installEventDeliveryWorker({ application: 'offline-fixture', dsn: dsn.href })

installOfflineAssets({
  version: 'browser-fixture-v1', assets: self.fixturePublicAssets,
  navigationFallback: { shell: '/fallback.html', paths: ['/'] },
})
