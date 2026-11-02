import assert from 'node:assert/strict'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { SavingsNumberReveal } from '../src/components/movy/savings-number-reveal.tsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const frames = new Map()
let nextFrameId = 0
globalThis.window = {
  matchMedia: () => ({ matches: true }),
}
globalThis.requestAnimationFrame = (callback) => {
  const id = ++nextFrameId
  frames.set(id, callback)
  return id
}
globalThis.cancelAnimationFrame = (id) => frames.delete(id)

const text = (node) => {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(text).join('')
  return node?.children ? text(node.children) : ''
}

let renderer
act(() => {
  renderer = create(React.createElement(SavingsNumberReveal, { value: 24.5 }))
})
assert.equal(text(renderer.toJSON()), '$24.50')

act(() => {
  renderer.update(React.createElement(SavingsNumberReveal, { value: 0 }))
})
assert.equal(text(renderer.toJSON()), '$0.00', 'A confirmed zero must display immediately instead of retaining the prior balance')
assert.equal(frames.size, 0, 'A zero balance must not leave a stale reveal frame scheduled')

act(() => {
  renderer.update(React.createElement(SavingsNumberReveal, { value: 3.17 }))
})
act(() => {
  for (const callback of frames.values()) callback(16)
  frames.clear()
})
assert.equal(text(renderer.toJSON()), '$3.17', 'Reduced motion must settle on the latest confirmed amount')

act(() => renderer.unmount())

globalThis.window.matchMedia = () => ({ matches: false })
let animatedRenderer
act(() => {
  animatedRenderer = create(React.createElement(SavingsNumberReveal, { value: 8 }))
})
assert.equal(text(animatedRenderer.toJSON()), '$8.00', 'The confirmed target remains readable while its first reveal frame is pending')
assert.equal(frames.size, 1, 'A non-zero confirmed amount should schedule the first reveal frame')
act(() => {
  const [frameId, callback] = frames.entries().next().value
  frames.delete(frameId)
  callback(performance.now() + 190)
})
const midReveal = Number(text(animatedRenderer.toJSON()).slice(1))
assert.ok(midReveal > 0 && midReveal < 8, 'The first reveal frame should animate between zero and the target')
act(() => {
  const [frameId, callback] = frames.entries().next().value
  frames.delete(frameId)
  callback(performance.now() + 500)
})
assert.equal(text(animatedRenderer.toJSON()), '$8.00', 'The reveal should settle on the exact target value')
act(() => animatedRenderer.unmount())

console.log('PASS: savings number shows zero immediately, reduced motion settles accurately, and the reveal animates to the exact target')
