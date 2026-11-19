import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { json, runBrowser } from './chromium.mjs'

const events = [], batches = [], digests = new Set()
let lostAssets = false, connected = false, failedAttempts = 0, stored = false, sessions = 0
await runBrowser({
  entries: { app: './delivery-page.js', worker: './delivery-worker.js' },
  timeoutMs: 60000,
  assetsUnavailable: () => lostAssets,
  async scenario({ pathname, req, res, body, finish }) {
    if (pathname === '/check') {
      const check = JSON.parse(body)
      if (check.stage === 'cut-network') lostAssets = true
      if (check.stage === 'stored') {
        assert.ok(failedAttempts > 0 && !connected)
        stored = true
      }
      if (check.stage === 'reconnected') {
        assert.ok(lostAssets && check.offlineShell, 'page must reload from the precached public shell')
        assert.ok(stored && check.sentry.pending > 0 && check.recording.pending > 0)
        connected = true
        lostAssets = false
      }
      if (check.stage === 'finished') {
        assert.equal(events.length, 2, 'both independent events confirmed after reconnect')
        const error = events.find(event => event.tags.request_id === 'offline-request')
        assert.match(error.event_id, /^[a-f\d]{32}$/)
        const log = events.find(event => event.event_id === check.logId)
        assert.equal(log.level, 'warning')
        assert.equal(log.message, 'Application event')
        assert.equal(sessions, 1, 'a single remote replay session')
        const data = Buffer.concat(batches)
        for (const marker of ['offline-first-frame', 'offline-last-frame']) assert.ok(data.includes(marker), marker)
        finish()
      }
      return json(res, {})
    }
    if (!pathname.startsWith('/ingest/') && pathname !== '/api/1/envelope/') return res.writeHead(404).end()
    if (!connected) {
      failedAttempts++
      req.socket.destroy()
      return
    }
    const payload = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body
    assert.ok(!payload.includes('private-fixture-'), 'private data sent to a collector')
    if (pathname === '/api/1/envelope/') {
      const [header, item, event] = payload.toString().trim().split('\n').map(line => JSON.parse(line))
      assert.equal(item.type, 'event')
      assert.equal(event.event_id, header.event_id)
      events.push(event)
    }
    if (pathname === '/ingest/v1/web/start') {
      sessions++
      assert.equal(JSON.parse(body).projectKey, 'local-fixture')
      return json(res, { token: 'local-real-token', userUUID: 'local-uuid', projectID: '1', sessionID: '123', delay: 0 })
    }
    if (pathname === '/ingest/v1/web/i') {
      assert.equal(req.headers.authorization, 'Bearer local-real-token')
      const digest = createHash('sha256').update(payload).digest('hex')
      assert.ok(!digests.has(digest), 'repeated acknowledged replay packet')
      digests.add(digest)
      batches.push(payload)
    }
    return json(res, {})
  },
})
console.log('Recovered the error, independent log and full replay after a network outage and offline reload.')
