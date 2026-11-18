import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import type { Plugin } from 'rollup'
import { validateUploadOptions, type SourcemapOptions } from './sourcemaps.js'
import { waitForReleaseFiles } from './release-files.js'
import { usesSecureTransport } from './collector-url.js'

export interface RollupSourcemapOptions extends SourcemapOptions {
  base?: string
}

const writeArtifact = async (
  directory: string,
  name: string,
  contents: string | Uint8Array,
  expected?: Map<string, string>,
): Promise<void> => {
  if (posix.isAbsolute(name) || win32.isAbsolute(name) || name.split(/[\\/]/).includes('..'))
    throw new Error('Observability: invalid build artifact path')

  const path = join(directory, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
  // These are the extensions accepted by sentry-cli's sourcemaps upload.
  if (expected && /\.(?:[cm]?js|jsbundle|bundle|map)$/i.test(name)) {
    const filename = posix.basename(name)
    const sha1 = createHash('sha1').update(contents).digest('hex')
    if (expected.has(filename) && expected.get(filename) !== sha1)
      throw new Error('Observability: GlitchTip release files need unique asset basenames. Include a hash in the output names.')
    expected.set(filename, sha1)
  }
}

export function observabilitySourcemaps(options: RollupSourcemapOptions): Plugin | null {
  if (options?.enabled !== true) return null
  validateUploadOptions(options)
  const collector = options.collector ?? 'sentry'
  if (collector !== 'sentry' && collector !== 'glitchtip')
    throw new Error('Observability: collector must be sentry or glitchtip')
  const timeout = options.processingTimeoutSeconds ?? 60
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)
    throw new Error('Observability: processingTimeoutSeconds must be an integer between 1 and 3600')

  let endpoint: URL
  try {
    endpoint = new URL(options.url)
  } catch {
    throw new Error('Observability: invalid collector URL')
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !usesSecureTransport(endpoint))
    throw new Error('Observability: use an HTTPS collector URL (HTTP is supported on loopback)')

  return {
    name: 'observability-rollup-sourcemaps',
    outputOptions(output) {
      return { ...output, sourcemap: 'hidden' }
    },
    generateBundle: {
      order: 'post',
      async handler(_output, bundle, isWrite) {
        if (!isWrite) return
        const staging = await mkdtemp(join(tmpdir(), 'observability-sourcemaps-'))
        try {
          const expected = collector === 'glitchtip' ? new Map<string, string>() : undefined
          let maps = 0
          for (const file of Object.values(bundle)) {
            const mapName = ('sourcemapFileName' in file && file.sourcemapFileName) || `${file.fileName}.map`
            const map = bundle[mapName]
            if (map?.type !== 'asset') continue
            await writeArtifact(staging, file.fileName, file.type === 'chunk' ? file.code : file.source, expected)
            // The CLI pairs hidden maps by the adjacent bundle name.
            await writeArtifact(staging, `${file.fileName}.map`, map.source, expected)
            delete bundle[mapName]
            maps++
          }
          if (!maps) throw new Error('Observability: the build did not generate sourcemaps')

          const { default: SentryCli } = await import('@sentry/cli')
          const cli = new SentryCli(null, {
            url: options.url, org: options.org, project: options.project, authToken: options.authToken,
          })
          const base = new URL(options.base ?? '/', 'http://localhost/').pathname
          const urlPrefix = `~${base.replace(/\/?$/, '/')}`
          await cli.releases.new(options.release)
          await cli.execute([
            'sourcemaps', 'upload', '--release', options.release, '--url-prefix', urlPrefix,
            '--validate', '--strict', '--no-rewrite',
            ...(collector === 'sentry' ? ['--wait-for', String(timeout)] : []), staging,
          ], 'rejectOnError')
          if (expected) await waitForReleaseFiles(endpoint, options, expected, timeout)
          await cli.releases.finalize(options.release)
        } finally {
          await rm(staging, { recursive: true, force: true })
        }
      },
    },
  }
}
