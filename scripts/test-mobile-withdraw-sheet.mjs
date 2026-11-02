import assert from 'node:assert/strict'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { WithdrawalFailureNotice } from '../src/components/movy/mobile-withdraw-sheet.tsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let dismissCount = 0
let renderer
act(() => {
  renderer = create(React.createElement(WithdrawalFailureNotice, {
    message: 'The Arc Testnet transaction could not be confirmed.',
    onDismiss: () => { dismissCount += 1 },
  }))
})

assert.equal(renderer.root.findByProps({ children: 'Withdrawal Failed' }).children.join(''), 'Withdrawal Failed')
assert.match(renderer.root.findByType('p').children.join(' '), /transaction could not be confirmed/i)
const dismiss = renderer.root.findByType('button')
assert.match(dismiss.props.className, /min-h-11/, 'Failure-state retry control must meet the 44px mobile target size')
act(() => dismiss.props.onClick())
assert.equal(dismissCount, 1, 'Dismiss and Try Again returns to the withdrawal form')
act(() => renderer.unmount())

console.log('PASS: withdrawal failure is announced, the retry control meets 44px minimum height, and dismiss is actionable')
