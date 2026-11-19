import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Messages } from '@openreplay/tracker/class'
import { protectReplayData } from '../dist/openreplay-privacy.js'

test('hidden controls retain their shape while their values and checked state stay out of replay messages', () => {
  const id = 1
  const visible = 2
  const outgoing = []
  const encoded = []
  const field = { nodeName: 'INPUT', type: 'checkbox', clientWidth: 24, clientHeight: 24 }
  const app = {
    worker: { postMessage() {} },
    nodes: { getNode: () => field },
    sanitizer: { isHidden: node => node === id },
    attributeSender: { sendSetAttribute: (...args) => encoded.push(args) },
    send: (...args) => outgoing.push(args),
  }
  protectReplayData({ use: plugin => plugin(app) })

  for (const state of [true, false]) {
    app.attributeSender.sendSetAttribute(id, 'value', 'private-value')
    app.attributeSender.sendSetAttribute(id, 'checked', '')
    app.attributeSender.sendSetAttribute(id, 'aria-valuenow', '78')
    app.attributeSender.sendSetAttribute(id, 'data-value', 'private-value')
    app.send(Messages.SetInputChecked(id, state), true)
  }
  app.send(Messages.RemoveNodeAttribute(id, 'checked'))
  app.send(Messages.SetNodeAttribute(id, 'aria-checked', 'true'))
  app.send(Messages.NodeAnimationResult(id, '{"content":"private-value"}'))
  app.send(Messages.SetNodeAttributeURLBased(id, 'style', '--private:private-value', 'https://app.test/'), true)
  app.attributeSender.sendSetAttribute(id, 'type', 'arbitrary DOM value')
  app.attributeSender.sendSetAttribute(visible, 'class', 'active')
  app.send(Messages.SetNodeAttributeURLBased(visible, 'style', 'color:red', 'https://app.test/'), false)

  assert.deepEqual(encoded, [[visible, 'class', 'active']])
  assert.deepEqual(outgoing, [
    [Messages.SetNodeAttribute(id, 'style', 'width:24px;height:24px'), true],
    [Messages.SetNodeAttribute(id, 'type', 'checkbox')],
    [Messages.SetNodeAttributeURLBased(visible, 'style', 'color:red', 'https://app.test/'), false],
  ])
})

test('each worker start strips the document URL before binary encoding and preserves other messages', () => {
  const sent = []
  const worker = { postMessage(...args) { assert.equal(this, worker); sent.push(args) } }
  const tracker = { use: fn => fn({ worker, attributeSender: {}, send() {} }) }
  protectReplayData(tracker)
  for (const url of ['https://app.test/auth?code=private', 'https://app.test/#/account/private']) {
    worker.postMessage({ type: 'start', pageNo: 1, url })
  }
  worker.postMessage('stop')
  assert.deepEqual(sent, [[{ type: 'start', pageNo: 1, url: '' }], [{ type: 'start', pageNo: 1, url: '' }], ['stop']])
  assert.throws(() => protectReplayData({ use: fn => fn({}) }), /privacy guard unavailable/)
})
