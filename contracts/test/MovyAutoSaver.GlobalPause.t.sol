// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MovyAutoSaver} from "../src/MovyAutoSaver.sol";
import {MockUSDC} from "./MovyAutoSaver.t.sol";

/// @notice Covers how the contract-wide emergency pause is reported by
///         `getRemainingDailyAllowance`. The view must say zero whenever
///         `executeRoundup` would refuse the work, must not touch any stored
///         state, and must keep the personal pause and the UTC day cap independent.
contract MovyAutoSaverGlobalPauseTest is Test {
    MockUSDC internal usdc;
    MovyAutoSaver internal autoSaver;

    address internal owner = address(0xA11CE);
    address internal relayer = address(0x8E1A1);
    address internal alice = address(0xA11C3);
    address internal bob = address(0xB0B);
    address internal aliceDest = address(0x5A8E5);
    address internal bobDest = address(0x5A8E6);

    uint64 internal constant ONE_DOLLAR = 1_000_000;
    uint64 internal constant FIVE_DOLLARS = 5_000_000;

    event RoundupExecuted(
        bytes32 indexed paymentKey,
        address indexed wallet,
        address indexed destination,
        uint64 paymentAmount6,
        uint64 roundupAmount6,
        bytes32 paymentTxHash,
        uint256 canonicalLogIndex
    );

    function setUp() public {
        vm.startPrank(owner);
        usdc = new MockUSDC();
        autoSaver = new MovyAutoSaver(address(usdc), relayer);
        vm.stopPrank();

        usdc.mint(alice, 100 * ONE_DOLLAR);
        usdc.mint(bob, 100 * ONE_DOLLAR);
    }

    function _enroll(address user, address dest, uint64 maxRoundup6, uint64 dailyCap6) internal {
        vm.startPrank(user);
        autoSaver.enroll(dest, maxRoundup6, dailyCap6);
        usdc.approve(address(autoSaver), type(uint64).max);
        vm.stopPrank();
    }

    function _globalPause(bool isPaused) internal {
        vm.prank(owner);
        autoSaver.setGlobalPaused(isPaused);
    }

    function _roundup(address user, address dest, bytes32 txHash, uint64 paymentAmount6) internal {
        vm.prank(relayer);
        autoSaver.executeRoundup(user, txHash, 0, paymentAmount6, dest, 1);
    }

    /*//////////////////////////////////////////////////////////////
                         GLOBAL PAUSE AND RESUME
    //////////////////////////////////////////////////////////////*/

    function test_remainingAllowance_isZeroDuringGlobalPause_andRestoredOnResume() public {
        _enroll(alice, aliceDest, ONE_DOLLAR, FIVE_DOLLARS);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), FIVE_DOLLARS);

        _globalPause(true);
        assertTrue(autoSaver.paused());
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0);

        _globalPause(false);
        assertFalse(autoSaver.paused());
        assertEq(autoSaver.getRemainingDailyAllowance(alice), FIVE_DOLLARS);
    }

    function test_globalPause_doesNotChangeStoredConfigOrSpend() public {
        _enroll(alice, aliceDest, ONE_DOLLAR, FIVE_DOLLARS);
        _roundup(alice, aliceDest, keccak256("tx-a"), 170_000);

        uint256 day = block.timestamp / 86400;
        MovyAutoSaver.UserConfig memory before_ = autoSaver.getUserConfig(alice);
        uint64 spentBefore = autoSaver.getDailySpent(alice, day);

        _globalPause(true);
        _globalPause(false);

        MovyAutoSaver.UserConfig memory after_ = autoSaver.getUserConfig(alice);
        assertEq(after_.destination, before_.destination);
        assertEq(after_.maxRoundup6, before_.maxRoundup6);
        assertEq(after_.dailyCap6, before_.dailyCap6);
        assertEq(after_.configEpoch, before_.configEpoch);
        assertEq(after_.paused, before_.paused);
        assertEq(after_.enrolled, before_.enrolled);
        assertEq(autoSaver.getDailySpent(alice, day), spentBefore);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), FIVE_DOLLARS - 830_000);
    }

    function test_executeRoundup_revertsDuringGlobalPause_andConsumesNoCap() public {
        _enroll(alice, aliceDest, ONE_DOLLAR, FIVE_DOLLARS);
        _globalPause(true);

        uint256 day = block.timestamp / 86400;
        uint256 balanceBefore = usdc.balanceOf(alice);

        vm.prank(relayer);
        vm.expectRevert(MovyAutoSaver.ContractPaused.selector);
        autoSaver.executeRoundup(alice, keccak256("tx-paused"), 0, 170_000, aliceDest, 1);

        assertEq(autoSaver.getDailySpent(alice, day), 0);
        assertEq(usdc.balanceOf(alice), balanceBefore);
        bytes32 key = autoSaver.computePaymentKey(block.chainid, keccak256("tx-paused"), 0, alice);
        assertFalse(autoSaver.isPaymentProcessed(key), "a refused payment must stay unprocessed");

        _globalPause(false);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), FIVE_DOLLARS);
        _roundup(alice, aliceDest, keccak256("tx-paused"), 170_000);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), FIVE_DOLLARS - 830_000);
    }

    function test_remainingAllowance_notEnrolledAndRevokedStayZeroAcrossGlobalPause() public {
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0);
        _globalPause(true);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0);
        _globalPause(false);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0);

        _enroll(alice, aliceDest, ONE_DOLLAR, FIVE_DOLLARS);
        vm.prank(alice);
        autoSaver.revoke();
        _globalPause(true);
        _globalPause(false);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0);
    }

    function test_onlyOwnerChangesTheReportedGlobalState() public {
        _enroll(alice, aliceDest, ONE_DOLLAR, FIVE_DOLLARS);

        vm.prank(relayer);
        vm.expectRevert(MovyAutoSaver.Unauthorized.selector);
        autoSaver.setGlobalPaused(true);

        vm.prank(alice);
        vm.expectRevert(MovyAutoSaver.Unauthorized.selector);
        autoSaver.setGlobalPaused(true);

        assertEq(autoSaver.getRemainingDailyAllowance(alice), FIVE_DOLLARS);
    }

    /*//////////////////////////////////////////////////////////////
                         PERSONAL PAUSE INDEPENDENCE
    //////////////////////////////////////////////////////////////*/

    function test_personalPause_isIndependentOfGlobalPause() public {
        _enroll(alice, aliceDest, ONE_DOLLAR, FIVE_DOLLARS);
        _enroll(bob, bobDest, ONE_DOLLAR, FIVE_DOLLARS);

        vm.prank(alice);
        autoSaver.setPaused(true);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0, "alice paused personally");
        assertEq(autoSaver.getRemainingDailyAllowance(bob), FIVE_DOLLARS, "bob unaffected");

        _globalPause(true);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0);
        assertEq(autoSaver.getRemainingDailyAllowance(bob), 0);

        _globalPause(false);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0, "personal pause survives global resume");
        assertEq(autoSaver.getRemainingDailyAllowance(bob), FIVE_DOLLARS);

        vm.prank(alice);
        autoSaver.setPaused(false);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), FIVE_DOLLARS);
    }

    function test_userProtectiveActionsStillWorkDuringGlobalPause() public {
        _enroll(alice, aliceDest, ONE_DOLLAR, FIVE_DOLLARS);
        _enroll(bob, bobDest, ONE_DOLLAR, FIVE_DOLLARS);
        _globalPause(true);

        // Personal pause is recorded while the service is paused...
        vm.prank(alice);
        autoSaver.setPaused(true);
        assertTrue(autoSaver.getUserConfig(alice).paused);

        // ...and a global resume does not undo it.
        _globalPause(false);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0);
        assertEq(autoSaver.getRemainingDailyAllowance(bob), FIVE_DOLLARS);

        // Revoke also works while the service is paused.
        _globalPause(true);
        vm.prank(bob);
        autoSaver.revoke();
        assertFalse(autoSaver.getUserConfig(bob).enrolled);
        _globalPause(false);
        assertEq(autoSaver.getRemainingDailyAllowance(bob), 0);
    }

    function test_globalResume_doesNotResumeAPersonallyPausedUser() public {
        _enroll(alice, aliceDest, ONE_DOLLAR, FIVE_DOLLARS);
        _globalPause(true);
        vm.prank(alice);
        autoSaver.setPaused(true);
        _globalPause(false);

        vm.prank(relayer);
        vm.expectRevert(MovyAutoSaver.UserIsPaused.selector);
        autoSaver.executeRoundup(alice, keccak256("tx-user-paused"), 0, 170_000, aliceDest, 1);
    }

    /*//////////////////////////////////////////////////////////////
                              UTC DAILY CAP
    //////////////////////////////////////////////////////////////*/

    function test_dailyCap_sameDayPauseResumeKeepsSpentAmount() public {
        _enroll(alice, aliceDest, ONE_DOLLAR, FIVE_DOLLARS);
        _roundup(alice, aliceDest, keccak256("tx1"), 170_000); // saves 830_000
        assertEq(autoSaver.getRemainingDailyAllowance(alice), FIVE_DOLLARS - 830_000);

        _globalPause(true);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0);
        _globalPause(false);

        assertEq(autoSaver.getRemainingDailyAllowance(alice), FIVE_DOLLARS - 830_000, "spend not forgotten");
    }

    function test_dailyCap_pausedAcrossUtcMidnight_reportsFreshDayOnlyAfterResume() public {
        _enroll(alice, aliceDest, ONE_DOLLAR, FIVE_DOLLARS);
        _roundup(alice, aliceDest, keccak256("tx1"), 170_000);

        _globalPause(true);
        vm.warp(block.timestamp + 86400);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0, "still paused on the new UTC day");

        _globalPause(false);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), FIVE_DOLLARS, "new UTC day has a full cap");
    }

    function test_dailyCap_exhaustedCapStaysZeroAndResetsNextUtcDay() public {
        _enroll(alice, aliceDest, ONE_DOLLAR, 1_000_000);
        _roundup(alice, aliceDest, keccak256("tx1"), 1_500_000); // saves 500_000
        _roundup(alice, aliceDest, keccak256("tx2"), 2_500_000); // saves 500_000, cap exhausted
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0);

        _globalPause(true);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0);
        _globalPause(false);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0, "cap is still exhausted today");

        vm.warp(block.timestamp + 86400);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 1_000_000);
    }

    /*//////////////////////////////////////////////////////////////
                           EVENT DATA UNCHANGED
    //////////////////////////////////////////////////////////////*/

    function test_roundupExecutedEvent_isUnchangedAfterAPauseCycle() public {
        _enroll(alice, aliceDest, ONE_DOLLAR, FIVE_DOLLARS);
        _globalPause(true);
        _globalPause(false);

        bytes32 txHash = keccak256("tx-event");
        uint256 logIndex = 7;
        bytes32 key = autoSaver.computePaymentKey(block.chainid, txHash, logIndex, alice);

        vm.expectEmit(true, true, true, true, address(autoSaver));
        emit RoundupExecuted(key, alice, aliceDest, 170_000, 830_000, txHash, logIndex);

        vm.prank(relayer);
        autoSaver.executeRoundup(alice, txHash, logIndex, 170_000, aliceDest, 1);

        assertEq(usdc.balanceOf(aliceDest), 830_000);
        assertTrue(autoSaver.isPaymentProcessed(key));
    }

    /*//////////////////////////////////////////////////////////////
                                  FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_remainingAllowance_matchesCapMinusSpend_andPauseOnlyHidesIt(
        uint64 maxRoundupSeed,
        uint64 capSeed,
        uint64 roundupSeed,
        uint8 dollars
    ) public {
        uint64 maxRoundup6 = uint64(bound(maxRoundupSeed, 1, autoSaver.MAX_ROUNDUP_CEILING()));
        uint64 dailyCap6 = uint64(bound(capSeed, maxRoundup6, autoSaver.MAX_DAILY_CAP_CEILING()));
        uint64 roundup6 = uint64(bound(roundupSeed, 1, maxRoundup6 < 999_999 ? maxRoundup6 : 999_999));
        if (roundup6 > dailyCap6) roundup6 = dailyCap6;
        uint64 paymentAmount6 = uint64(dollars) * ONE_DOLLAR + (ONE_DOLLAR - roundup6);
        assertEq(autoSaver.calculateRoundup(paymentAmount6), roundup6);

        _enroll(alice, aliceDest, maxRoundup6, dailyCap6);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), dailyCap6);

        _roundup(alice, aliceDest, keccak256(abi.encode("fuzz", roundup6)), paymentAmount6);
        uint64 expected = dailyCap6 - roundup6;
        assertEq(autoSaver.getRemainingDailyAllowance(alice), expected);

        _globalPause(true);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), 0);
        assertEq(autoSaver.getDailySpent(alice, block.timestamp / 86400), roundup6, "spend untouched by pause");

        _globalPause(false);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), expected);
        assertLe(autoSaver.getRemainingDailyAllowance(alice), dailyCap6);
    }

    function testFuzz_remainingAllowance_isZeroWheneverPaused(uint8 pauseMask, uint64 warpSeconds) public {
        _enroll(alice, aliceDest, ONE_DOLLAR, FIVE_DOLLARS);
        vm.warp(block.timestamp + bound(warpSeconds, 0, 30 days));

        bool globalPaused = pauseMask & 1 == 1;
        bool personalPaused = pauseMask & 2 == 2;
        _globalPause(globalPaused);
        vm.prank(alice);
        autoSaver.setPaused(personalPaused);

        uint64 remaining = autoSaver.getRemainingDailyAllowance(alice);
        if (globalPaused || personalPaused) {
            assertEq(remaining, 0);
        } else {
            assertEq(remaining, FIVE_DOLLARS);
        }
    }
}
