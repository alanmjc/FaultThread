import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

export const json = (res, body) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))

// Bundle the public entries and restrict the browser to a loopback HTTP server.
export async function runBrowser({ entries, scenario, onTrackerLoad, assetsUnavailable, timeoutMs = 30000 }) {
  const input = Object.fromEntries(Object.entries(entries).map(([name, file]) => [name, fileURLToPath(new URL(file, import.meta.url))]))
  const { output } = await build({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false, publicDir: false, logLevel: 'error',
    build: { write: false, target: 'es2022', rollupOptions: { input, output: { entryFileNames: '[name].js' } } },
  })
  const chunks = new Map(output.filter(file => file.type === 'chunk').map(file => ['/' + file.fileName, file]))
  const trackerChunks = new Set([...chunks.values()].filter(file =>
    Object.keys(file.modules).some(id => id.includes('@openreplay/tracker/'))).map(file => '/' + file.fileName))
  if (!trackerChunks.size) throw Error('Missing tracker code in the browser bundle')

  let resolve, reject
  const done = new Promise((ok, fail) => { resolve = ok; reject = fail })
  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost')
      const page = pathname === '/' || pathname === '/fallback.html'
      if ((page || chunks.has(pathname)) && assetsUnavailable?.()) { req.socket.destroy(); return }
      if (page) return res.writeHead(200, {
        'Cache-Control': pathname === '/fallback.html' ? 'public, max-age=0' : 'no-store',
        'Content-Type': 'text/html', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'",
      }).end('<!doctype html><meta charset="utf-8">' + (pathname === '/fallback.html' ? '<meta name="public-offline-shell">' : '') +
        '<div id="app"></div><script type="module" src="/app.js"></script>')
      if (chunks.has(pathname)) {
        if (trackerChunks.has(pathname)) onTrackerLoad?.()
        const manifest = pathname === '/worker.js' ? 'self.fixturePublicAssets = ' + JSON.stringify([...chunks.keys()].filter(k => k !== '/worker.js')) + ';\n' : ''
        return res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=0' }).end(manifest + chunks.get(pathname).code)
      }
      const parts = []
      for await (const part of req) parts.push(part)
      const body = Buffer.concat(parts)
      if (pathname === '/check') {
        const check = JSON.parse(body)
        if (check.stage === 'failed') throw Error(check.message)
      }
      await scenario({ pathname, req, res, body, finish: resolve })
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end()
      reject(error)
    }
  })

  const profile = await mkdtemp(join(tmpdir(), 'observability-chromium-'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const browser = spawn(process.env.CHROMIUM_PATH || 'chromium', [
    '--headless', '--no-first-run', '--disable-background-networking', '--disable-sync',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--user-data-dir=' + profile,
    'http://127.0.0.1:' + server.address().port + '/?private-fixture-initial-query#private-fixture-initial-hash',
  ], { stdio: 'ignore' })
  const exited = new Promise(ok => browser.once('close', ok))
  browser.once('error', reject)
  browser.once('exit', code => reject(Error('Chromium exited with code ' + code)))
  const timeout = setTimeout(() => reject(Error('Timed out waiting for browser observations')), timeoutMs)
  try {
    await done
  } finally {
    clearTimeout(timeout)
    browser.kill()
    await exited
    server.close()
    server.closeAllConnections()
    await rm(profile, { recursive: true, force: true, maxRetries: 5 })
  }
}
