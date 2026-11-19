import { createApp, h } from 'vue'
import { createObserver } from '@faultthread/vue'
import { createOpenReplay } from '@faultthread/vue/openreplay'

const check = async (stage, details = {}) => (await fetch('/check', {
  method: 'POST', body: JSON.stringify({ stage, ...details }),
})).json()
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(label, predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return
    await pause(250)
  }
  throw Error('Timed out waiting for ' + label)
}
async function run() {
  if (!navigator.serviceWorker.controller) await navigator.serviceWorker.register('/worker.js', { type: 'module' })
  await navigator.serviceWorker.ready
  await waitFor('a controlling service worker', () => !!navigator.serviceWorker.controller)
  const app = createApp({ render: () => h('main', [
    h('h1', { 'data-openreplay-unmask': '' }, 'offline-first-frame'),
    h('p', 'private-fixture-offline'),
  ]) })
  const dsn = new URL('/1', location.origin)
  dsn.username = 'public'
  const observer = createObserver({ application: 'offline-fixture', dsn: dsn.href })
  const replay = createOpenReplay({ enabled: true, projectKey: 'local-fixture' })
  app.use(observer).use(replay).mount('#app')

  if (!sessionStorage.getItem('fixture-reloaded')) {
    history.replaceState({}, '', '/')
    await check('cut-network')
    if (!await replay.start()) throw Error('Consent while the collector is unreachable failed')
    observer.reportHttpFailure(new Error('private-fixture-error'), { status: 503, requestId: 'offline-request' })
    sessionStorage.setItem('offline-log-id', observer.reportLog('private-fixture-log', 'warning'))
    await pause(500)
    document.querySelector('h1').textContent = 'offline-last-frame'
    await pause(600)
    document.body.dispatchEvent(new MouseEvent('mouseleave'))
    await waitFor('durable copies of the replay and error', async () =>
      (await replay.deliveryStatus())?.pending > 0 && (await observer.deliveryStatus())?.pending === 2)
    replay.stop()
    await pause(500)
    await check('stored')
    sessionStorage.setItem('fixture-reloaded', '1')
    location.reload()
    return
  }
  const sentry = await observer.deliveryStatus()
  const recording = await replay.deliveryStatus()
  await check('reconnected', { sentry, recording, offlineShell: !!document.querySelector('meta[name=public-offline-shell]') })
  window.dispatchEvent(new Event('online'))
  await waitFor('both queues to drain after reconnect', async () => {
    const events = await observer.deliveryStatus(), sessions = await replay.deliveryStatus()
    return events?.pending === 0 && sessions?.pending === 0 && events.blocked === 0 && sessions.blocked === 0
  })
  await check('finished', { logId: sessionStorage.getItem('offline-log-id') })
}
run().catch(error => check('failed', {message: String(error)}))
