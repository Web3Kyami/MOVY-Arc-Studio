import assert from 'node:assert/strict'
import React from 'react'
import { act, create } from 'react-test-renderer'
import {
  WithdrawalReceiptUnresolvedNotice,
  WithdrawalRevertedNotice,
} from '../src/components/movy/mobile-withdraw-sheet.tsx'
import { ActivityLoadError } from '../src/components/movy/views/activity-view.tsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const HASH = `0x${'a'.repeat(64)}`
let renderer
let withdrawalReceiptChecks = 0
act(() => {
  renderer = create(React.createElement(WithdrawalReceiptUnresolvedNotice, {
    hash: HASH,
    isChecking: false,
    onRetry: () => { withdrawalReceiptChecks += 1 },
  }))
})
assert.match(textOf(renderer.toJSON()), /withdrawal outcome unconfirmed/i)
assert.match(textOf(renderer.toJSON()), /do not submit this withdrawal again/i)
assert.ok(renderer.root.findAllByType('a').some((link) => link.props.href.includes(HASH)), 'Withdrawal receipt failure must retain the explorer link')
const withdrawalRetry = renderer.root.findAllByType('button').find((button) => /Retry receipt check/.test(instanceText(button)))
assert.ok(withdrawalRetry)
assert.match(withdrawalRetry.props.className, /min-h-11/, 'Withdrawal receipt retry must meet the 44px touch target')
act(() => withdrawalRetry.props.onClick())
assert.equal(withdrawalReceiptChecks, 1, 'Withdrawal retry must only recheck the receipt')
act(() => renderer.unmount())

let resetCount = 0
act(() => {
  renderer = create(React.createElement(WithdrawalRevertedNotice, {
    hash: HASH,
    onDismiss: () => { resetCount += 1 },
  }))
})
assert.match(textOf(renderer.toJSON()), /included but reverted/i)
assert.match(textOf(renderer.toJSON()), /no funds were transferred/i)
assert.match(textOf(renderer.toJSON()), /network fee may still have been charged/i)
assert.ok(renderer.root.findAllByType('a').some((link) => link.props.href.includes(HASH)), 'Reverted withdrawal must expose its confirmed transaction')
act(() => renderer.root.findByType('button').props.onClick())
assert.equal(resetCount, 1)
act(() => renderer.unmount())

let activityRetries = 0
act(() => {
  renderer = create(React.createElement(ActivityLoadError, {
    message: 'Observer unavailable',
    onRetry: () => { activityRetries += 1 },
  }))
})
const activityRetry = renderer.root.findByType('button')
assert.match(activityRetry.props.className, /min-h-11/, 'Activity retry must meet the 44px touch target')
act(() => activityRetry.props.onClick())
assert.equal(activityRetries, 1, 'Activity retry must invoke the supplied refresh action')
act(() => renderer.unmount())

console.log('PASS: withdrawal receipt retries are read-only, reverted withdrawals show the mined receipt, and Activity retry remains touch-accessible')
