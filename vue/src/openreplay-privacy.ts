import { Messages, type default as Tracker } from '@openreplay/tracker/class'

// The SDK exports message factories. Its protocol enum is erased in the published JavaScript.
const checked = Messages.SetInputChecked(0, false)[0]
const attribute = Messages.SetNodeAttribute(0, '', '')[0]
const urlAttribute = Messages.SetNodeAttributeURLBased(0, '', '', '')[0]
const removeAttribute = Messages.RemoveNodeAttribute(0, '')[0]
const animation = Messages.NodeAnimationResult(0, '')[0]

// Tracker 19.1.2 seeds each binary batch with document.URL before its public URL sanitizer runs.
// Its worker belongs to this tracker and survives stop/start. Guard that one instance only.
function protectBatchLocation(worker: unknown): void {
  if (!worker || typeof worker !== 'object' || !('postMessage' in worker) || typeof worker.postMessage !== 'function')
    throw new Error('FaultThread: OpenReplay privacy guard unavailable')

  const postMessage = worker.postMessage
  worker.postMessage = (message: unknown, ...args: unknown[]) => {
    const safe = message && typeof message === 'object' && 'type' in message && message.type === 'start'
      ? { ...message, url: '' }
      : message
    return Reflect.apply(postMessage, worker, [safe, ...args])
  }
}

export function protectReplayData(tracker: Tracker): void {
  tracker.use(app => {
    if (!app) throw new Error('FaultThread: OpenReplay tracker unavailable')
    protectBatchLocation(Reflect.get(app, 'worker'))

    // Filter before dictionary encoding. Discarding an encoded attribute would still send its value.
    const send = app.send
    const setAttribute = app.attributeSender.sendSetAttribute
    app.attributeSender.sendSetAttribute = (id, name, value) => {
      if (!app.sanitizer.isHidden(id)) return setAttribute(id, name, value)
      if (name === 'type') {
        const node = app.nodes.getNode(id)
        // The native property normalizes arbitrary attribute values to a known input type.
        if (node && node.nodeName === 'INPUT' && 'type' in node && typeof node.type === 'string')
          send(Messages.SetNodeAttribute(id, name, node.type))
      }
    }

    // Checked state and URL-based attributes bypass the dictionary, including inline styles.
    app.send = (message, urgent) => {
      if (message[0] === checked) return
      if ((message[0] === attribute || message[0] === urlAttribute ||
           message[0] === removeAttribute || message[0] === animation) && app.sanitizer.isHidden(message[1])) {
        if (message[0] === urlAttribute && message[2] === 'style') {
          const node = app.nodes.getNode(message[1])
          if (node && 'clientWidth' in node && 'clientHeight' in node)
            send(Messages.SetNodeAttribute(message[1], 'style', `width:${node.clientWidth}px;height:${node.clientHeight}px`), urgent)
        }
        return
      }
      send(message, urgent)
    }
  })
}
