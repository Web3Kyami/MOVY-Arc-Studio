// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MovyAutoSaver, IERC20} from "../src/MovyAutoSaver.sol";

contract MockUSDC is IERC20 {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    uint256 public override totalSupply;

    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address recipient, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: transfer amount exceeds balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external override returns (bool) {
        require(balanceOf[sender] >= amount, "ERC20: transfer amount exceeds balance");
        require(allowance[sender][msg.sender] >= amount, "ERC20: insufficient allowance");
        allowance[sender][msg.sender] -= amount;
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract MaliciousReentrantReceiver {
    MovyAutoSaver public autoSaver;
    address public wallet;

    constructor(MovyAutoSaver _autoSaver, address _wallet) {
        autoSaver = _autoSaver;
        wallet = _wallet;
    }

    // Try to re-enter executeRoundup if called
    fallback() external {
        autoSaver.executeRoundup(wallet, bytes32("tx"), 0, 170_000, address(this), 1);
    }
}

contract MovyAutoSaverTest is Test {
    MockUSDC public usdc;
    MovyAutoSaver public autoSaver;

    address public owner = address(0xA11CE);
    address public relayer = address(0x8E1A1);
    address public alice = address(0xA11C3);
    address public savingsDest = address(0x5A8E5);
    address public merchant = address(0x111E8);

    uint64 public constant ONE_DOLLAR = 1_000_000; // 6 decimals
    uint64 public constant FIVE_DOLLARS = 5_000_000;
    uint64 public constant TEN_DOLLARS = 10_000_000;

    function setUp() public {
        vm.startPrank(owner);
        usdc = new MockUSDC();
        autoSaver = new MovyAutoSaver(address(usdc), relayer);
        vm.stopPrank();

        // Mint initial USDC balances (in 6 decimals)
        usdc.mint(alice, 100 * ONE_DOLLAR); // $100
        usdc.mint(relayer, 10 * ONE_DOLLAR); // $10
    }

    function test_constructor_requires_separate_nonzero_owner_and_relayer() public {
        vm.expectRevert(MovyAutoSaver.InvalidRoleConfiguration.selector);
        vm.prank(owner);
        new MovyAutoSaver(address(usdc), address(0));

        vm.expectRevert(MovyAutoSaver.InvalidRoleConfiguration.selector);
        vm.prank(owner);
        new MovyAutoSaver(address(usdc), owner);
    }

    /*//////////////////////////////////////////////////////////////
                           ARITHMETIC TESTS
    //////////////////////////////////////////////////////////////*/

    function test_calculateRoundup_headlineSeventeenCents() public view {
        // $0.17 = 170,000 units. Roundup to $1.00 is $0.83 = 830,000 units
        uint64 roundup = autoSaver.calculateRoundup(170_000);
        assertEq(roundup, 830_000);
    }

    function test_calculateRoundup_twoDollarSixtyThree() public view {
        // $2.63 = 2,630,000 units. Roundup to $3.00 is $0.37 = 370,000 units
        uint64 roundup = autoSaver.calculateRoundup(2_630_000);
        assertEq(roundup, 370_000);
    }

    function test_calculateRoundup_oneCent() public view {
        // $0.01 = 10,000 units. Roundup is $0.99 = 990,000 units
        uint64 roundup = autoSaver.calculateRoundup(10_000);
        assertEq(roundup, 990_000);
    }

    function test_calculateRoundup_ninetyNineCents() public view {
        // $0.99 = 990,000 units. Roundup is $0.01 = 10,000 units
        uint64 roundup = autoSaver.calculateRoundup(990_000);
        assertEq(roundup, 10_000);
    }

    function test_calculateRoundup_exactWholeDollars() public view {
        // Exact whole dollars have zero roundup
        assertEq(autoSaver.calculateRoundup(ONE_DOLLAR), 0);
        assertEq(autoSaver.calculateRoundup(2 * ONE_DOLLAR), 0);
        assertEq(autoSaver.calculateRoundup(100 * ONE_DOLLAR), 0);
    }

    function test_calculateRoundup_tinyAmount() public view {
        // 1 micro-USDC (0.000001) -> 999,999 units
        assertEq(autoSaver.calculateRoundup(1), 999_999);
    }

    function testFuzz_calculateRoundup(uint64 paymentAmount6) public view {
        vm.assume(paymentAmount6 > 0 && paymentAmount6 < 1_000_000_000_000);
        uint64 roundup = autoSaver.calculateRoundup(paymentAmount6);
        uint64 rem = paymentAmount6 % ONE_DOLLAR;
        if (rem == 0) {
            assertEq(roundup, 0);
        } else {
            assertEq(roundup, ONE_DOLLAR - rem);
            assertEq((paymentAmount6 + roundup) % ONE_DOLLAR, 0);
            assertTrue(roundup < ONE_DOLLAR);
        }
    }

    /*//////////////////////////////////////////////////////////////
                          ENROLLMENT & CONFIG
    //////////////////////////////////////////////////////////////*/

    function test_enroll_success() public {
        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);
        vm.stopPrank();

        MovyAutoSaver.UserConfig memory cfg = autoSaver.getUserConfig(alice);
        assertEq(cfg.destination, savingsDest);
        assertEq(cfg.maxRoundup6, ONE_DOLLAR);
        assertEq(cfg.dailyCap6, FIVE_DOLLARS);
        assertEq(cfg.configEpoch, 1);
        assertFalse(cfg.paused);
        assertTrue(cfg.enrolled);
    }

    function test_enroll_revert_alreadyEnrolled() public {
        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);
        vm.expectRevert(MovyAutoSaver.AlreadyEnrolled.selector);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);
        vm.stopPrank();
    }

    function test_enroll_revert_invalidDestination() public {
        vm.startPrank(alice);
        // Zero address
        vm.expectRevert(MovyAutoSaver.InvalidDestination.selector);
        autoSaver.enroll(address(0), ONE_DOLLAR, FIVE_DOLLARS);

        // Self-loop prevention
        vm.expectRevert(MovyAutoSaver.InvalidDestination.selector);
        autoSaver.enroll(alice, ONE_DOLLAR, FIVE_DOLLARS);

        // Contract address
        vm.expectRevert(MovyAutoSaver.InvalidDestination.selector);
        autoSaver.enroll(address(autoSaver), ONE_DOLLAR, FIVE_DOLLARS);

        // USDC address
        vm.expectRevert(MovyAutoSaver.InvalidDestination.selector);
        autoSaver.enroll(address(usdc), ONE_DOLLAR, FIVE_DOLLARS);

        // Relayer address
        vm.expectRevert(MovyAutoSaver.InvalidDestination.selector);
        autoSaver.enroll(relayer, ONE_DOLLAR, FIVE_DOLLARS);
        vm.stopPrank();
    }

    function test_enroll_revert_invalidCaps() public {
        vm.startPrank(alice);
        // Zero max roundup
        vm.expectRevert(MovyAutoSaver.InvalidCap.selector);
        autoSaver.enroll(savingsDest, 0, FIVE_DOLLARS);

        // Daily cap less than max roundup
        vm.expectRevert(MovyAutoSaver.InvalidCap.selector);
        autoSaver.enroll(savingsDest, FIVE_DOLLARS, ONE_DOLLAR);

        // Max roundup exceeding ceiling ($100)
        vm.expectRevert(MovyAutoSaver.InvalidCap.selector);
        autoSaver.enroll(savingsDest, 101 * ONE_DOLLAR, 200 * ONE_DOLLAR);

        // Daily cap exceeding ceiling ($1000)
        vm.expectRevert(MovyAutoSaver.InvalidCap.selector);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, 1001 * ONE_DOLLAR);
        vm.stopPrank();
    }

    function test_updateConfig_success() public {
        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);

        address newDest = address(0x99999);
        autoSaver.updateConfig(newDest, 2 * ONE_DOLLAR, TEN_DOLLARS);
        vm.stopPrank();

        MovyAutoSaver.UserConfig memory cfg = autoSaver.getUserConfig(alice);
        assertEq(cfg.destination, newDest);
        assertEq(cfg.maxRoundup6, 2 * ONE_DOLLAR);
        assertEq(cfg.dailyCap6, TEN_DOLLARS);
        assertEq(cfg.configEpoch, 2);
    }

    function test_setPaused_and_revoke() public {
        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);

        // Pause
        autoSaver.setPaused(true);
        assertTrue(autoSaver.getUserConfig(alice).paused);

        // Unpause
        autoSaver.setPaused(false);
        assertFalse(autoSaver.getUserConfig(alice).paused);

        // Revoke
        autoSaver.revoke();
        MovyAutoSaver.UserConfig memory cfg = autoSaver.getUserConfig(alice);
        assertFalse(cfg.enrolled);
        assertTrue(cfg.paused);
        assertEq(cfg.destination, address(0));
        assertEq(cfg.configEpoch, 2);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                           EXECUTION TESTS
    //////////////////////////////////////////////////////////////*/

    function test_executeRoundup_success_seventeenCentsToEightyThree() public {
        // 1. Alice enrolls and grants bounded approval of $5 USDC
        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);
        usdc.approve(address(autoSaver), FIVE_DOLLARS);
        vm.stopPrank();

        bytes32 paymentTxHash = keccak256("merchant_payment_tx");
        uint256 logIndex = 1;
        uint64 paymentAmount6 = 170_000; // $0.17

        uint256 aliceBalBefore = usdc.balanceOf(alice);
        uint256 destBalBefore = usdc.balanceOf(savingsDest);

        // 2. Relayer calls executeRoundup
        vm.prank(relayer);
        autoSaver.executeRoundup(alice, paymentTxHash, logIndex, paymentAmount6, savingsDest, 1);

        // 3. Verify balances: exactly $0.83 transferred
        uint64 expectedRoundup = 830_000; // $0.83
        assertEq(usdc.balanceOf(alice), aliceBalBefore - expectedRoundup);
        assertEq(usdc.balanceOf(savingsDest), destBalBefore + expectedRoundup);

        // 4. Verify allowance decreased correctly from $5.00 to $4.17
        assertEq(usdc.allowance(alice, address(autoSaver)), FIVE_DOLLARS - expectedRoundup);

        // 5. Verify daily spent tracked correctly
        uint256 currentDay = block.timestamp / 86400;
        assertEq(autoSaver.getDailySpent(alice, currentDay), expectedRoundup);
        assertEq(autoSaver.getRemainingDailyAllowance(alice), FIVE_DOLLARS - expectedRoundup);

        // 6. Verify replay protection: payment key is now processed
        bytes32 key = autoSaver.computePaymentKey(block.chainid, paymentTxHash, logIndex, alice);
        assertTrue(autoSaver.isPaymentProcessed(key));
    }

    function test_executeRoundup_revert_replay() public {
        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);
        usdc.approve(address(autoSaver), FIVE_DOLLARS);
        vm.stopPrank();

        bytes32 paymentTxHash = keccak256("merchant_payment_tx");
        uint256 logIndex = 1;
        uint64 paymentAmount6 = 170_000; // $0.17

        vm.prank(relayer);
        autoSaver.executeRoundup(alice, paymentTxHash, logIndex, paymentAmount6, savingsDest, 1);

        // Second call with same payment identity MUST revert
        bytes32 key = autoSaver.computePaymentKey(block.chainid, paymentTxHash, logIndex, alice);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MovyAutoSaver.PaymentAlreadyProcessed.selector, key));
        autoSaver.executeRoundup(alice, paymentTxHash, logIndex, paymentAmount6, savingsDest, 1);
    }

    function test_executeRoundup_revert_unauthorizedRelayer() public {
        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);
        usdc.approve(address(autoSaver), FIVE_DOLLARS);
        vm.stopPrank();

        bytes32 paymentTxHash = keccak256("merchant_payment_tx");
        vm.prank(alice); // Alice is not the authorized relayer
        vm.expectRevert(MovyAutoSaver.Unauthorized.selector);
        autoSaver.executeRoundup(alice, paymentTxHash, 0, 170_000, savingsDest, 1);
    }

    function test_executeRoundup_revert_exactDollarPayment() public {
        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);
        usdc.approve(address(autoSaver), FIVE_DOLLARS);
        vm.stopPrank();

        bytes32 paymentTxHash = keccak256("merchant_payment_tx");
        // $3.00 exact whole dollar payment has $0 roundup -> reverts with ZeroRoundup
        vm.prank(relayer);
        vm.expectRevert(MovyAutoSaver.ZeroRoundup.selector);
        autoSaver.executeRoundup(alice, paymentTxHash, 0, 3 * ONE_DOLLAR, savingsDest, 1);
    }

    function test_executeRoundup_revert_userPaused() public {
        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);
        usdc.approve(address(autoSaver), FIVE_DOLLARS);
        autoSaver.setPaused(true);
        vm.stopPrank();

        bytes32 paymentTxHash = keccak256("merchant_payment_tx");
        vm.prank(relayer);
        vm.expectRevert(MovyAutoSaver.UserIsPaused.selector);
        autoSaver.executeRoundup(alice, paymentTxHash, 0, 170_000, savingsDest, 1);
    }

    function test_executeRoundup_revert_contractPaused() public {
        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);
        usdc.approve(address(autoSaver), FIVE_DOLLARS);
        vm.stopPrank();

        vm.prank(owner);
        autoSaver.setGlobalPaused(true);

        bytes32 paymentTxHash = keccak256("merchant_payment_tx");
        vm.prank(relayer);
        vm.expectRevert(MovyAutoSaver.ContractPaused.selector);
        autoSaver.executeRoundup(alice, paymentTxHash, 0, 170_000, savingsDest, 1);
    }

    function test_executeRoundup_revert_destinationMismatch() public {
        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);
        usdc.approve(address(autoSaver), FIVE_DOLLARS);
        vm.stopPrank();

        bytes32 paymentTxHash = keccak256("merchant_payment_tx");
        address wrongDest = address(0xBAD);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MovyAutoSaver.DestinationMismatch.selector, savingsDest, wrongDest));
        autoSaver.executeRoundup(alice, paymentTxHash, 0, 170_000, wrongDest, 1);
    }

    function test_executeRoundup_revert_configEpochMismatch() public {
        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);
        usdc.approve(address(autoSaver), FIVE_DOLLARS);
        // Alice updates her config, advancing epoch to 2
        autoSaver.updateConfig(savingsDest, ONE_DOLLAR, TEN_DOLLARS);
        vm.stopPrank();

        bytes32 paymentTxHash = keccak256("merchant_payment_tx");
        // Relayer submits with stale epoch 1
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MovyAutoSaver.ConfigEpochMismatch.selector, 2, 1));
        autoSaver.executeRoundup(alice, paymentTxHash, 0, 170_000, savingsDest, 1);
    }

    function test_executeRoundup_revert_roundupExceedsCap() public {
        vm.startPrank(alice);
        // Alice configures max roundup of only $0.50 (500,000 units)
        autoSaver.enroll(savingsDest, 500_000, FIVE_DOLLARS);
        usdc.approve(address(autoSaver), FIVE_DOLLARS);
        vm.stopPrank();

        bytes32 paymentTxHash = keccak256("merchant_payment_tx");
        // Payment of $0.17 generates $0.83 roundup which is > $0.50 cap
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MovyAutoSaver.RoundupExceedsCap.selector, 830_000, 500_000));
        autoSaver.executeRoundup(alice, paymentTxHash, 0, 170_000, savingsDest, 1);
    }

    function test_executeRoundup_revert_dailyCapExceeded_and_resetNextDay() public {
        vm.startPrank(alice);
        // Daily cap of $1.50
        autoSaver.enroll(savingsDest, ONE_DOLLAR, 1_500_000);
        usdc.approve(address(autoSaver), FIVE_DOLLARS);
        vm.stopPrank();

        // Transaction 1: $0.17 payment -> $0.83 saved. Daily total = $0.83
        vm.prank(relayer);
        autoSaver.executeRoundup(alice, keccak256("tx1"), 0, 170_000, savingsDest, 1);

        // Transaction 2: $0.20 payment -> $0.80 saved. Total would be $1.63 > $1.50 cap -> Revert!
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MovyAutoSaver.DailyCapExceeded.selector, 1_630_000, 1_500_000));
        autoSaver.executeRoundup(alice, keccak256("tx2"), 0, 200_000, savingsDest, 1);

        // Fast forward 1 day (86,400 seconds) to next UTC day
        vm.warp(block.timestamp + 86400);

        // Now Transaction 2 succeeds because it's a new UTC day!
        vm.prank(relayer);
        autoSaver.executeRoundup(alice, keccak256("tx2"), 0, 200_000, savingsDest, 1);
        uint256 currentDay = block.timestamp / 86400;
        assertEq(autoSaver.getDailySpent(alice, currentDay), 800_000);
    }

    function test_executeRoundup_revert_insufficientAllowance() public {
        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);
        // Alice only approved $0.50
        usdc.approve(address(autoSaver), 500_000);
        vm.stopPrank();

        bytes32 paymentTxHash = keccak256("merchant_payment_tx");
        // Roundup is $0.83 > $0.50 allowance -> transferFrom fails
        vm.prank(relayer);
        vm.expectRevert(MovyAutoSaver.TransferFailed.selector);
        autoSaver.executeRoundup(alice, paymentTxHash, 0, 170_000, savingsDest, 1);
    }

    function test_executeRoundup_revert_insufficientBalance() public {
        address bob = address(0xB0B);
        // Bob has 0 USDC
        vm.startPrank(bob);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);
        usdc.approve(address(autoSaver), FIVE_DOLLARS);
        vm.stopPrank();

        bytes32 paymentTxHash = keccak256("merchant_payment_tx");
        vm.prank(relayer);
        vm.expectRevert(MovyAutoSaver.TransferFailed.selector);
        autoSaver.executeRoundup(bob, paymentTxHash, 0, 170_000, savingsDest, 1);
    }

    function testFuzz_executeRoundup_solvency(uint32 paymentCents) public {
        vm.assume(paymentCents > 0 && paymentCents < 100_000); // Up to $1,000
        uint64 paymentAmount6 = uint64(paymentCents) * 10_000;
        uint64 rem = paymentAmount6 % ONE_DOLLAR;
        if (rem == 0) return; // Exact dollars revert with ZeroRoundup, handled in dedicated test

        uint64 expectedRoundup = ONE_DOLLAR - rem;

        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, TEN_DOLLARS);
        usdc.approve(address(autoSaver), TEN_DOLLARS);
        vm.stopPrank();

        uint256 aliceBalBefore = usdc.balanceOf(alice);
        uint256 destBalBefore = usdc.balanceOf(savingsDest);

        bytes32 paymentTxHash = keccak256(abi.encode("fuzz_tx", paymentCents));
        vm.prank(relayer);
        autoSaver.executeRoundup(alice, paymentTxHash, 0, paymentAmount6, savingsDest, 1);

        assertEq(usdc.balanceOf(alice), aliceBalBefore - expectedRoundup);
        assertEq(usdc.balanceOf(savingsDest), destBalBefore + expectedRoundup);
    }

    function test_admin_setRelayer() public {
        address newRelayer = address(0x7777);
        vm.prank(owner);
        autoSaver.setRelayer(newRelayer);
        assertEq(autoSaver.relayer(), newRelayer);

        // Unauthorized
        vm.prank(alice);
        vm.expectRevert(MovyAutoSaver.Unauthorized.selector);
        autoSaver.setRelayer(alice);
    }

    function test_admin_roles_cannot_be_converged() public {
        vm.expectRevert(MovyAutoSaver.InvalidRoleConfiguration.selector);
        vm.prank(owner);
        autoSaver.setRelayer(owner);

        vm.expectRevert(MovyAutoSaver.InvalidRoleConfiguration.selector);
        vm.prank(owner);
        autoSaver.transferOwnership(relayer);
    }

    function test_admin_transferOwnership() public {
        address newOwner = address(0x8888);
        vm.prank(owner);
        autoSaver.transferOwnership(newOwner);
        assertEq(autoSaver.owner(), newOwner);

        // Unauthorized
        vm.prank(alice);
        vm.expectRevert(MovyAutoSaver.Unauthorized.selector);
        autoSaver.transferOwnership(alice);
    }

    function test_admin_setGlobalPaused() public {
        vm.prank(owner);
        autoSaver.setGlobalPaused(true);
        assertTrue(autoSaver.paused());

        vm.prank(owner);
        autoSaver.setGlobalPaused(false);
        assertFalse(autoSaver.paused());

        // Unauthorized
        vm.prank(alice);
        vm.expectRevert(MovyAutoSaver.Unauthorized.selector);
        autoSaver.setGlobalPaused(true);
    }

    function test_executeRoundup_revert_zeroPayment() public {
        vm.startPrank(alice);
        autoSaver.enroll(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);
        usdc.approve(address(autoSaver), FIVE_DOLLARS);
        vm.stopPrank();

        bytes32 paymentTxHash = keccak256("merchant_payment_tx");
        vm.prank(relayer);
        vm.expectRevert(MovyAutoSaver.ZeroPayment.selector);
        autoSaver.executeRoundup(alice, paymentTxHash, 0, 0, savingsDest, 1);
    }

    function test_executeRoundup_revert_notEnrolled() public {
        address charlie = address(0xCCC);
        bytes32 paymentTxHash = keccak256("merchant_payment_tx");
        vm.prank(relayer);
        vm.expectRevert(MovyAutoSaver.NotEnrolled.selector);
        autoSaver.executeRoundup(charlie, paymentTxHash, 0, 170_000, savingsDest, 1);
    }

    function test_unregistered_user_actions_revert() public {
        address charlie = address(0xCCC);
        vm.startPrank(charlie);

        vm.expectRevert(MovyAutoSaver.NotEnrolled.selector);
        autoSaver.updateConfig(savingsDest, ONE_DOLLAR, FIVE_DOLLARS);

        vm.expectRevert(MovyAutoSaver.NotEnrolled.selector);
        autoSaver.setPaused(true);

        vm.expectRevert(MovyAutoSaver.NotEnrolled.selector);
        autoSaver.revoke();

        vm.stopPrank();
    }
}
