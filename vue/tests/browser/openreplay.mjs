// Run after npm run build. CHROMIUM_PATH selects a Chromium-compatible browser.
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { json, runBrowser } from './chromium.mjs'

const batches = []
const canvasIds = new Set()
let started = 0, optedIn = false
await runBrowser({
  entries: { app: './openreplay-page.js' },
  onTrackerLoad() { assert.ok(optedIn, 'loaded tracker code before opt-in') },
  async scenario({ pathname, req, res, body, finish }) {
    if (pathname === '/check') {
      const check = JSON.parse(body)
      if (check.stage === 'failed') throw Error(check.message)
      if (check.stage === 'before') {
        assert.deepEqual(check.storage, [])
        optedIn = true
      }
      const stream = Buffer.concat(batches)
      const ready = stream.includes('captured-dom-mutation') && canvasIds.size > 0
      if (check.stage === 'finished') {
        assert.equal(started, 1)
        assert.ok(stream.includes('captured-first-snapshot') && ready, 'expected DOM and canvas data')
        assert.ok(check.visible && check.masked && check.visible !== check.masked)
        assert.deepEqual([...canvasIds], [String(check.visible)])
        finish()
      }
      return json(res, { ready })
    }
    if (!pathname.startsWith('/ingest/')) return res.writeHead(404).end()
    assert.ok(optedIn, 'OpenReplay contacted the collector before opt-in')
    const payload = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body
    for (const part of [req.url, JSON.stringify(req.headers), payload])
      assert.ok(!part.includes('private-fixture-'), 'private fixture appeared in ' + pathname)
    if (pathname === '/ingest/v1/web/start') {
      started++
      assert.equal(JSON.parse(body).projectKey, 'local-fixture')
      return json(res, {
        token: 'local-session-token', userUUID: 'local-user', projectID: '1', sessionID: '101',
        delay: 0, protocolVersion: 2, canvasEnabled: true, canvasQuality: 'high',
        canvasFPS: 20, framesSupport: true, compressionThreshold: 1000000,
      })
    }
    if (pathname === '/ingest/v1/web/i') batches.push(payload)
    if (pathname === '/ingest/v1/web/images') {
      const form = await new Response(body, { headers: { 'Content-Type': req.headers['content-type'] } }).formData()
      const frames = form.get('frames')
      assert.ok(frames && frames.size > 12, 'empty canvas frame upload')
      const match = /^\d+_(\d+)\.webp\.frames$/.exec(frames.name)
      assert.ok(match, 'unexpected canvas frame filename')
      canvasIds.add(match[1])
    }
    return json(res, pathname.endsWith('/tags') ? { tags: [] } : {})
  },
})
console.log('Verified replay opt-in, DOM snapshots, public canvas frames and private data filtering in Chromium.')
