// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal interface for ERC-20 operations on Arc USDC.
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

/// @title MovyAutoSaver
/// @notice Automatic spare-change savings executor for enrolled Arc wallets.
///
/// MOVY automatically saves spare change from supported outgoing USDC payments.
/// When an enrolled user makes an ordinary purchase (e.g. $0.17 USDC), an offchain
/// observer calculates the spare-change roundup (e.g. $0.83 USDC to reach $1.00) and
/// an authorized relayer calls `executeRoundup`.
///
/// Safety Model & Trust Boundaries:
/// - Custody-free: MOVY never holds user deposits in this contract. Roundups move directly
///   from the user's wallet to their configured savings destination via `transferFrom`.
/// - Finite Bounded Approval: The user approves a finite, bounded amount of ERC-20 USDC.
/// - Hard Caps: Per-roundup cap and deterministic UTC daily cap enforced onchain.
/// - User Controls: The user can pause, unpause, change destination/caps, or revoke at any time.
/// - Replay Protection: Every payment is tracked by an immutable (chainId, txHash, logIndex, wallet) key.
/// - Relayer Attribution: Only an authorized relayer can submit roundups, but damage is strictly bounded
///   by the user's configured destination, caps, and finite ERC-20 allowance.
contract MovyAutoSaver {
    /*//////////////////////////////////////////////////////////////
                               STRUCTS
    //////////////////////////////////////////////////////////////*/

    struct UserConfig {
        address destination;
        uint64 maxRoundup6;
        uint64 dailyCap6;
        uint32 configEpoch;
        bool paused;
        bool enrolled;
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Canonical Arc ERC-20 USDC interface address.
    address public constant CANONICAL_ARC_USDC = 0x3600000000000000000000000000000000000000;

    /// @notice 6-decimal units per whole US dollar ($1.00 = 1,000,000 units).
    uint64 public constant UNITS_PER_DOLLAR = 1_000_000;

    /// @notice Absolute ceiling on a single roundup ($100.00).
    uint64 public constant MAX_ROUNDUP_CEILING = 100_000_000;

    /// @notice Absolute ceiling on a daily cap ($1,000.00).
    uint64 public constant MAX_DAILY_CAP_CEILING = 1_000_000_000;

    /// @dev Reentrancy status constants.
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Address of the ERC-20 USDC token used for savings transfers.
    address public immutable usdc;

    /// @notice Owner / administrator of the contract.
    address public owner;

    /// @notice Authorized relayer permitted to submit roundups.
    address public relayer;

    /// @notice Global emergency pause flag.
    bool public paused;

    /// @dev Reentrancy guard slot.
    uint256 private _reentrancyStatus;

    /// @notice User enrollment configurations indexed by wallet address.
    mapping(address => UserConfig) private _userConfigs;

    /// @notice Daily spent amount per wallet per UTC day index (block.timestamp / 86400).
    mapping(address => mapping(uint256 => uint64)) private _dailySpent;

    /// @notice Processed payment replay protection mapping.
    mapping(bytes32 => bool) public isPaymentProcessed;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event UserEnrolled(
        address indexed wallet,
        address indexed destination,
        uint64 maxRoundup6,
        uint64 dailyCap6,
        uint32 configEpoch
    );

    event UserConfigUpdated(
        address indexed wallet,
        address indexed destination,
        uint64 maxRoundup6,
        uint64 dailyCap6,
        uint32 configEpoch
    );

    event UserPauseToggled(address indexed wallet, bool paused);

    event UserRevoked(address indexed wallet, uint32 finalEpoch);

    event RoundupExecuted(
        bytes32 indexed paymentKey,
        address indexed wallet,
        address indexed destination,
        uint64 paymentAmount6,
        uint64 roundupAmount6,
        bytes32 paymentTxHash,
        uint256 canonicalLogIndex
    );

    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    event GlobalPauseToggled(bool paused);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error Unauthorized();
    error NotEnrolled();
    error AlreadyEnrolled();
    error ContractPaused();
    error UserIsPaused();
    error InvalidDestination();
    error InvalidCap();
    error PaymentAlreadyProcessed(bytes32 paymentKey);
    error DestinationMismatch(address expected, address provided);
    error ConfigEpochMismatch(uint32 expected, uint32 provided);
    error RoundupExceedsCap(uint64 amount, uint64 maxCap);
    error DailyCapExceeded(uint64 totalSpentToday, uint64 dailyCap);
    error ZeroPayment();
    error ZeroRoundup();
    error TransferFailed();
    error ReentrancyGuardReentrantCall();
    error InvalidRoleConfiguration();

    /*//////////////////////////////////////////////////////////////
                               MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuardReentrantCall();
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address usdcAddress, address relayerAddress) {
        // The owner and transaction signer must never collapse into one key.
        // This catches the unsafe deploy-script configuration used by the old
        // Testnet deployment before the contract can accept enrollments.
        if (relayerAddress == address(0) || relayerAddress == msg.sender) {
            revert InvalidRoleConfiguration();
        }
        owner = msg.sender;
        relayer = relayerAddress;
        usdc = usdcAddress == address(0) ? CANONICAL_ARC_USDC : usdcAddress;
        _reentrancyStatus = _NOT_ENTERED;
    }

    /*//////////////////////////////////////////////////////////////
                         USER ENROLLMENT & CONFIG
    //////////////////////////////////////////////////////////////*/

    /// @notice Enroll the caller's wallet into automatic spare-change savings.
    /// @param destination The savings destination address (must not be self, zero, usdc, or relayer).
    /// @param maxRoundup6 Maximum allowed roundup per transaction in 6-decimal units.
    /// @param dailyCap6 Maximum allowed total savings per UTC day in 6-decimal units.
    function enroll(address destination, uint64 maxRoundup6, uint64 dailyCap6) external {
        UserConfig storage cfg = _userConfigs[msg.sender];
        if (cfg.enrolled) revert AlreadyEnrolled();

        _validateDestination(msg.sender, destination);
        _validateCaps(maxRoundup6, dailyCap6);

        uint32 newEpoch = cfg.configEpoch + 1;
        _userConfigs[msg.sender] = UserConfig({
            destination: destination,
            maxRoundup6: maxRoundup6,
            dailyCap6: dailyCap6,
            configEpoch: newEpoch,
            paused: false,
            enrolled: true
        });

        emit UserEnrolled(msg.sender, destination, maxRoundup6, dailyCap6, newEpoch);
    }

    /// @notice Update existing enrollment settings.
    /// @param destination New savings destination address.
    /// @param maxRoundup6 New maximum roundup per transaction.
    /// @param dailyCap6 New daily cap.
    function updateConfig(address destination, uint64 maxRoundup6, uint64 dailyCap6) external {
        UserConfig storage cfg = _userConfigs[msg.sender];
        if (!cfg.enrolled) revert NotEnrolled();

        _validateDestination(msg.sender, destination);
        _validateCaps(maxRoundup6, dailyCap6);

        cfg.destination = destination;
        cfg.maxRoundup6 = maxRoundup6;
        cfg.dailyCap6 = dailyCap6;
        cfg.configEpoch += 1;

        emit UserConfigUpdated(msg.sender, destination, maxRoundup6, dailyCap6, cfg.configEpoch);
    }

    /// @notice Toggle the user's personal pause state.
    /// @param isPaused True to pause automatic roundups, false to resume.
    function setPaused(bool isPaused) external {
        UserConfig storage cfg = _userConfigs[msg.sender];
        if (!cfg.enrolled) revert NotEnrolled();

        cfg.paused = isPaused;
        emit UserPauseToggled(msg.sender, isPaused);
    }

    /// @notice Revoke enrollment completely.
    function revoke() external {
        UserConfig storage cfg = _userConfigs[msg.sender];
        if (!cfg.enrolled) revert NotEnrolled();

        cfg.enrolled = false;
        cfg.paused = true;
        cfg.destination = address(0);
        cfg.maxRoundup6 = 0;
        cfg.dailyCap6 = 0;
        cfg.configEpoch += 1;

        emit UserRevoked(msg.sender, cfg.configEpoch);
    }

    /*//////////////////////////////////////////////////////////////
                           ROUNDUP EXECUTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Execute an automatic spare-change roundup for an observed eligible payment.
    /// @dev Called only by the authorized relayer. Enforces onchain caps, replay protection,
    ///      destination match, and finite ERC-20 allowance.
    /// @param wallet The payer's enrolled wallet address.
    /// @param paymentTxHash Hash of the original merchant payment transaction.
    /// @param canonicalLogIndex Log index of the observed payment in the transaction receipt.
    /// @param paymentAmount6 Original payment amount in 6-decimal units.
    /// @param destination Expected destination address configured by the user.
    /// @param configEpoch Expected user configuration epoch to prevent executing against stale config.
    function executeRoundup(
        address wallet,
        bytes32 paymentTxHash,
        uint256 canonicalLogIndex,
        uint64 paymentAmount6,
        address destination,
        uint32 configEpoch
    ) external onlyRelayer nonReentrant {
        if (paused) revert ContractPaused();

        uint64 maxRoundup6;
        uint64 dailyCap6;
        {
            UserConfig memory cfg = _userConfigs[wallet];
            if (!cfg.enrolled) revert NotEnrolled();
            if (cfg.paused) revert UserIsPaused();
            if (cfg.destination != destination) revert DestinationMismatch(cfg.destination, destination);
            if (cfg.configEpoch != configEpoch) revert ConfigEpochMismatch(cfg.configEpoch, configEpoch);
            maxRoundup6 = cfg.maxRoundup6;
            dailyCap6 = cfg.dailyCap6;
        }

        bytes32 paymentKey = computePaymentKey(block.chainid, paymentTxHash, canonicalLogIndex, wallet);
        if (isPaymentProcessed[paymentKey]) revert PaymentAlreadyProcessed(paymentKey);

        // Mark processed before external call (CEI)
        isPaymentProcessed[paymentKey] = true;

        if (paymentAmount6 == 0) revert ZeroPayment();
        uint64 roundup6 = calculateRoundup(paymentAmount6);
        if (roundup6 == 0) revert ZeroRoundup();
        if (roundup6 > maxRoundup6) revert RoundupExceedsCap(roundup6, maxRoundup6);

        _recordDailySpend(wallet, roundup6, dailyCap6);

        // Execute ERC-20 transferFrom directly from wallet to user's destination
        _safeTransferFrom(wallet, destination, roundup6);

        emit RoundupExecuted(
            paymentKey,
            wallet,
            destination,
            paymentAmount6,
            roundup6,
            paymentTxHash,
            canonicalLogIndex
        );
    }

    /*//////////////////////////////////////////////////////////////
                             ADMIN CONTROLS
    //////////////////////////////////////////////////////////////*/

    function setRelayer(address newRelayer) external onlyOwner {
        if (newRelayer == address(0) || newRelayer == owner) revert InvalidRoleConfiguration();
        address oldRelayer = relayer;
        relayer = newRelayer;
        emit RelayerUpdated(oldRelayer, newRelayer);
    }

    function setGlobalPaused(bool isPaused) external onlyOwner {
        paused = isPaused;
        emit GlobalPauseToggled(isPaused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0) || newOwner == relayer) revert InvalidRoleConfiguration();
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Deterministically calculates the spare-change roundup to the next whole dollar.
    /// @dev In 6-decimal units: $0.17 = 170,000 -> $0.83 = 830,000. Whole dollars return 0.
    function calculateRoundup(uint64 paymentAmount6) public pure returns (uint64) {
        uint64 rem = paymentAmount6 % UNITS_PER_DOLLAR;
        if (rem == 0) {
            return 0;
        }
        return UNITS_PER_DOLLAR - rem;
    }

    /// @notice Compute unique deterministic payment replay key.
    function computePaymentKey(
        uint256 chainId,
        bytes32 paymentTxHash,
        uint256 canonicalLogIndex,
        address wallet
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(chainId, paymentTxHash, canonicalLogIndex, wallet));
    }

    /// @notice Get a user's enrollment configuration.
    function getUserConfig(address wallet) external view returns (UserConfig memory) {
        return _userConfigs[wallet];
    }

    /// @notice Get total spent for a wallet on a given UTC day index.
    function getDailySpent(address wallet, uint256 dayIndex) external view returns (uint64) {
        return _dailySpent[wallet][dayIndex];
    }

    /// @notice Get remaining daily roundup allowance for today.
    /// @dev Returns 0 while the contract-wide emergency pause is active, because
    ///      `executeRoundup` reverts with `ContractPaused` in that state. This is a
    ///      read-only reporting rule: no stored cap, spent amount, or action changes,
    ///      and the previous value is reported again as soon as the pause is lifted.
    function getRemainingDailyAllowance(address wallet) external view returns (uint64) {
        if (paused) return 0;
        UserConfig memory cfg = _userConfigs[wallet];
        if (!cfg.enrolled || cfg.paused) return 0;
        uint256 currentDay = block.timestamp / 86400;
        uint64 spentToday = _dailySpent[wallet][currentDay];
        if (spentToday >= cfg.dailyCap6) return 0;
        return cfg.dailyCap6 - spentToday;
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    function _validateDestination(address wallet, address destination) internal view {
        if (destination == address(0)) revert InvalidDestination();
        if (destination == wallet) revert InvalidDestination(); // No self-loops
        if (destination == address(this)) revert InvalidDestination(); // Not this contract
        if (destination == usdc) revert InvalidDestination(); // Not USDC contract
        if (destination == relayer) revert InvalidDestination(); // Not relayer
    }

    function _validateCaps(uint64 maxRoundup6, uint64 dailyCap6) internal pure {
        if (maxRoundup6 == 0 || maxRoundup6 > MAX_ROUNDUP_CEILING) revert InvalidCap();
        if (dailyCap6 < maxRoundup6 || dailyCap6 > MAX_DAILY_CAP_CEILING) revert InvalidCap();
    }

    function _recordDailySpend(address wallet, uint64 amount, uint64 dailyCap) internal {
        uint256 currentDay = block.timestamp / 86400;
        uint64 spentToday = _dailySpent[wallet][currentDay];
        uint64 newTotal = spentToday + amount;
        if (newTotal > dailyCap) revert DailyCapExceeded(newTotal, dailyCap);
        _dailySpent[wallet][currentDay] = newTotal;
    }

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = usdc.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }
}
