// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuthCaptureEscrow} from "commerce-payments/src/AuthCaptureEscrow.sol";
import {TokenCollector} from "commerce-payments/src/collectors/TokenCollector.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title SidequestOperator
///
/// @notice The `operator` of every Sidequest job escrowed in Coinbase's `AuthCaptureEscrow` v1.1.
///
/// @dev The escrow lets only a payment's operator authorize, capture and void it. This contract is that operator and
///      has no owner, no admin and no upgrade path: every transition is authorised by the job's rules and by a
///      signature (or call) from the party the rule names, and anyone may relay. Funds can only go to the payment's
///      receiver (the worker), the immutable fee receiver, or back to the payer (the buyer).
///
///      The buyer consents to the whole job with a single signature: the ERC-3009 `ReceiveWithAuthorization` that the
///      escrow's `ERC3009PaymentCollector` checks uses the payer-agnostic `PaymentInfo` hash as its nonce, and this
///      contract requires `PaymentInfo.salt == jobSalt(params)`, so every job parameter is inside the signed nonce.
///
///      Timeline of a job (all times are block timestamps, in seconds):
///      - delivery: `deliver` while `now < deliveryDeadline`;
///      - review: `approve` any time while delivered; `reject` while `now < deliveredAt + reviewWindow`;
///        `settleAfterReview` once `now >= deliveredAt + reviewWindow`;
///      - dispute and arbitration: `rule` while `now < rejectedAt + disputeWindow + arbitrationWindow`;
///        `settleUnruled` from then on;
///      - no delivery: `refundUndelivered` once `now >= deliveryDeadline`.
///      `fund` requires `authorizationExpiry >= deliveryDeadline + reviewWindow + disputeWindow + arbitrationWindow +
///      MARGIN`, so the escrow's own deadlines (capture before `authorizationExpiry`, payer `reclaim` from then on)
///      never cut a window short.
///
/// @author Sidequest
contract SidequestOperator is EIP712, ReentrancyGuardTransient {
    /// @notice Where a job is in its lifecycle. `Settled` is the only terminal status.
    enum Status {
        None,
        Funded,
        Delivered,
        Disputed,
        Settled
    }

    /// @notice How a settled job ended.
    enum Outcome {
        None,
        /// @dev The payer approved the delivery: full capture.
        Approved,
        /// @dev The review window passed without a rejection: full capture.
        AcceptedBySilence,
        /// @dev The arbitrator ruled: the worker's share is captured, the rest voided.
        Ruled,
        /// @dev The arbitration deadline passed without a ruling: full void back to the payer.
        Unruled,
        /// @dev Nothing was delivered by the delivery deadline: full void back to the payer.
        Undelivered
    }

    /// @notice The job parameters that `PaymentInfo` has no field for. Their EIP-712 struct hash is the payment's salt.
    struct JobParams {
        /// @dev The Sidequest job id; makes the payment unique even when two jobs share terms.
        bytes32 jobId;
        /// @dev `sha256(JCS(terms))` of the accepted proposal.
        bytes32 termsDigest;
        /// @dev Delivery must be recorded strictly before this timestamp.
        uint48 deliveryDeadline;
        /// @dev Seconds after delivery during which the payer may reject.
        uint32 reviewWindow;
        /// @dev Seconds after a rejection for the parties to put their case.
        uint32 disputeWindow;
        /// @dev Further seconds, after the dispute window, for the arbitrator to rule.
        uint32 arbitrationWindow;
        /// @dev The only key whose ruling settles a dispute.
        address arbitrator;
    }

    /// @notice Stored state of one job, keyed by the escrow's `PaymentInfo` hash.
    struct Job {
        Status status;
        Outcome outcome;
        uint48 deliveryDeadline;
        uint32 reviewWindow;
        uint32 disputeWindow;
        uint32 arbitrationWindow;
        uint48 deliveredAt;
        uint48 rejectedAt;
        address arbitrator;
        bytes32 termsDigest;
        bytes32 deliveryHash;
    }

    /// @notice Basis-point denominator.
    uint256 public constant BPS = 10_000;

    /// @notice A worker share of 100 %, in basis points.
    uint16 internal constant FULL_SHARE_BPS = 10_000;

    /// @notice Highest fee the constructor accepts, in basis points.
    uint16 public constant MAX_FEE_BPS = 2000;

    /// @notice Bounds of the review and dispute windows.
    uint32 public constant MIN_REVIEW_WINDOW = 1 hours;
    uint32 public constant MAX_REVIEW_WINDOW = 14 days;
    uint32 public constant MIN_DISPUTE_WINDOW = 1 hours;
    uint32 public constant MAX_DISPUTE_WINDOW = 14 days;

    /// @notice Bounds of the arbitration window.
    uint32 public constant MIN_ARBITRATION_WINDOW = 12 hours;
    uint32 public constant MAX_ARBITRATION_WINDOW = 14 days;

    /// @notice Slack between the last possible job deadline and the escrow's `authorizationExpiry`, so that the
    ///         permissionless settlement after the last window has time to land before the payer can `reclaim`.
    uint256 public constant MARGIN = 1 days;

    /// @notice EIP-712 type of `JobParams`; `PaymentInfo.salt` must equal its struct hash.
    bytes32 public constant JOB_PARAMS_TYPEHASH = keccak256(
        "JobParams(bytes32 jobId,bytes32 termsDigest,uint48 deliveryDeadline,uint32 reviewWindow,uint32 disputeWindow,uint32 arbitrationWindow,address arbitrator)"
    );

    /// @notice EIP-712 type the receiver signs to record a delivery.
    bytes32 public constant DELIVERY_TYPEHASH = keccak256("Delivery(bytes32 paymentInfoHash,bytes32 deliveryHash)");

    /// @notice EIP-712 type the payer signs to approve a delivery.
    bytes32 public constant APPROVAL_TYPEHASH = keccak256("Approval(bytes32 paymentInfoHash,bytes32 deliveryHash)");

    /// @notice EIP-712 type the payer signs to reject a delivery.
    bytes32 public constant REJECTION_TYPEHASH = keccak256("Rejection(bytes32 paymentInfoHash,bytes32 deliveryHash)");

    /// @notice EIP-712 type the arbitrator signs to rule on a dispute.
    bytes32 public constant RULING_TYPEHASH = keccak256("Ruling(bytes32 paymentInfoHash,uint16 workerShareBps)");

    /// @notice The `AuthCaptureEscrow` singleton.
    AuthCaptureEscrow public immutable ESCROW;

    /// @notice The `ERC3009PaymentCollector` every job is funded through.
    address public immutable COLLECTOR;

    /// @notice Fee in basis points, written into every payment as both `minFeeBps` and `maxFeeBps`.
    uint16 public immutable FEE_BPS;

    /// @notice Receiver of every fee, written into every payment as `feeReceiver`.
    address public immutable FEE_RECEIVER;

    mapping(bytes32 paymentInfoHash => Job job) internal _jobs;

    /// @notice A job was registered and its funds authorised into the escrow.
    event JobFunded(
        bytes32 indexed paymentInfoHash,
        bytes32 indexed jobId,
        bytes32 indexed termsDigest,
        address payer,
        address receiver,
        address token,
        uint256 amount,
        uint48 deliveryDeadline,
        uint32 reviewWindow,
        uint32 disputeWindow,
        uint32 arbitrationWindow,
        address arbitrator,
        uint48 authorizationExpiry
    );

    /// @notice The receiver recorded a delivery; the review window runs until `reviewDeadline`.
    event JobDelivered(
        bytes32 indexed paymentInfoHash,
        bytes32 indexed termsDigest,
        bytes32 deliveryHash,
        uint48 deliveredAt,
        uint48 reviewDeadline
    );

    /// @notice The payer rejected the delivery; the arbitrator may rule until `arbitrationDeadline`.
    event JobRejected(
        bytes32 indexed paymentInfoHash, bytes32 indexed termsDigest, uint48 rejectedAt, uint48 arbitrationDeadline
    );

    /// @notice The job reached its terminal outcome. `capturedAmount` (including `feeAmount`) went out of escrow to the
    ///         receiver and fee receiver, `refundedAmount` was voided back to the payer.
    event JobSettled(
        bytes32 indexed paymentInfoHash,
        bytes32 indexed termsDigest,
        Outcome indexed outcome,
        uint16 workerShareBps,
        uint256 capturedAmount,
        uint256 feeAmount,
        uint256 refundedAmount,
        uint48 settledAt
    );

    /// @notice A constructor argument is the zero address.
    error ZeroAddress();

    /// @notice The fee exceeds `MAX_FEE_BPS`.
    error FeeTooHigh(uint16 feeBps);

    /// @notice The collector does not collect payments for `ESCROW`.
    error InvalidCollector(address collector);

    /// @notice `PaymentInfo.operator` is not this contract.
    error InvalidOperator(address operator);

    /// @notice The payment's fee bounds or fee receiver differ from this contract's.
    error InvalidFeeTerms(uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver);

    /// @notice `PaymentInfo.salt` is not `jobSalt(params)`.
    error SaltMismatch(uint256 salt, uint256 expected);

    /// @notice The payer, receiver, token or arbitrator is unusable.
    error InvalidParty();

    /// @notice A window is outside its bounds.
    error InvalidWindow(uint32 window, uint32 min, uint32 max);

    /// @notice The delivery deadline has already passed at funding time.
    error DeliveryDeadlineInPast(uint48 deliveryDeadline);

    /// @notice `authorizationExpiry` would let the payer reclaim before the job's last window closes.
    error AuthorizationExpiryTooEarly(uint48 authorizationExpiry, uint256 required);

    /// @notice The job is not in the status this action requires.
    error InvalidStatus(bytes32 paymentInfoHash, Status status, Status required);

    /// @notice The action is attempted at or after its deadline.
    error DeadlinePassed(uint256 timestamp, uint256 deadline);

    /// @notice The action is attempted before its earliest time.
    error TooEarly(uint256 timestamp, uint256 earliest);

    /// @notice The delivery hash is zero.
    error ZeroDeliveryHash();

    /// @notice The worker share exceeds 10 000 basis points.
    error InvalidWorkerShare(uint16 workerShareBps);

    /// @notice The caller is not `signer` and the signature is not a valid EIP-712 signature by `signer`.
    error Unauthorized(address signer);

    /// @param escrow The `AuthCaptureEscrow` singleton.
    /// @param collector An `ERC3009PaymentCollector` bound to `escrow`.
    /// @param feeBps The fee in basis points, at most `MAX_FEE_BPS` (Sidequest uses 500).
    /// @param feeReceiver The treasury that receives every fee.
    constructor(address escrow, address collector, uint16 feeBps, address feeReceiver)
        EIP712("SidequestOperator", "1")
    {
        if (escrow == address(0) || collector == address(0) || feeReceiver == address(0)) revert ZeroAddress();
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh(feeBps);
        if (
            address(TokenCollector(collector).authCaptureEscrow()) != escrow
                || TokenCollector(collector).collectorType() != TokenCollector.CollectorType.Payment
        ) revert InvalidCollector(collector);
        ESCROW = AuthCaptureEscrow(escrow);
        COLLECTOR = collector;
        FEE_BPS = feeBps;
        FEE_RECEIVER = feeReceiver;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Transitions
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Registers a job and authorises its full amount into the escrow with the payer's ERC-3009 signature.
    ///
    /// @dev Anyone may relay. The payer's ERC-3009 `ReceiveWithAuthorization` signature (in `collectorData`, optionally
    ///      ERC-6492 wrapped) signs the payer-agnostic `PaymentInfo` hash as nonce; with `salt == jobSalt(params)` it
    ///      covers every job parameter, so a relayer can change nothing.
    ///
    /// @param paymentInfo The escrow payment. `operator` must be this contract, `minFeeBps == maxFeeBps == FEE_BPS`,
    ///        `feeReceiver == FEE_RECEIVER`, `salt == jobSalt(params)`. The whole `maxAmount` is authorised.
    /// @param params The job parameters bound by the salt.
    /// @param collectorData The payer's ERC-3009 signature, passed to the collector.
    ///
    /// @return paymentInfoHash The escrow's hash of `paymentInfo`, which keys the job everywhere.
    function fund(
        AuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        JobParams calldata params,
        bytes calldata collectorData
    ) external nonReentrant returns (bytes32 paymentInfoHash) {
        _validateFunding(paymentInfo, params);

        paymentInfoHash = ESCROW.getHash(paymentInfo);
        Job storage job = _jobs[paymentInfoHash];
        if (job.status != Status.None) revert InvalidStatus(paymentInfoHash, job.status, Status.None);

        job.status = Status.Funded;
        job.deliveryDeadline = params.deliveryDeadline;
        job.reviewWindow = params.reviewWindow;
        job.disputeWindow = params.disputeWindow;
        job.arbitrationWindow = params.arbitrationWindow;
        job.arbitrator = params.arbitrator;
        job.termsDigest = params.termsDigest;

        emit JobFunded(
            paymentInfoHash,
            params.jobId,
            params.termsDigest,
            paymentInfo.payer,
            paymentInfo.receiver,
            paymentInfo.token,
            paymentInfo.maxAmount,
            params.deliveryDeadline,
            params.reviewWindow,
            params.disputeWindow,
            params.arbitrationWindow,
            params.arbitrator,
            paymentInfo.authorizationExpiry
        );

        ESCROW.authorize(paymentInfo, paymentInfo.maxAmount, COLLECTOR, collectorData);
    }

    /// @notice Records the delivery hash on chain. Starts the review window.
    ///
    /// @dev Called by the receiver, or relayed by anyone with the receiver's EIP-712 `Delivery` signature. Only while
    ///      funded and strictly before the delivery deadline; once.
    ///
    /// @param paymentInfo The job's escrow payment.
    /// @param deliveryHash Non-zero hash of the delivered artefact.
    /// @param receiverSignature The receiver's `Delivery` signature; ignored when the receiver calls.
    function deliver(
        AuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        bytes32 deliveryHash,
        bytes calldata receiverSignature
    ) external nonReentrant {
        (bytes32 paymentInfoHash, Job storage job) = _load(paymentInfo, Status.Funded);
        if (block.timestamp >= job.deliveryDeadline) revert DeadlinePassed(block.timestamp, job.deliveryDeadline);
        if (deliveryHash == bytes32(0)) revert ZeroDeliveryHash();
        _requireAuthorized(
            paymentInfo.receiver,
            keccak256(abi.encode(DELIVERY_TYPEHASH, paymentInfoHash, deliveryHash)),
            receiverSignature
        );

        uint48 deliveredAt = _now();
        job.status = Status.Delivered;
        job.deliveredAt = deliveredAt;
        job.deliveryHash = deliveryHash;

        // The only external calls so far are static (the escrow's `getHash`, an ERC-1271 check): nothing can re-enter.
        // forge-lint: disable-next-line(reentrancy-events)
        emit JobDelivered(paymentInfoHash, job.termsDigest, deliveryHash, deliveredAt, deliveredAt + job.reviewWindow);
    }

    /// @notice The payer approves the delivery: captures the full amount to the receiver, less the fee.
    ///
    /// @dev Called by the payer, or relayed by anyone with the payer's EIP-712 `Approval` signature, which names the
    ///      recorded delivery hash: an approval approves that delivery and no other. Only while delivered (before or
    ///      after the review window, as long as nothing else settled the job).
    ///
    /// @param paymentInfo The job's escrow payment.
    /// @param payerSignature The payer's `Approval` signature; ignored when the payer calls.
    function approve(AuthCaptureEscrow.PaymentInfo calldata paymentInfo, bytes calldata payerSignature)
        external
        nonReentrant
    {
        (bytes32 paymentInfoHash, Job storage job) = _load(paymentInfo, Status.Delivered);
        _requireAuthorized(
            paymentInfo.payer,
            keccak256(abi.encode(APPROVAL_TYPEHASH, paymentInfoHash, job.deliveryHash)),
            payerSignature
        );
        _settle(paymentInfo, paymentInfoHash, job, Outcome.Approved, FULL_SHARE_BPS);
    }

    /// @notice Silence is acceptance: once the review window has passed without a rejection, captures in full.
    ///
    /// @dev Anyone may call, from `deliveredAt + reviewWindow` on. It must land before the escrow's
    ///      `authorizationExpiry`, which `fund` placed at least `disputeWindow + arbitrationWindow + MARGIN` later.
    ///
    /// @param paymentInfo The job's escrow payment.
    function settleAfterReview(AuthCaptureEscrow.PaymentInfo calldata paymentInfo) external nonReentrant {
        (bytes32 paymentInfoHash, Job storage job) = _load(paymentInfo, Status.Delivered);
        uint256 reviewDeadline = uint256(job.deliveredAt) + job.reviewWindow;
        if (block.timestamp < reviewDeadline) revert TooEarly(block.timestamp, reviewDeadline);
        _settle(paymentInfo, paymentInfoHash, job, Outcome.AcceptedBySilence, FULL_SHARE_BPS);
    }

    /// @notice The payer rejects the delivery inside the review window. The job becomes disputed.
    ///
    /// @dev Called by the payer, or relayed by anyone with the payer's EIP-712 `Rejection` signature, which names the
    ///      recorded delivery hash.
    ///
    /// @param paymentInfo The job's escrow payment.
    /// @param payerSignature The payer's `Rejection` signature; ignored when the payer calls.
    function reject(AuthCaptureEscrow.PaymentInfo calldata paymentInfo, bytes calldata payerSignature)
        external
        nonReentrant
    {
        (bytes32 paymentInfoHash, Job storage job) = _load(paymentInfo, Status.Delivered);
        uint256 reviewDeadline = uint256(job.deliveredAt) + job.reviewWindow;
        if (block.timestamp >= reviewDeadline) revert DeadlinePassed(block.timestamp, reviewDeadline);
        _requireAuthorized(
            paymentInfo.payer,
            keccak256(abi.encode(REJECTION_TYPEHASH, paymentInfoHash, job.deliveryHash)),
            payerSignature
        );

        uint48 rejectedAt = _now();
        job.status = Status.Disputed;
        job.rejectedAt = rejectedAt;

        // The only external calls so far are static (the escrow's `getHash`, an ERC-1271 check): nothing can re-enter.
        // forge-lint: disable-start(reentrancy-events)
        emit JobRejected(
            paymentInfoHash, job.termsDigest, rejectedAt, rejectedAt + job.disputeWindow + job.arbitrationWindow
        );
        // forge-lint: disable-end(reentrancy-events)
    }

    /// @notice Settles a dispute by the arbitrator's ruling: `workerShareBps` of the amount is captured to the receiver
    ///         (the fee taken proportionally from that part), the rest is voided back to the payer.
    ///
    /// @dev Called by the arbitrator, or relayed by anyone with the arbitrator's EIP-712 `Ruling` signature. Only while
    ///      disputed and strictly before `rejectedAt + disputeWindow + arbitrationWindow`. The worker's amount rounds
    ///      down, so any rounding dust goes back to the payer.
    ///
    /// @param paymentInfo The job's escrow payment.
    /// @param workerShareBps The worker's share in basis points, 0 to 10 000.
    /// @param arbitratorSignature The arbitrator's `Ruling` signature; ignored when the arbitrator calls.
    function rule(
        AuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint16 workerShareBps,
        bytes calldata arbitratorSignature
    ) external nonReentrant {
        (bytes32 paymentInfoHash, Job storage job) = _load(paymentInfo, Status.Disputed);
        uint256 deadline = _arbitrationDeadline(job);
        if (block.timestamp >= deadline) revert DeadlinePassed(block.timestamp, deadline);
        if (workerShareBps > BPS) revert InvalidWorkerShare(workerShareBps);
        _requireAuthorized(
            job.arbitrator, keccak256(abi.encode(RULING_TYPEHASH, paymentInfoHash, workerShareBps)), arbitratorSignature
        );
        _settle(paymentInfo, paymentInfoHash, job, Outcome.Ruled, workerShareBps);
    }

    /// @notice A dispute nobody ruled on by the arbitration deadline is refunded to the payer in full.
    ///
    /// @dev Anyone may call. A refund is the default because it is the outcome the escrow itself falls back to
    ///      (`reclaim` after `authorizationExpiry`) and the only one that needs no further capture before that expiry.
    ///
    /// @param paymentInfo The job's escrow payment.
    function settleUnruled(AuthCaptureEscrow.PaymentInfo calldata paymentInfo) external nonReentrant {
        (bytes32 paymentInfoHash, Job storage job) = _load(paymentInfo, Status.Disputed);
        uint256 deadline = _arbitrationDeadline(job);
        if (block.timestamp < deadline) revert TooEarly(block.timestamp, deadline);
        _settle(paymentInfo, paymentInfoHash, job, Outcome.Unruled, 0);
    }

    /// @notice Nothing was delivered by the delivery deadline: voids the payment back to the payer.
    ///
    /// @dev Anyone may call, from `deliveryDeadline` on, while the job is still only funded.
    ///
    /// @param paymentInfo The job's escrow payment.
    function refundUndelivered(AuthCaptureEscrow.PaymentInfo calldata paymentInfo) external nonReentrant {
        (bytes32 paymentInfoHash, Job storage job) = _load(paymentInfo, Status.Funded);
        if (block.timestamp < job.deliveryDeadline) revert TooEarly(block.timestamp, job.deliveryDeadline);
        _settle(paymentInfo, paymentInfoHash, job, Outcome.Undelivered, 0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice The stored state of a job.
    ///
    /// @param paymentInfoHash The escrow's hash of the job's `PaymentInfo`.
    ///
    /// @return The job; `status == None` if it was never funded.
    function getJob(bytes32 paymentInfoHash) external view returns (Job memory) {
        return _jobs[paymentInfoHash];
    }

    /// @notice The `PaymentInfo.salt` that binds `params` into the payer's ERC-3009 signature.
    ///
    /// @param params The job parameters.
    ///
    /// @return The EIP-712 struct hash of `params`, as a `uint256`.
    function jobSalt(JobParams calldata params) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(JOB_PARAMS_TYPEHASH, params)));
    }

    /// @notice The EIP-712 digest a receiver signs to record `deliveryHash` for a job.
    ///
    /// @param paymentInfoHash The job's payment hash.
    /// @param deliveryHash The delivered artefact's hash.
    ///
    /// @return The digest to sign.
    function deliveryDigest(bytes32 paymentInfoHash, bytes32 deliveryHash) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(DELIVERY_TYPEHASH, paymentInfoHash, deliveryHash)));
    }

    /// @notice The EIP-712 digest a payer signs to approve a job's delivery.
    ///
    /// @param paymentInfoHash The job's payment hash.
    ///
    /// @return The digest to sign.
    function approvalDigest(bytes32 paymentInfoHash, bytes32 deliveryHash) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(APPROVAL_TYPEHASH, paymentInfoHash, deliveryHash)));
    }

    /// @notice The EIP-712 digest a payer signs to reject a job's delivery.
    ///
    /// @param paymentInfoHash The job's payment hash.
    ///
    /// @return The digest to sign.
    function rejectionDigest(bytes32 paymentInfoHash, bytes32 deliveryHash) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REJECTION_TYPEHASH, paymentInfoHash, deliveryHash)));
    }

    /// @notice The EIP-712 digest an arbitrator signs to rule on a job.
    ///
    /// @param paymentInfoHash The job's payment hash.
    /// @param workerShareBps The worker's share in basis points.
    ///
    /// @return The digest to sign.
    function rulingDigest(bytes32 paymentInfoHash, uint16 workerShareBps) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RULING_TYPEHASH, paymentInfoHash, workerShareBps)));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev Every check `fund` makes before touching state. The escrow additionally checks the amount, the expiry
    ///      ordering, the fee range and that `now < preApprovalExpiry`.
    function _validateFunding(AuthCaptureEscrow.PaymentInfo calldata paymentInfo, JobParams calldata params)
        internal
        view
    {
        if (paymentInfo.operator != address(this)) revert InvalidOperator(paymentInfo.operator);
        if (
            paymentInfo.minFeeBps != FEE_BPS || paymentInfo.maxFeeBps != FEE_BPS
                || paymentInfo.feeReceiver != FEE_RECEIVER
        ) revert InvalidFeeTerms(paymentInfo.minFeeBps, paymentInfo.maxFeeBps, paymentInfo.feeReceiver);
        uint256 expectedSalt = jobSalt(params);
        if (paymentInfo.salt != expectedSalt) revert SaltMismatch(paymentInfo.salt, expectedSalt);

        address arbitrator = params.arbitrator;
        if (
            paymentInfo.payer == address(0) || paymentInfo.receiver == address(0) || paymentInfo.token == address(0)
                || arbitrator == address(0) || arbitrator == paymentInfo.payer || arbitrator == paymentInfo.receiver
        ) revert InvalidParty();

        _checkWindow(params.reviewWindow, MIN_REVIEW_WINDOW, MAX_REVIEW_WINDOW);
        _checkWindow(params.disputeWindow, MIN_DISPUTE_WINDOW, MAX_DISPUTE_WINDOW);
        _checkWindow(params.arbitrationWindow, MIN_ARBITRATION_WINDOW, MAX_ARBITRATION_WINDOW);

        if (params.deliveryDeadline <= block.timestamp) revert DeliveryDeadlineInPast(params.deliveryDeadline);
        uint256 required = uint256(params.deliveryDeadline) + params.reviewWindow + params.disputeWindow
            + params.arbitrationWindow + MARGIN;
        if (paymentInfo.authorizationExpiry < required) {
            revert AuthorizationExpiryTooEarly(paymentInfo.authorizationExpiry, required);
        }
    }

    /// @dev The block timestamp as a `uint48`, the escrow's own time type.
    function _now() internal view returns (uint48) {
        // casting to 'uint48' is safe because timestamps fit until the year 8 921 556.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint48(block.timestamp);
    }

    /// @dev Reverts unless `min <= window <= max`.
    function _checkWindow(uint32 window, uint32 min, uint32 max) internal pure {
        if (window < min || window > max) revert InvalidWindow(window, min, max);
    }

    /// @dev Loads the job for `paymentInfo` and requires it to be in `required` status. The escrow hash covers every
    ///      `PaymentInfo` field, so a job can only be found with its exact, original payment.
    function _load(AuthCaptureEscrow.PaymentInfo calldata paymentInfo, Status required)
        internal
        view
        returns (bytes32 paymentInfoHash, Job storage job)
    {
        paymentInfoHash = ESCROW.getHash(paymentInfo);
        job = _jobs[paymentInfoHash];
        if (job.status != required) revert InvalidStatus(paymentInfoHash, job.status, required);
    }

    /// @dev The last instant (exclusive) at which a disputed job can be ruled on.
    function _arbitrationDeadline(Job storage job) internal view returns (uint256) {
        return uint256(job.rejectedAt) + job.disputeWindow + job.arbitrationWindow;
    }

    /// @dev Accepts a call from `signer` itself, or a valid EIP-712 signature by `signer` (EOA or ERC-1271) over
    ///      `structHash` in this contract's domain.
    function _requireAuthorized(address signer, bytes32 structHash, bytes calldata signature) internal view {
        if (msg.sender == signer) return;
        if (!SignatureChecker.isValidSignatureNowCalldata(signer, _hashTypedDataV4(structHash), signature)) {
            revert Unauthorized(signer);
        }
    }

    /// @dev Moves the job to its terminal state, then captures `workerShareBps` of the amount (fee proportional, both
    ///      rounded down) and voids the remainder. Effects precede both escrow calls.
    function _settle(
        AuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        bytes32 paymentInfoHash,
        Job storage job,
        Outcome outcome,
        uint16 workerShareBps
    ) internal {
        uint256 amount = paymentInfo.maxAmount;
        uint256 captured = amount * workerShareBps / BPS;
        // The fee must be computed from the captured amount: the escrow requires exactly
        // `captured * minFeeBps / 10_000 <= fee <= captured * maxFeeBps / 10_000`, and min == max == FEE_BPS.
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 fee = captured * FEE_BPS / BPS;
        uint256 refunded = amount - captured;

        job.status = Status.Settled;
        job.outcome = outcome;

        // The only external calls so far are static (the escrow's `getHash`, an ERC-1271 check): nothing can re-enter.
        // forge-lint: disable-start(reentrancy-events)
        emit JobSettled(paymentInfoHash, job.termsDigest, outcome, workerShareBps, captured, fee, refunded, _now());
        // forge-lint: disable-end(reentrancy-events)

        if (captured != 0) ESCROW.capture(paymentInfo, captured, fee, FEE_RECEIVER);
        if (refunded != 0) ESCROW.void(paymentInfo);
    }
}
