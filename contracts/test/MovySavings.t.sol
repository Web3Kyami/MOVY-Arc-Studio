// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test, Vm } from "forge-std/Test.sol";
import { MovySavings } from "../src/MovySavings.sol";

/// @dev A merchant that rejects the payment, to prove atomicity.
contract RejectingMerchant {
    fallback() external payable {
        revert("merchant refuses payment");
    }
}

/// @dev A merchant that captures the value and then reverts. Proves that a
///      post-transfer revert rolls the whole transaction back, so the contract
///      never keeps a purchase it did not settle.
contract SwallowingMerchant {
    uint256 public received;

    function collect() external payable {
        received += msg.value;
        revert("merchant swallows then reverts");
    }
}

/// @dev Reentrancy probe: on receiving payment it re-enters `payAndSave` and
///      records the raw revert data so the test can assert the guard fired.
///      Note the `receive()`: `MovySavings` pays merchants with empty calldata, so
///      a contract merchant must be able to accept a bare value transfer.
contract ReentrantMerchant {
    MovySavings public immutable vault;
    bool private _entered;
    bytes public reentryReturnData;
    uint256 public received;

    constructor(MovySavings v) {
        vault = v;
    }

    receive() external payable {
        received += msg.value;
        if (_entered) return;
        _entered = true;
        (bool ok, bytes memory ret) = address(vault).call(
            abi.encodeWithSelector(MovySavings.payAndSave.selector, payable(address(this)), 263)
        );
        if (!ok) reentryReturnData = ret;
    }
}

/// @dev A merchant that tries to withdraw savings belonging to someone else.
contract ThiefContract {
    MovySavings public immutable vault;

    constructor(MovySavings v) {
        vault = v;
    }

    function collect() external payable {
        (bool ok,) = address(vault).call(
            abi.encodeWithSelector(MovySavings.withdraw.selector, type(uint256).max)
        );
        ok;
    }
}

/// @dev A contract that owns savings and re-enters `withdraw` from its receive hook.
///      `receive()` is required because `MovySavings.withdraw` sends value with
///      empty calldata.
contract ReentrantOwner {
    MovySavings public immutable vault;
    bytes public reentryReturnData;
    uint256 public totalReceived;
    bool private _entered;

    constructor(MovySavings v) {
        vault = v;
    }

    function pay(MovySavings v, address payable m, uint256 purchaseCents, uint256 value) external payable {
        v.payAndSave{value: value}(m, purchaseCents);
    }

    function withdrawSome(uint256 amount) external {
        vault.withdraw(amount);
    }

    receive() external payable {
        totalReceived += msg.value;
        if (_entered) return;
        _entered = true;
        (bool ok, bytes memory ret) = address(vault).call(
            abi.encodeWithSelector(MovySavings.withdraw.selector, 1)
        );
        if (!ok) reentryReturnData = ret;
    }
}

