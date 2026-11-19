import * as worker from './openreplay-worker.js'

declare global {
  var FaultThreadWorker: typeof worker
  /** @deprecated Use FaultThreadWorker. */
  var EventObservabilityWorker: typeof worker
}

globalThis.FaultThreadWorker = globalThis.EventObservabilityWorker = worker
