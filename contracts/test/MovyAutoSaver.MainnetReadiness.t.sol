// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MovyAutoSaver} from "../src/MovyAutoSaver.sol";
import {MockUSDC} from "./MovyAutoSaver.t.sol";

/// @notice Focused checks for the three Mainnet-readiness concerns: owner and relayer
///         separation across role changes, 6-decimal ERC-20 units (never the 18-decimal
///         native view), and the global pause as an executor-only brake.
contract MovyAutoSaverMainnetReadinessTest is Test {
    MockUSDC internal usdc;
    MovyAutoSaver internal autoSaver;

    address internal owner = address(0xA11CE);
    address internal relayer = address(0x8E1A1);
    address internal alice = address(0xA11C3);
    address internal dest = address(0x5A8E5);

    uint64 internal constant ONE_DOLLAR = 1_000_000;

    function setUp() public {
        vm.startPrank(owner);
        usdc = new MockUSDC();
        autoSaver = new MovyAutoSaver(address(usdc), relayer);
        vm.stopPrank();
        usdc.mint(alice, 100 * ONE_DOLLAR);
        vm.startPrank(alice);
        autoSaver.enroll(dest, 5 * ONE_DOLLAR, 20 * ONE_DOLLAR);
        usdc.approve(address(autoSaver), 10 * ONE_DOLLAR);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                           OWNER / RELAYER SEPARATION
    //////////////////////////////////////////////////////////////*/

    function test_roles_ownerCannotBecomeRelayerAndRelayerCannotBecomeOwner() public {
        vm.startPrank(owner);
        vm.expectRevert(MovyAutoSaver.InvalidRoleConfiguration.selector);
        autoSaver.setRelayer(owner);
        vm.expectRevert(MovyAutoSaver.InvalidRoleConfiguration.selector);
        autoSaver.transferOwnership(relayer);
        vm.expectRevert(MovyAutoSaver.InvalidRoleConfiguration.selector);
        autoSaver.setRelayer(address(0));
        vm.expectRevert(MovyAutoSaver.InvalidRoleConfiguration.selector);
        autoSaver.transferOwnership(address(0));
        vm.stopPrank();
        assertEq(autoSaver.owner(), owner);
        assertEq(autoSaver.relayer(), relayer);
    }

    function test_roles_separationHoldsAfterOwnerAndRelayerRotate() public {
        address newOwner = address(0xB0B1);
        address newRelayer = address(0xB0B2);

        vm.prank(owner);
        autoSaver.transferOwnership(newOwner);
        // The previous owner has no authority left.
        vm.prank(owner);
        vm.expectRevert(MovyAutoSaver.Unauthorized.selector);
        autoSaver.setRelayer(newRelayer);

        vm.startPrank(newOwner);
        autoSaver.setRelayer(newRelayer);
        vm.expectRevert(MovyAutoSaver.InvalidRoleConfiguration.selector);
        autoSaver.setRelayer(newOwner);
        vm.stopPrank();

        // The previous relayer can no longer execute, and the owner key cannot execute either.
        vm.prank(relayer);
        vm.expectRevert(MovyAutoSaver.Unauthorized.selector);
        autoSaver.executeRoundup(alice, bytes32("t1"), 0, 170_000, dest, 1);
        vm.prank(newOwner);
        vm.expectRevert(MovyAutoSaver.Unauthorized.selector);
        autoSaver.executeRoundup(alice, bytes32("t1"), 0, 170_000, dest, 1);
    }

    function test_roles_relayerCannotChangeAdminSettings() public {
        vm.startPrank(relayer);
        vm.expectRevert(MovyAutoSaver.Unauthorized.selector);
        autoSaver.setGlobalPaused(true);
        vm.expectRevert(MovyAutoSaver.Unauthorized.selector);
        autoSaver.setRelayer(address(0xCAFE));
        vm.expectRevert(MovyAutoSaver.Unauthorized.selector);
        autoSaver.transferOwnership(address(0xCAFE));
        vm.stopPrank();
        assertFalse(autoSaver.paused());
    }

    function test_constructor_deployerCannotAlsoBeRelayer() public {
        vm.prank(owner);
        vm.expectRevert(MovyAutoSaver.InvalidRoleConfiguration.selector);
        new MovyAutoSaver(address(usdc), owner);
    }

    /*//////////////////////////////////////////////////////////////
                                  USDC UNITS
    //////////////////////////////////////////////////////////////*/

    function test_usdc_zeroAddressDefaultsToCanonicalArcInterface() public {
        vm.prank(owner);
        MovyAutoSaver canonical = new MovyAutoSaver(address(0), relayer);
        assertEq(canonical.usdc(), 0x3600000000000000000000000000000000000000);
        assertEq(canonical.CANONICAL_ARC_USDC(), 0x3600000000000000000000000000000000000000);
        assertEq(canonical.UNITS_PER_DOLLAR(), 1_000_000);
    }

    function test_units_roundupMovesExactSixDecimalAmountAndNoNativeValue() public {
        // $2.63 -> $0.37 roundup = 370,000 six-decimal units (never 18-decimal wei).
        uint256 aliceNativeBefore = alice.balance;
        uint256 destNativeBefore = dest.balance;
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vm.prank(relayer);
        autoSaver.executeRoundup(alice, bytes32("t2"), 0, 2_630_000, dest, 1);

        assertEq(usdc.balanceOf(dest), 370_000);
        assertEq(aliceUsdcBefore - usdc.balanceOf(alice), 370_000);
        assertEq(alice.balance, aliceNativeBefore);
        assertEq(dest.balance, destNativeBefore);
        assertEq(address(autoSaver).balance, 0);
        assertEq(usdc.balanceOf(address(autoSaver)), 0);
        assertEq(autoSaver.getDailySpent(alice, block.timestamp / 86400), 370_000);
    }

    function test_units_capsAreSixDecimalAndCeilingsAreEnforced() public {
        assertEq(autoSaver.MAX_ROUNDUP_CEILING(), 100 * ONE_DOLLAR);
        assertEq(autoSaver.MAX_DAILY_CAP_CEILING(), 1_000 * ONE_DOLLAR);
        // An 18-decimal-scaled value must be rejected, not silently accepted.
        vm.prank(alice);
        vm.expectRevert(MovyAutoSaver.InvalidCap.selector);
        autoSaver.updateConfig(dest, uint64(100 * ONE_DOLLAR + 1), uint64(1_000 * ONE_DOLLAR));
        vm.prank(alice);
        vm.expectRevert(MovyAutoSaver.InvalidCap.selector);
        autoSaver.updateConfig(dest, uint64(ONE_DOLLAR), uint64(1_000 * ONE_DOLLAR + 1));
    }

    function test_units_roundupAboveUserAllowanceMovesNothing() public {
        // Allowance is 10 USDC; lower it to 0.30 USDC, below the 0.37 roundup.
        vm.prank(alice);
        usdc.approve(address(autoSaver), 300_000);
        vm.prank(relayer);
        vm.expectRevert();
        autoSaver.executeRoundup(alice, bytes32("t3"), 0, 2_630_000, dest, 1);
        assertEq(usdc.balanceOf(dest), 0);
        assertFalse(autoSaver.isPaymentProcessed(autoSaver.computePaymentKey(block.chainid, bytes32("t3"), 0, alice)));
    }

    /*//////////////////////////////////////////////////////////////
                                 GLOBAL PAUSE
    //////////////////////////////////////////////////////////////*/

    function test_pause_blocksOnlyTheExecutorAndLeavesNoReplayMark() public {
        vm.prank(owner);
        autoSaver.setGlobalPaused(true);

        vm.prank(relayer);
        vm.expectRevert(MovyAutoSaver.ContractPaused.selector);
        autoSaver.executeRoundup(alice, bytes32("t4"), 0, 2_630_000, dest, 1);

        assertEq(usdc.balanceOf(dest), 0);
        assertFalse(autoSaver.isPaymentProcessed(autoSaver.computePaymentKey(block.chainid, bytes32("t4"), 0, alice)));

        // The same payment executes once the owner lifts the pause.
        vm.prank(owner);
        autoSaver.setGlobalPaused(false);
        vm.prank(relayer);
        autoSaver.executeRoundup(alice, bytes32("t4"), 0, 2_630_000, dest, 1);
        assertEq(usdc.balanceOf(dest), 370_000);
    }

    function test_pause_userCanStillRevokeAndRevokedUserCannotBeExecuted() public {
        vm.prank(owner);
        autoSaver.setGlobalPaused(true);
        vm.prank(alice);
        autoSaver.revoke();

        vm.prank(owner);
        autoSaver.setGlobalPaused(false);
        vm.prank(relayer);
        vm.expectRevert(MovyAutoSaver.NotEnrolled.selector);
        autoSaver.executeRoundup(alice, bytes32("t5"), 0, 2_630_000, dest, 1);
        assertEq(usdc.balanceOf(dest), 0);
    }
}
