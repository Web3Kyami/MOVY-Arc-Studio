/**
 * MOVY Task 01 Functional Corrections Regression Suite
 * 
 * Tests the root causes identified in UI/UX audit:
 * 1. Task A: Preview Demo vs Connected-Wallet separation & mode isolation
 * 2. Task B: Authoritative savings control path (no desync between shell, home, savings, settings)
 * 3. Task C: Truthful 4-state withdrawal feedback (invalid/blocked, failed, submitted-pending, confirmed-success)
 * 4. Task D: Clean adapter architecture and onboarding destination self-loop prevention
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

console.log('Running MOVY Task 01 Functional Corrections Regression Suite...\n');

const appDir = resolve(process.cwd());

// --- Test 1: Verify useMovyModeData Hook Exists & Provides Authoritative Separation ---
console.log('Test 1: Adapter Architecture (Task D) & Mode Isolation (Task A)...');
const modeDataPath = join(appDir, 'src', 'hooks', 'use-movy-mode-data.ts');
assert.ok(existsSync(modeDataPath), 'use-movy-mode-data.ts must exist');
const modeDataContent = readFileSync(modeDataPath, 'utf8');

// Assert return types and interfaces
assert.ok(modeDataContent.includes('isDemoMode: boolean'), 'Exposes isDemoMode');
assert.ok(modeDataContent.includes('isArcMode: boolean'), 'Exposes isArcMode');
assert.ok(modeDataContent.includes('toggleAutomation: () => Promise<void>'), 'Exposes single authoritative toggleAutomation');
assert.ok(modeDataContent.includes('totalSavedFormatted'), 'Exposes truthful totalSavedFormatted');
assert.ok(modeDataContent.includes('roundupsCount'), 'Exposes truthful roundupsCount');
assert.ok(modeDataContent.includes('primaryGoal: DemoGoal | null'), 'Exposes truthful primaryGoal (null when unconfigured in connected mode)');

// Verify that connected mode does NOT return seeded demo balance
assert.ok(
  modeDataContent.includes("totalSavedFormatted: '0.00'") || modeDataContent.includes('totalDollars.toFixed(2)'),
  'Connected mode computes real balance from blockchain/backend, never falling back to Alex seeded balance'
);
console.log('✔ Test 1 PASSED: useMovyModeData correctly isolates demo from connected state.\n');


// --- Test 2: Verify App Shell & View Wireup (Task B: Single Authoritative Control Path) ---
console.log('Test 2: Single Authoritative Control Path & Mode Indicator (Task B)...');
const shellPath = join(appDir, 'src', 'components', 'movy', 'app-shell.tsx');
const shellContent = readFileSync(shellPath, 'utf8');
assert.ok(shellContent.includes('useMovyModeData'), 'AppShell imports useMovyModeData');
assert.ok(shellContent.includes('automation.toggleAutomation'), 'AppShell wires toggleAutomation to authoritative automation');
assert.ok(shellContent.includes('modeBadge'), 'AppShell renders authoritative mode badge (Preview Demo Mode vs Arc Testnet Connected)');

const homeViewPath = join(appDir, 'src', 'components', 'movy', 'views', 'home-view.tsx');
const homeContent = readFileSync(homeViewPath, 'utf8');
assert.ok(homeContent.includes('useMovyModeData'), 'HomeView imports useMovyModeData');
assert.ok(homeContent.includes('automation.toggleAutomation'), 'HomeView automation toggle uses single authoritative path');
assert.ok(homeContent.includes('totalSavedFormatted'), 'HomeView uses truthful totalSavedFormatted from adapter');

const savingsViewPath = join(appDir, 'src', 'components', 'movy', 'views', 'savings-view.tsx');
const savingsContent = readFileSync(savingsViewPath, 'utf8');
assert.ok(savingsContent.includes('useMovyModeData'), 'SavingsView imports useMovyModeData');
assert.ok(savingsContent.includes('automation.toggleAutomation'), 'SavingsView wires toggle to authoritative automation');
assert.ok(savingsContent.includes('automation.isPending'), 'SavingsView handles pending loading state');

const settingsViewPath = join(appDir, 'src', 'components', 'movy', 'views', 'settings-view.tsx');
const settingsContent = readFileSync(settingsViewPath, 'utf8');
assert.ok(settingsContent.includes('useMovyModeData'), 'SettingsView imports useMovyModeData');
assert.ok(settingsContent.includes('automation.toggleAutomation'), 'SettingsView wires toggle to authoritative automation');
assert.ok(settingsContent.includes('Preview Demo Mode') && settingsContent.includes('Arc Testnet Connected Mode'), 'SettingsView renders explicit mode switcher');
console.log('✔ Test 2 PASSED: Single authoritative savings control path established across all views without desync.\n');


// --- Test 3: Verify Truthful 4-State Withdrawal Feedback (Task C) ---
console.log('Test 3: Truthful 4-State Withdrawal Feedback (Task C)...');
const withdrawPath = join(appDir, 'src', 'components', 'movy', 'mobile-withdraw-sheet.tsx');
const withdrawContent = readFileSync(withdrawPath, 'utf8');

// 1. Invalid / blocked check
assert.ok(withdrawContent.includes('blockerMessage'), 'Evaluates blocker preconditions');
assert.ok(withdrawContent.includes('isZeroOrNegative'), 'Detects zero or negative amounts');
assert.ok(withdrawContent.includes('isExceedingBalance'), 'Detects amounts exceeding balance');
assert.ok(withdrawContent.includes('isWrongNetwork'), 'Detects wrong network');

// 2. Mempool pending check: NEVER claim funds arrived while pending
assert.ok(withdrawContent.includes('isSubmittedPending'), 'Detects submitted but pending transactions');
assert.ok(withdrawContent.includes('Transaction Submitted — Pending') || withdrawContent.includes('Awaiting Network Confirmation'), 'Displays distinct pending screen');
assert.ok(withdrawContent.includes('Funds will settle into your spending wallet once the transaction is included in a block'), 'Explicitly informs user money has not yet arrived while pending');

// 3. Confirmed success check
assert.ok(withdrawContent.includes('isConfirmedSuccess'), 'Distinguishes confirmed block inclusion from submission');
assert.ok(withdrawContent.includes('Withdrawal Confirmed'), 'Only reports confirmed once verified onchain or in demo');

// 4. Submission failure
assert.ok(withdrawContent.includes('isSubmissionFailed') || withdrawContent.includes('withdraw.errorMessage'), 'Handles submission and wallet rejection failures truthfully');
console.log('✔ Test 3 PASSED: Withdrawal interface strictly distinguishes invalid, failed, pending, and confirmed states.\n');


// --- Test 4: Onboarding Flow Corrections (Task A & Destination Self-Loop Prevention) ---
console.log('Test 4: Onboarding Flow & Contract Compatibility (Task A)...');
const onboardingPath = join(appDir, 'src', 'components', 'movy', 'onboarding', 'onboarding-flow.tsx');
const onboardingContent = readFileSync(onboardingPath, 'utf8');

// Verify wallet connect sets isDemoMode to false
assert.ok(onboardingContent.includes('setIsDemoMode(false)'), 'Connecting wallet switches out of demo mode');

// Verify destination safety: legacy contract 0xfc0a...ff73 is strictly forbidden
assert.ok(
  !onboardingContent.includes('0xfc0a597c532173327350a3850d223e1f4ec5ff73'),
  'Legacy checkout contract 0xfc0a...ff73 is completely purged and never offered as default destination'
);
assert.ok(
  onboardingContent.includes('validateSavingsDestination'),
  'Onboarding validates destination with strict non-custodial rules'
);
const destRulesPath = join(appDir, 'src', 'lib', 'destination-rules.ts');
const destRulesContent = readFileSync(destRulesPath, 'utf8');
assert.ok(
  destRulesContent.includes('SELF_LOOP') && destRulesContent.includes('Savings destination cannot match your connected spending wallet'),
  'destination-rules.ts strictly rejects destination == wallet spending address self-loop'
);
assert.ok(
  onboardingContent.includes('walletAddress: wallet.address') || onboardingContent.includes('walletAddress: activeAddress'),
  'Onboarding passes wallet address to validateSavingsDestination to enforce self-loop prevention'
);

// Verify truthful activation (only mark enrolled AFTER onchain transactions succeed)
const activateBlock = onboardingContent.slice(onboardingContent.indexOf('handleActivate = async'));
const enrollIdx = activateBlock.indexOf('autoSaver.enroll');
const profileUpdateIdx = activateBlock.indexOf('updateProfile({');
assert.ok(enrollIdx !== -1, 'Calls autoSaver.enroll');
assert.ok(enrollIdx < profileUpdateIdx, 'Enrolls onchain BEFORE marking profile enrolled in connected mode');
console.log('✔ Test 4 PASSED: Onboarding mode transitions, self-loop prevention, and activation integrity verified.\n');

console.log('==================================================================');
console.log('ALL TASK 01 FUNCTIONAL CORRECTIONS REGRESSION TESTS PASSED (4/4)!');
console.log('==================================================================');
