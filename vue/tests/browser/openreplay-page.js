import { createApp, h } from 'vue'
import { createOpenReplay } from '@event-observability/vue/openreplay'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const checkpoint = async (stage, details = {}) => {
  const response = await fetch('/check', { method: 'POST', body: JSON.stringify({ stage, ...details }) })
  return response.json()
}

async function exercise() {
  const options = { projectKey: 'local-fixture', ingestPoint: location.origin + '/ingest' }
  const off = createOpenReplay(options)
  const replay = createOpenReplay({ ...options, enabled: true })
  const app = createApp({ render: () => h('main', [
    h('p', 'private-fixture-unmarked'),
    h('canvas', { id: 'masked', width: 48, height: 48 }),
    h('section', { 'data-openreplay-unmask': '' }, [
      h('h1', 'private-fixture-before-consent'),
      h('canvas', { id: 'visible', 'data-openreplay-unmask': '', width: 48, height: 48 }),
      h('div', { 'data-openreplay-hidden': '' }, 'private-fixture-subtree'),
      h('input', { type: 'password', value: 'private-fixture-password' }),
      h('input', { type: 'radio', value: 'private-fixture-radio' }),
      h('input', { type: 'email', value: 'private-fixture-email@example.invalid' }),
      h('textarea', 'private-fixture-textarea'),
      h('select', [h('option', { value: 'private-fixture-option' }, 'private-fixture-label')]),
      h('div', { contenteditable: 'true' }, 'private-fixture-editable'),
    ]),
  ]) })
  app.use(off).use(replay).mount('#app')
  if (await off.start()) throw Error('Disabled replay started')
  await wait(250)
  await checkpoint('before', { storage: [...Object.keys(sessionStorage), ...Object.keys(localStorage)] })
  const title = document.querySelector('h1')
  title.textContent = 'captured-first-snapshot'
  for (const id of ['visible', 'masked']) {
    const context = document.getElementById(id).getContext('2d')
    context.fillStyle = id === 'visible' ? 'red' : 'green'
    context.fillRect(0, 0, 48, 48)
  }
  if (!await replay.start()) throw Error('Tracker failed to start')
  await wait(350)
  history.pushState({}, '', '/route?private-fixture-query#private-fixture-hash')
  title.textContent = 'captured-dom-mutation'
  title.style.backgroundColor = 'orange'
  const password = document.querySelector('input[type=password]')
  password.value = 'private-fixture-typed'
  password.dispatchEvent(new Event('change', { bubbles: true }))
  // Ask the actual worker to flush, the same way it does when a user leaves the page.
  for (let i = 0; i < 60; i++) {
    document.body.dispatchEvent(new MouseEvent('mouseleave'))
    await wait(250)
    if ((await checkpoint('poll')).ready) break
  }
  // Correlate real uploaded canvas frames with the node IDs assigned by the tracker.
  const canvasId = id => window.__OPENREPLAY__.use(app => app.nodes.getID(document.getElementById(id)))
  const visible = canvasId('visible'), masked = canvasId('masked')
  replay.stop()
  title.textContent = 'private-fixture-after-stop'
  await wait(700)
  document.body.dispatchEvent(new MouseEvent('mouseleave'))
  await wait(700)
  app.unmount()
  await checkpoint('finished', { visible, masked })
}

exercise().catch(error => checkpoint('failed', { message: String(error) }))
