export interface SourcemapOptions {
  enabled: boolean
  collector?: 'sentry' | 'glitchtip'
  processingTimeoutSeconds?: number
  release?: string
  url?: string
  org?: string
  project?: string
  authToken?: string
}

const uploadFields = ['release', 'url', 'org', 'project', 'authToken'] as const
export type UploadOptions = Required<Pick<SourcemapOptions, typeof uploadFields[number]>>

export function validateUploadOptions<T extends SourcemapOptions>(options: T): asserts options is T & UploadOptions {
  for (const key of uploadFields) {
    const value = options[key]
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`Observability: ${key} is required to upload sourcemaps`)
  }
}
