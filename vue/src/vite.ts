import type { Plugin } from 'vite'
import { observabilitySourcemaps as rollupSourcemaps, type RollupSourcemapOptions } from './rollup.js'
import type { SourcemapOptions } from './sourcemaps.js'

export type { SourcemapOptions } from './sourcemaps.js'

export function observabilitySourcemaps(options: SourcemapOptions): Plugin | null {
  const upload: RollupSourcemapOptions = { ...options }
  const plugin = rollupSourcemaps(upload)
  if (!plugin) return null

  return {
    ...plugin,
    name: 'observability-vite-sourcemaps',
    apply: 'build',
    enforce: 'post',
    config: () => ({ build: { sourcemap: 'hidden' } }),
    configResolved(config) { upload.base = config.base },
  }
}
