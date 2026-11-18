import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readdir, readFile, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SentryCli from '@sentry/cli'
import { rollup } from 'rollup'
import { waitForReleaseFiles } from '../dist/release-files.js'
import { observabilitySourcemaps } from '@event-observability/vue/rollup'
import { observabilitySourcemaps as viteSourcemaps } from '@event-observability/vue/vite'

const options = {
  enabled: true, release: 'example@sha', url: 'https://observer.invalid',
  org: 'example', project: 'frontend', authToken: 'synthetic-test-token',
}

test('sourcemap upload is independent from capture and validates credentials', () => {
  assert.equal(observabilitySourcemaps({ enabled: false }), null)
  assert.equal(observabilitySourcemaps({ enabled: 'false' }), null)
  assert.throws(() => observabilitySourcemaps({ enabled: true }), /release/)
  assert.throws(() => observabilitySourcemaps({ ...options, collector: 'unknown' }), /collector/)
  assert.throws(() => observabilitySourcemaps({ ...options, processingTimeoutSeconds: 0 }), /processingTimeoutSeconds/)
  assert.throws(() => observabilitySourcemaps({ ...options, url: 'http://observer.invalid' }), /HTTPS/)
  assert.doesNotThrow(() => observabilitySourcemaps({ ...options, url: 'http://127.0.0.1:9000' }))
})

test('Vite only enables private sourcemaps during builds', () => {
  assert.equal(viteSourcemaps({ enabled: false }), null)
  const plugin = viteSourcemaps(options)
  assert.equal(plugin.apply, 'build')
  assert.equal(plugin.enforce, 'post')
  assert.equal(plugin.config().build.sourcemap, 'hidden')
})

test('an in-memory build returns its sourcemap without uploading it', async t => {
  const release = t.mock.method(new SentryCli(null, {}).releases.constructor.prototype, 'new', async () => {})
  const id = 'memory-entry.js'
  const bundle = await rollup({
    input: id,
    plugins: [
      { name: 'memory-entry', resolveId: () => id, load: () => 'export const ok = true' },
      observabilitySourcemaps(options),
    ],
  })
  try {
    const { output } = await bundle.generate({ format: 'es' })
    assert.deepEqual(output.map(file => file.fileName), [id, id + '.map'])
    assert.equal(release.mock.callCount(), 0)
  } finally {
    await bundle.close()
  }
})

test('real Rollup build uploads nested hidden maps and removes them on success and failure', async t => {
  const Releases = new SentryCli(null, {}).releases.constructor
  const calls = []
  t.mock.method(Releases.prototype, 'new', async release => { calls.push(release) })
  t.mock.method(Releases.prototype, 'finalize', async () => {})
  const uploads = []
  let fail = false
  t.mock.method(SentryCli.prototype, 'execute', async args => {
    assert.equal(args[args.indexOf('--wait-for') + 1], '60')
    const staging = args.at(-1)
    uploads.push(staging)
    assert.deepEqual(await readdir(staging), ['nested'])
    assert.deepEqual((await readdir(join(staging, 'nested'))).sort(), ['app.js', 'app.js.map'])
    const map = JSON.parse(await readFile(join(staging, 'nested/app.js.map'), 'utf8'))
    assert.ok(map.sources.some(name => name.endsWith('/src/main.js')))
    calls.push(args)
    if (fail) throw new Error('upload failed')
    return ''
  })
  const root = await mkdtemp(join(tmpdir(), 'observability-rollup-'))
  try {
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, 'dist/independent.map'), 'owned by another tool')
    await writeFile(join(root, 'src/main.js'), 'export const greet = name => `Hello ${name}`')
    const build = async () => {
      const bundle = await rollup({
        input: join(root, 'src/main.js'),
        plugins: [observabilitySourcemaps({ ...options, base: '/build/' })],
      })
      try {
        await bundle.write({ dir: join(root, 'dist'), format: 'es', entryFileNames: 'nested/app.js' })
      } finally {
        await bundle.close()
      }
    }
    await build()
    await access(join(root, 'dist/nested/app.js'))
    await assert.rejects(access(join(root, 'dist/nested/app.js.map')))
    assert.doesNotMatch(await readFile(join(root, 'dist/nested/app.js'), 'utf8'), /sourceMappingURL=/)
    assert.equal(await readFile(join(root, 'dist/independent.map'), 'utf8'), 'owned by another tool')
    assert.ok(calls.some(call => Array.isArray(call) && call.includes('~/build/') && call.includes('--no-rewrite')))
    fail = true
    await assert.rejects(build(), /upload failed/)
    assert.equal(uploads.length, 2)
    for (const path of uploads) await assert.rejects(access(path), { code: 'ENOENT' })
    await assert.rejects(access(join(root, 'dist/nested/app.js.map')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('GlitchTip readiness polls exact file content and follows only same-endpoint cursors', async t => {
  const endpoint = new URL('https://collector.invalid/self-hosted/')
  const expected = new Map([['app.js', 'js-hash'], ['app.js.map', 'map-hash']])
  const pages = [
    new Response(JSON.stringify([{ name: 'app.js', sha1: 'stale' }])),
    new Response(JSON.stringify([{ name: 'app.js', sha1: 'js-hash' }]), {
      headers: { link: '<https://another.invalid/>; rel="next"; results="true"; cursor="second"' },
    }),
    new Response(JSON.stringify([{ name: 'app.js.map', sha1: 'map-hash' }])),
  ]
  const cursors = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url.origin, endpoint.origin)
    assert.equal(url.pathname, '/self-hosted/api/0/projects/example/frontend/releases/example%40sha/files/')
    assert.equal(init.headers.Authorization, 'Bearer ' + options.authToken)
    assert.equal(init.redirect, 'error')
    cursors.push(url.searchParams.get('cursor'))
    return pages.shift()
  })
  await waitForReleaseFiles(endpoint, options, expected, 3)
  assert.deepEqual(cursors, [null, null, 'second'])
})

test('unprocessed maps block publication and verification errors omit response details', async t => {
  const endpoint = new URL(options.url)
  const expected = new Map([['app.js.map', 'expected']])
  t.mock.method(globalThis, 'fetch', async () => new Response('[]'))
  await assert.rejects(waitForReleaseFiles(endpoint, options, expected, 1), /did not confirm/)
  globalThis.fetch.mock.mockImplementation(async () => new Response(options.authToken))
  await assert.rejects(waitForReleaseFiles(endpoint, options, expected, 1), { message: 'Observability: collector returned an invalid release file list' })
})
