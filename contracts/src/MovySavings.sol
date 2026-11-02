// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title MovySavings
/// @notice Single-transaction USDC purchase-and-roundup vault for Arc.
///
/// MOVY's whole thesis is that one signature produces two effects: the merchant is
/// paid the exact purchase amount, and the caller's spare change is credited to
/// withdrawable savings they own. This contract is that mechanism and nothing else.
///
/// ## Units — the single most important thing about this file
///
/// Arc's native gas token is USDC with **18 decimals** (`msg.value` and gas are
/// both 18-decimal). The optional ERC-20 USDC interface at
/// `0x3600000000000000000000000000000000000000` is **6 decimals** and shares the same
/// underlying balance. This contract only ever touches the **native** interface and
/// only ever uses 18-decimal units, so it can never be confused with the ERC-20 view.
/// Callers must never pass this contract a 6-decimal amount.
///
/// User-facing money is expressed in **integer cents**, never floats:
///   roundupCents = (100 - (purchaseCents % 100)) % 100
///   totalCents   = purchaseCents + roundupCents
///   totalWei     = totalCents * 10^16   (1 cent = 10^16 native 18-decimal units)
///
/// ## Trust
///
/// Unaudited hackathon code. No admin, no owner, no proxy, no upgrade path, no
/// sweep, no fee skim, no pooled goal routing, no relayer. The only ways native
/// USDC can leave are the two functions below.
contract MovySavings {
    /*//////////////////////////////////////////////////////////////
                                 CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Native 18-decimal units in one cent. 10^18 / 10^2 = 10^16.
    uint256 internal constant CENTS_UNIT = 1e16;

    /// @notice Cents in one US dollar.
    uint256 internal constant CENTS_PER_DOLLAR = 100;

    /// @notice Practical ceiling on a single purchase, in cents ($10,000.00).
    /// @dev Not a security boundary. It exists to reject obviously wrong input and
    ///      to keep the arithmetic far away from uint256 overflow. A roundup app
    ///      whose purchase exceeds $10,000 is out of product scope.
    uint256 public constant MAX_PURCHASE_CENTS = 1_000_000;

    /// @dev Reentrancy state. 1 = not entered, 2 = entered.
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    /*//////////////////////////////////////////////////////////////
                                  STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Withdrawable savings owed to each payer, in 18-decimal native units.
    /// @dev Only ever increased by `payAndSave` and decreased by `withdraw` from
    ///      the same address, so the balance is owned by `msg.sender` at all times.
    mapping(address => uint256) private _savings;

    /// @notice Sum of all `_savings`. Maintained incrementally so solvency is O(1).
    uint256 private _totalLiabilities;

    /// @notice Reentrancy guard state.
    uint256 private _reentrancyStatus;

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Emitted only after the merchant has actually been paid.
    /// @param payer The account that signed and that owns the savings.
    /// @param merchant The recipient that received `purchaseWei`.
    /// @param purchaseWei Exact amount credited to the merchant, 18 decimals.
    /// @param roundupWei Exact amount credited to the payer's savings, 18 decimals.
    /// @dev Emitted after the external transfer, so a listener that sees this event
    ///      can trust that the merchant balance already moved.
    event PurchaseRounded(
        address indexed payer,
        address indexed merchant,
        uint256 purchaseWei,
        uint256 roundupWei
    );

    /// @notice Emitted after a successful withdrawal transfer.
    event SavingsWithdrawn(address indexed owner, uint256 amountWei);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error MovyZeroPurchase();
    error MovyPurchaseTooLarge(uint256 purchaseCents, uint256 maxCents);
    error MovyZeroMerchant();
    error MovySelfMerchant();
    error MovyValueMismatch(uint256 sentWei, uint256 requiredWei);
    error MovyInsufficientSavings(uint256 requestedWei, uint256 availableWei);
    error MovyZeroWithdrawal();
    error MovyReentrancy();
    error MovyMerchantTransferFailed();

    /*//////////////////////////////////////////////////////////////
                               MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier nonReentrant() {
        if (_reentrancyStatus == ENTERED) revert MovyReentrancy();
        _reentrancyStatus = ENTERED;
        _;
        _reentrancyStatus = NOT_ENTERED;
    }

    constructor() {
        _reentrancyStatus = NOT_ENTERED;
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Withdrawable savings owed to `account`, in 18-decimal native units.
    function savingsOf(address account) external view returns (uint256) {
        return _savings[account];
    }

    /// @notice Sum of all savings owed to all payers, in 18-decimal native units.
    /// @dev Invariant: `address(this).balance >= totalLiabilities()` at all times.
    ///      Strictly greater is possible and expected, because anyone may send
    ///      native USDC to this address directly. Those unsolicited funds are
    ///      intentionally not reclaimable: there is no sweep and no admin.
    function totalLiabilities() public view returns (uint256) {
        return _totalLiabilities;
    }

    /// @notice Roundup arithmetic, exposed so the frontend can read the contract's
    ///         own numbers instead of re-deriving them.
    /// @param purchaseCents Purchase price in integer cents.
    /// @return roundupCents Integer cents added to reach the next whole dollar. 0 on an exact dollar.
    /// @return purchaseWei Purchase price in 18-decimal native units.
    /// @return roundupWei Roundup in 18-decimal native units.
    /// @return totalWei Exact `msg.value` required for this purchase.
    function quotePurchase(uint256 purchaseCents)
        external
        pure
        returns (uint256 roundupCents, uint256 purchaseWei, uint256 roundupWei, uint256 totalWei)
    {
        (roundupCents, purchaseWei, roundupWei, totalWei) = _quote(purchaseCents);
    }

    /// @dev Pure arithmetic core. No storage, no calls, no rounding surprises.
    function _quote(uint256 purchaseCents)
        internal
        pure
        returns (uint256 roundupCents, uint256 purchaseWei, uint256 roundupWei, uint256 totalWei)
    {
        roundupCents = (CENTS_PER_DOLLAR - (purchaseCents % CENTS_PER_DOLLAR)) % CENTS_PER_DOLLAR;
        purchaseWei = purchaseCents * CENTS_UNIT;
        roundupWei = roundupCents * CENTS_UNIT;
        totalWei = purchaseWei + roundupWei;
    }

    /*//////////////////////////////////////////////////////////////
                                 PAYMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Pay `merchant` exactly `purchaseCents` and keep the roundup.
    ///
    /// @dev In one transaction and one signature:
    ///      1. the merchant receives the exact purchase amount,
    ///      2. `msg.sender` gains the roundup as withdrawable savings.
    ///
    ///      `msg.value` must be exactly `totalWei`, which is always a whole number
    ///      of dollars. A merchant transfer that fails for any reason — an Arc
    ///      blocklisted address, a precompile, a recipient that reverts, a
    ///      recipient that consumed more than it was sent — reverts this entire
    ///      call, including the savings credit. Partial settlement is impossible.
    ///
    /// @param merchant Recipient of the purchase amount. Must not be zero or the caller.
    /// @param purchaseCents Price of the purchase in integer cents. Must be >= 1.
    function payAndSave(address payable merchant, uint256 purchaseCents) external payable nonReentrant {
        if (purchaseCents == 0) revert MovyZeroPurchase();
        if (purchaseCents > MAX_PURCHASE_CENTS) revert MovyPurchaseTooLarge(purchaseCents, MAX_PURCHASE_CENTS);
        if (merchant == address(0)) revert MovyZeroMerchant();
        if (merchant == msg.sender) revert MovySelfMerchant();

        (uint256 roundupCents, uint256 purchaseWei, uint256 roundupWei, uint256 totalWei) = _quote(purchaseCents);

        if (msg.value != totalWei) revert MovyValueMismatch(msg.value, totalWei);

        // --- Effects first (checks-effects-interactions) ---
        if (roundupWei > 0) {
            _savings[msg.sender] += roundupWei;
            _totalLiabilities += roundupWei;
        }

        // --- Then the external interaction. Arc forbids value transfers to the
        //     zero address and to blocklisted addresses at runtime, so this call
        //     reverts the whole transaction on its own. We still bubble a generic
        //     failure up so a plain "merchant transfer failed" is distinguishable
        //     from a caller input error.
        (bool ok, ) = merchant.call{value: purchaseWei}("");
        if (!ok) revert MovyMerchantTransferFailed();

        // --- Emit only after the merchant is actually paid. ---
        emit PurchaseRounded(msg.sender, merchant, purchaseWei, roundupWei);
    }

    /*//////////////////////////////////////////////////////////////
                               WITHDRAWAL
    //////////////////////////////////////////////////////////////*/

    /// @notice Withdraw own savings back to the connected wallet.
    /// @dev Only the owner of the savings can call this, and only for their own
    ///      balance. There is no admin path and no third-party path.
    /// @param amountWei Amount in 18-decimal native units. Must be > 0 and <= savings.
    function withdraw(uint256 amountWei) external nonReentrant {
        if (amountWei == 0) revert MovyZeroWithdrawal();

        uint256 available = _savings[msg.sender];
        if (amountWei > available) revert MovyInsufficientSavings(amountWei, available);

        // Decrement before the external call.
        unchecked {
            _savings[msg.sender] = available - amountWei;
            _totalLiabilities -= amountWei;
        }

        // Sending to `msg.sender` is the owner's own address. If this transfer
        // fails — for example because the owner is on Arc's runtime blocklist —
        // the whole call reverts and the decrement above is rolled back too.
        (bool ok, ) = payable(msg.sender).call{value: amountWei}("");
        require(ok, "MOVY: withdrawal transfer failed");

        emit SavingsWithdrawn(msg.sender, amountWei);
    }

    /// @notice Accept native USDC so the contract can be funded for tests.
    /// @dev The contract needs no funding: `payAndSave` forwards value it receives
    ///      in the same call. This exists only so a `receive`/`fallback` is explicit
    ///      rather than accidental, and it intentionally does not credit savings,
    ///      because unsolicited value is not a purchase and must not mint a roundup.
    receive() external payable {}
}