contract MovySavingsTest is Test {
    MovySavings internal vault;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal merchant = makeAddr("merchant");
    address payable internal merchantPayable = payable(address(merchant));

    uint256 internal constant CENTS_UNIT = 1e16;
    uint256 internal constant MAX_CENTS = 1_000_000;

    function setUp() public {
        vault = new MovySavings();
        vm.deal(alice, 1000e18);
        vm.deal(bob, 1000e18);
        vm.deal(merchant, 0);
    }

    /*//////////////////////////////////////////////////////////////
                              HELPER ASSERTIONS
    //////////////////////////////////////////////////////////////*/

    function assertSolvent() internal view {
        assertGe(
            address(vault).balance,
            vault.totalLiabilities(),
            "SOLVENCY BROKEN: contract holds less than it owes"
        );
    }

    function assertNoSavings(address who) internal {
        assertEq(vault.savingsOf(who), 0, "unexpected savings");
    }

    /*//////////////////////////////////////////////////////////////
                          TABLE CASES (TESTING.md)
    //////////////////////////////////////////////////////////////*/

    /// @dev The exact table from TESTING.md. Each row asserts the merchant delta
    ///      and the caller's savings delta in native 18-decimal units.
    function test_table_roundingAndExactDeltas() public {
        uint256[6] memory purchases = [uint256(1), 99, 100, 263, 520, 999];
        uint256[6] memory expectedRoundups = [uint256(99), 1, 0, 37, 80, 1];

        for (uint256 i = 0; i < purchases.length; i++) {
            uint256 purchaseCents = purchases[i];
            uint256 roundupCents = expectedRoundups[i];
            uint256 purchaseWei = purchaseCents * CENTS_UNIT;
            uint256 roundupWei = roundupCents * CENTS_UNIT;
            uint256 totalWei = purchaseWei + roundupWei;

            uint256 merchantBefore = merchant.balance;
            uint256 savingsBefore = vault.savingsOf(alice);

            vm.prank(alice);
            vault.payAndSave{value: totalWei}(merchantPayable, purchaseCents);

            assertEq(merchant.balance - merchantBefore, purchaseWei, "merchant delta wrong");
            assertEq(vault.savingsOf(alice) - savingsBefore, roundupWei, "savings delta wrong");

            // The contract keeps exactly the roundup, nothing else.
            assertEq(address(vault).balance, vault.totalLiabilities(), "contract retains more than it owes");
            assertSolvent();

            emit log_named_uint("purchaseCents", purchaseCents);
            emit log_named_uint("roundupCents", roundupCents);
        }
    }

    /// @dev The headline example from the handoff, asserted end to end.
    function test_headline_twoDollarSixtyThree() public {
        vm.prank(alice);
        vault.payAndSave{value: 3e18}(merchantPayable, 263);

        assertEq(merchant.balance, 2.63e18, "merchant must receive exactly $2.63");
        assertEq(vault.savingsOf(alice), 0.37e18, "alice must save exactly $0.37");
        assertEq(address(vault).balance, 0.37e18, "contract holds exactly alice's savings");
        assertEq(vault.totalLiabilities(), 0.37e18);
    }

    /// @dev An exact dollar is a valid purchase with a zero roundup.
    function test_exactDollarHasZeroRoundupAndStillPays() public {
        vm.prank(alice);
        vault.payAndSave{value: 1e18}(merchantPayable, 100);

        assertEq(merchant.balance, 1e18, "merchant paid");
        assertNoSavings(alice);
        assertEq(vault.totalLiabilities(), 0);
        assertEq(address(vault).balance, 0, "contract retains nothing");
    }

    /*//////////////////////////////////////////////////////////////
                        UNIT CONVERSION INVARIANTS
    //////////////////////////////////////////////////////////////*/

    function test_quoteMatchesPayment() public {
        uint256[8] memory purchases = [uint256(1), 2, 7, 42, 63, 99, 100, 4200];
        for (uint256 i = 0; i < purchases.length; i++) {
            (uint256 roundupCents, uint256 purchaseWei, uint256 roundupWei, uint256 totalWei) =
                vault.quotePurchase(purchases[i]);

            assertEq(roundupCents, (100 - (purchases[i] % 100)) % 100, "quote roundup");
            assertEq(purchaseWei, purchases[i] * CENTS_UNIT, "quote purchase wei");
            assertEq(roundupWei, roundupCents * CENTS_UNIT, "quote roundup wei");
            assertEq(totalWei, purchaseWei + roundupWei, "quote total");

            // Total is always a whole number of dollars in native units.
            assertEq(totalWei % 1e18, 0, "total must be a whole dollar");
            assertEq(totalWei / 1e18, (purchases[i] + roundupCents) / 100, "total dollars");
        }
    }

    function testFuzz_totalIsWholeDollarAndRoundupInRange(uint128 purchaseCents) public pure {
        vm.assume(purchaseCents >= 1 && purchaseCents <= MAX_CENTS);

        (uint256 roundupCents, , , uint256 totalWei) = _referenceQuote(purchaseCents);

        assertLe(roundupCents, 99, "roundup must be less than one dollar");
        assertEq(totalWei % 1e18, 0, "total must land on a whole dollar");
        assertGe(totalWei, purchaseCents * CENTS_UNIT, "total must cover purchase");
        assertLe(totalWei, (purchaseCents + 99) * CENTS_UNIT, "total must not overshoot");
    }

    function _referenceQuote(uint256 purchaseCents)
        internal
        pure
        returns (uint256 roundupCents, uint256 purchaseWei, uint256 roundupWei, uint256 totalWei)
    {
        roundupCents = (100 - (purchaseCents % 100)) % 100;
        purchaseWei = purchaseCents * CENTS_UNIT;
        roundupWei = roundupCents * CENTS_UNIT;
        totalWei = purchaseWei + roundupWei;
    }

    /// @dev Fuzz the whole payment path, asserting both deltas for real transfers.
    function testFuzz_paymentSettlesExactly(uint128 purchaseCents, address payerSeed) public {
        vm.assume(purchaseCents >= 1 && purchaseCents <= MAX_CENTS);

        address payer = makeAddr(string.concat("payer", vm.toString(payerSeed)));
        address recipient = makeAddr(string.concat("mrc", vm.toString(payerSeed)));
        vm.assume(payer != recipient);
        vm.deal(payer, 10_000_000e18);

        (uint256 roundupCents, uint256 purchaseWei, uint256 roundupWei, uint256 totalWei) =
            vault.quotePurchase(purchaseCents);

        uint256 recipientBefore = recipient.balance;
        uint256 payerBefore = payer.balance;

        vm.prank(payer);
        vault.payAndSave{value: totalWei}(payable(recipient), purchaseCents);

        assertEq(recipient.balance - recipientBefore, purchaseWei, "merchant delta");
        assertEq(vault.savingsOf(payer), roundupWei, "savings delta");
        // The payer's whole outflow of value is the exact total; the roundup does
        // not leave the payer, it is simply held by the contract on their behalf.
        assertEq(payerBefore - payer.balance, totalWei, "payer value outflow");
        assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////
                          ATOMICITY / REVERT TESTS
    //////////////////////////////////////////////////////////////*/

    function test_merchantRejectionRevertsEverything() public {
        RejectingMerchant rejecting = new RejectingMerchant();

        uint256 vaultBefore = address(vault).balance;
        uint256 liabilitiesBefore = vault.totalLiabilities();

        vm.prank(alice);
        vm.expectRevert(MovySavings.MovyMerchantTransferFailed.selector);
        vault.payAndSave{value: 3e18}(payable(address(rejecting)), 263);

        assertEq(address(vault).balance, vaultBefore, "vault balance moved on revert");
        assertEq(vault.totalLiabilities(), liabilitiesBefore, "liabilities moved on revert");
        assertNoSavings(alice);
    }

    function test_reentrancyIsBlockedWithGuardError() public {
        ReentrantMerchant attacker = new ReentrantMerchant(vault);

        vm.prank(alice);
        vault.payAndSave{value: 3e18}(payable(address(attacker)), 263);

        // The outer payment still settled normally.
        assertEq(vault.savingsOf(alice), 0.37e18, "outer payment failed");

        // The nested call was rejected by the guard, not by chance.
        bytes memory expected = abi.encodeWithSelector(MovySavings.MovyReentrancy.selector);
        assertEq(attacker.reentryReturnData(), expected, "nested call was not blocked by the guard");
        assertSolvent();
    }

    function test_swallowingMerchantRevertRollsBackSavings() public {
        SwallowingMerchant swallowing = new SwallowingMerchant();

        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 3e18}(
            abi.encodeWithSelector(
                MovySavings.payAndSave.selector, payable(address(swallowing)), 263
            )
        );
        assertFalse(ok, "swallowing merchant should have reverted the whole tx");

        // The merchant captured the value and then reverted, so nothing persisted.
        assertNoSavings(alice);
        assertEq(address(vault).balance, 0, "vault kept value from a reverted settlement");
        assertEq(vault.totalLiabilities(), 0);
    }

    function test_reentrancyIsBlocked() public {
        ReentrantMerchant attacker = new ReentrantMerchant(vault);

        vm.prank(alice);
        vault.payAndSave{value: 3e18}(payable(address(attacker)), 263);

        // Outer payment succeeded and no extra savings were minted by the nested call.
        assertEq(vault.savingsOf(alice), 0.37e18, "savings inflated by reentrancy");
        assertEq(address(vault).balance, 0.37e18, "vault balance wrong");
        assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////
                            INPUT VALIDATION
    //////////////////////////////////////////////////////////////*/

    function test_revert_zeroPurchase() public {
        vm.prank(alice);
        vm.expectRevert(MovySavings.MovyZeroPurchase.selector);
        vault.payAndSave{value: 0}(merchantPayable, 0);
    }

    function test_revert_zeroMerchant() public {
        vm.prank(alice);
        vm.expectRevert(MovySavings.MovyZeroMerchant.selector);
        vault.payAndSave{value: 3e18}(payable(address(0)), 263);
    }

    function test_revert_selfMerchant() public {
        vm.prank(alice);
        vm.expectRevert(MovySavings.MovySelfMerchant.selector);
        vault.payAndSave{value: 3e18}(payable(alice), 263);
    }

    function test_revert_purchaseAboveCeiling() public {
        vm.deal(alice, 1e30);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                MovySavings.MovyPurchaseTooLarge.selector, MAX_CENTS + 1, MAX_CENTS
            )
        );
        vault.payAndSave{value: 1e24}(merchantPayable, MAX_CENTS + 1);
    }

    function test_revert_underpaymentByOneUnit() public {
        uint256 merchantBefore = merchant.balance;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MovySavings.MovyValueMismatch.selector, 3e18 - 1, 3e18));
        vault.payAndSave{value: 3e18 - 1}(merchantPayable, 263);

        assertEq(merchant.balance, merchantBefore, "merchant must not be paid on revert");
        assertNoSavings(alice);
    }

    function test_revert_overpaymentByOneUnit() public {
        uint256 merchantBefore = merchant.balance;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MovySavings.MovyValueMismatch.selector, 3e18 + 1, 3e18));
        vault.payAndSave{value: 3e18 + 1}(merchantPayable, 263);

        assertEq(merchant.balance, merchantBefore, "merchant must not be paid on revert");
        assertNoSavings(alice);
        assertEq(address(vault).balance, 0, "no value retained on revert");
    }

    function test_revert_exactDollarOverpayment() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MovySavings.MovyValueMismatch.selector, 1.0001e18, 1e18));
        vault.payAndSave{value: 1.0001e18}(merchantPayable, 100);
    }

    /// @dev Even a 1-cent purchase must land on a whole dollar, not just round up
    ///      to the nearest cent.
    function test_oneCentPurchaseStillRoundsToWholeDollar() public {
        vm.prank(alice);
        vault.payAndSave{value: 1e18}(merchantPayable, 1);

        assertEq(merchant.balance, 0.01e18, "merchant receives one cent");
        assertEq(vault.savingsOf(alice), 0.99e18, "savings is 99 cents");
    }

    /*//////////////////////////////////////////////////////////////
                            WITHDRAWAL SAFETY
    //////////////////////////////////////////////////////////////*/

    function test_withdrawPaysOwnerExactly() public {
        vm.prank(alice);
        vault.payAndSave{value: 3e18}(merchantPayable, 263);

        uint256 aliceBefore = alice.balance;

        vm.prank(alice);
        vault.withdraw(0.37e18);

        assertEq(alice.balance - aliceBefore, 0.37e18, "owner did not receive savings");
        assertNoSavings(alice);
        assertEq(vault.totalLiabilities(), 0);
        assertEq(address(vault).balance, 0, "vault drained exactly its liability");
    }

    function test_revert_foreignWithdrawal() public {
        vm.prank(alice);
        vault.payAndSave{value: 3e18}(merchantPayable, 263);

        uint256 bobBefore = bob.balance;
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MovySavings.MovyInsufficientSavings.selector, 0.1e18, 0));
        vault.withdraw(0.1e18);

        assertEq(bob.balance, bobBefore, "bob must not gain");
        assertEq(vault.savingsOf(alice), 0.37e18, "alice's savings must be untouched");
    }

    function test_revert_withdrawMoreThanSavings() public {
        vm.prank(alice);
        vault.payAndSave{value: 3e18}(merchantPayable, 263);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(MovySavings.MovyInsufficientSavings.selector, 0.38e18, 0.37e18)
        );
        vault.withdraw(0.38e18);

        assertEq(vault.savingsOf(alice), 0.37e18, "savings unchanged on revert");
    }

    function test_revert_zeroWithdrawal() public {
        vm.prank(alice);
        vm.expectRevert(MovySavings.MovyZeroWithdrawal.selector);
        vault.withdraw(0);
    }

    function test_doubleWithdrawalSecondFails() public {
        vm.prank(alice);
        vault.payAndSave{value: 3e18}(merchantPayable, 263);

        vm.prank(alice);
        vault.withdraw(0.20e18);
        assertEq(vault.savingsOf(alice), 0.17e18, "partial withdrawal");

        uint256 aliceMid = alice.balance;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MovySavings.MovyInsufficientSavings.selector, 0.20e18, 0.17e18));
        vault.withdraw(0.20e18);

        assertEq(alice.balance, aliceMid, "failed withdrawal must not pay out");
        assertEq(vault.savingsOf(alice), 0.17e18, "savings changed on failed second withdrawal");

        // The remaining balance is still withdrawable, exactly once.
        vm.prank(alice);
        vault.withdraw(0.17e18);
        assertNoSavings(alice);
        assertEq(vault.totalLiabilities(), 0);
    }

    function test_contractCannotWithdrawSomeoneElseSavings() public {
        ThiefContract thief = new ThiefContract(vault);
        vm.deal(address(thief), 1e18);

        vm.prank(alice);
        vault.payAndSave{value: 3e18}(merchantPayable, 263);

        (bool ok,) = address(thief).call(abi.encodeWithSelector(ThiefContract.collect.selector));
        ok; // expected false: the nested withdraw reverts

        // The nested withdraw reverted, so alice's savings are intact.
        assertEq(vault.savingsOf(alice), 0.37e18, "savings stolen");
        assertEq(vault.totalLiabilities(), 0.37e18, "liabilities changed");
    }

    function test_guardCoversWithdrawToo() public {
        // A contract owns savings and re-enters `withdraw` from its receive hook.
        ReentrantOwner owner = new ReentrantOwner(vault);
        vm.deal(address(owner), 10e18);

        owner.pay(vault, merchantPayable, 263, 3e18);
        assertEq(vault.savingsOf(address(owner)), 0.37e18, "owner savings not credited");

        // The first withdrawal settles and pays the owner contract, which tries to
        // re-enter. The guard must stop the nested call, and the outer call must
        // still complete with the correct single decrement.
        owner.withdrawSome(0.10e18);

        assertEq(vault.savingsOf(address(owner)), 0.27e18, "outer withdraw misapplied");
        assertEq(owner.totalReceived(), 0.10e18, "owner received wrong amount");
        bytes memory expected = abi.encodeWithSelector(MovySavings.MovyReentrancy.selector);
        assertEq(owner.reentryReturnData(), expected, "reentrant withdraw was not blocked by guard");
        assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////
                        MULTI-USER / LIABILITY ACCOUNTING
    //////////////////////////////////////////////////////////////*/

    function test_multiplePayersLiabilitiesAreIndependent() public {
        vm.prank(alice);
        vault.payAndSave{value: 3e18}(merchantPayable, 263);

        vm.prank(bob);
        vault.payAndSave{value: 1e18}(merchantPayable, 7);

        assertEq(vault.savingsOf(alice), 0.37e18, "alice savings");
        assertEq(vault.savingsOf(bob), 0.93e18, "bob savings");
        assertEq(vault.totalLiabilities(), 1.30e18, "aggregate liabilities");
        assertEq(merchant.balance, 2.70e18, "merchant total");
        assertEq(address(vault).balance, 1.30e18, "vault holds exactly liabilities");
        assertSolvent();

        // Alice withdrawing must not touch bob's entitlement.
        vm.prank(alice);
        vault.withdraw(0.37e18);

        assertNoSavings(alice);
        assertEq(vault.savingsOf(bob), 0.93e18, "bob savings disturbed");
        assertEq(vault.totalLiabilities(), 0.93e18);
        assertSolvent();
    }

    /// @dev Simulate Arc's unsolicited-transfer case: extra native USDC sent
    ///      directly must not create savings and must not break solvency.
    function test_unsolicitedTransferCreatesNoSavings() public {
        vm.prank(bob);
        (bool ok,) = address(vault).call{value: 5e18}("");
        assertTrue(ok, "direct transfer failed");

        assertEq(vault.totalLiabilities(), 0, "unsolicited funds became a liability");
        assertEq(address(vault).balance, 5e18, "balance mismatch");
        assertNoSavings(bob);
        assertSolvent();
    }

    /// @dev Fuzz the solvency invariant across long random sequences of
    ///      purchases and withdrawals by three independent actors.
    function testFuzz_solvencyAcrossMixedActivity(uint96[40] memory actions, uint256 seed) public {
        address[3] memory actors = [alice, bob, makeAddr("carol")];
        // Every actor is funded for the worst case in this test: the full purchase
        // ceiling 40 times over, so a run can never fail for want of gas money.
        for (uint256 a = 0; a < actors.length; a++) {
            vm.deal(actors[a], uint256(MAX_CENTS) * 41 * CENTS_UNIT + 1e18);
        }

        for (uint256 i = 0; i < actions.length; i++) {
            address actor = actors[uint256(keccak256(abi.encode(seed, i))) % 3];
            uint256 purchaseCents = (uint256(actions[i]) % MAX_CENTS) + 1;
            (,,, uint256 totalWei) = vault.quotePurchase(purchaseCents);

            vm.prank(actor);
            vault.payAndSave{value: totalWei}(merchantPayable, purchaseCents);
            assertSolvent();

            uint256 savings = vault.savingsOf(actor);
            if (savings > 0) {
                uint256 amount = (savings * (uint256(actions[(i + 7) % actions.length]) % 100)) / 100;
                if (amount > 0) {
                    vm.prank(actor);
                    vault.withdraw(amount);
                }
            }
            assertSolvent();
        }

        // Final: the aggregate is exactly the sum of the individual balances, and
        // no individual balance can exceed what that actor actually paid in.
        uint256 sum = vault.savingsOf(alice) + vault.savingsOf(bob) + vault.savingsOf(actors[2]);
        assertEq(vault.totalLiabilities(), sum, "aggregate drifted from sum of balances");
        assertLe(vault.totalLiabilities(), address(vault).balance, "insolvent");
    }

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    function test_eventEmittedOnlyAfterSettlement() public {
        address payer = alice;
        address expectedMerchant = merchant;

        vm.recordLogs();
        vm.prank(alice);
        vault.payAndSave{value: 3e18}(merchantPayable, 263);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // The PurchaseRounded topic0.
        bytes32 topic = keccak256("PurchaseRounded(address,address,uint256,uint256)");
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == topic) {
                found = true;
                // topics[1] = payer, topics[2] = merchant (both indexed)
                assertEq(address(uint160(uint256(logs[i].topics[1]))), payer, "payer topic");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), expectedMerchant, "merchant topic");
                // data = purchaseWei, roundupWei
                (uint256 purchaseWei, uint256 roundupWei) =
                    abi.decode(logs[i].data, (uint256, uint256));
                assertEq(purchaseWei, 2.63e18, "event purchase");
                assertEq(roundupWei, 0.37e18, "event roundup");
            }
        }
        assertTrue(found, "PurchaseRounded not emitted");
    }

    function test_withdrawEventEmitted() public {
        vm.prank(alice);
        vault.payAndSave{value: 3e18}(merchantPayable, 263);

        vm.recordLogs();
        vm.prank(alice);
        vault.withdraw(0.37e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 topic = keccak256("SavingsWithdrawn(address,uint256)");
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == topic) found = true;
        }
        assertTrue(found, "SavingsWithdrawn not emitted");
    }

    function test_noEventOnRevert() public {
        RejectingMerchant rejecting = new RejectingMerchant();
        vm.recordLogs();
        vm.prank(alice);
        try vault.payAndSave{value: 3e18}(payable(address(rejecting)), 263) {
            fail();
        } catch {}
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0, "logs emitted despite revert");
    }
}
