// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuthCaptureEscrow} from "commerce-payments/src/AuthCaptureEscrow.sol";
import {ERC3009PaymentCollector} from "commerce-payments/src/collectors/ERC3009PaymentCollector.sol";
import {MockERC3009Token} from "commerce-payments/test/mocks/MockERC3009Token.sol";

import {SidequestOperator} from "../../src/SidequestOperator.sol";
import {SigningKit} from "./SigningKit.sol";

/// @dev A local escrow, collector and ERC-3009 token, plus one operator with a 5 % fee, and helpers to build, sign and
///      drive jobs through it.
abstract contract OperatorTestBase is Test, SigningKit {
    uint16 internal constant FEE_BPS = 500;
    uint256 internal constant DEFAULT_AMOUNT = 1000e6;
    uint32 internal constant REVIEW = 3 days;
    uint32 internal constant DISPUTE = 2 days;
    uint32 internal constant ARBITRATION = 7 days;
    uint48 internal constant START = 1_800_000_000;

    AuthCaptureEscrow internal escrow;
    ERC3009PaymentCollector internal collector;
    MockERC3009Token internal token;
    SidequestOperator internal op;

    uint256 internal payerPk = 0xB0B;
    uint256 internal receiverPk = 0xCAFE;
    uint256 internal arbitratorPk = 0xA4B;
    uint256 internal strangerPk = 0xBAD;
    address internal payer;
    address internal receiver;
    address internal arbitrator;
    address internal stranger;
    address internal treasury = makeAddr("treasury");
    address internal relayer = makeAddr("relayer");

    uint256 private _jobNonce;

    function setUp() public virtual {
        vm.warp(START);
        payer = vm.addr(payerPk);
        receiver = vm.addr(receiverPk);
        arbitrator = vm.addr(arbitratorPk);
        stranger = vm.addr(strangerPk);

        escrow = new AuthCaptureEscrow();
        collector = new ERC3009PaymentCollector(address(escrow), makeAddr("multicall3"));
        token = new MockERC3009Token("USD Coin", "USDC", 6);
        op = new SidequestOperator(address(escrow), address(collector), FEE_BPS, treasury);
        _bindSigning(escrow, address(collector));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Building jobs
    // ---------------------------------------------------------------------------------------------------------------

    function _params() internal returns (SidequestOperator.JobParams memory) {
        return SidequestOperator.JobParams({
            jobId: keccak256(abi.encode("job", ++_jobNonce)),
            termsDigest: keccak256("terms"),
            deliveryDeadline: uint48(vm.getBlockTimestamp() + 7 days),
            reviewWindow: REVIEW,
            disputeWindow: DISPUTE,
            arbitrationWindow: ARBITRATION,
            arbitrator: arbitrator
        });
    }

    function _requiredExpiry(SidequestOperator.JobParams memory params) internal view returns (uint48) {
        return uint48(
            uint256(params.deliveryDeadline) + params.reviewWindow + params.disputeWindow + params.arbitrationWindow
                + op.MARGIN()
        );
    }

    /// @dev A payment that `fund` accepts for `params`: exact salt, fees and the minimum authorization expiry.
    function _paymentInfo(SidequestOperator.JobParams memory params, uint256 amount)
        internal
        view
        returns (AuthCaptureEscrow.PaymentInfo memory pi)
    {
        uint48 authorizationExpiry = _requiredExpiry(params);
        pi = AuthCaptureEscrow.PaymentInfo({
            operator: address(op),
            payer: payer,
            receiver: receiver,
            token: address(token),
            maxAmount: uint120(amount),
            preApprovalExpiry: uint48(vm.getBlockTimestamp() + 1 days),
            authorizationExpiry: authorizationExpiry,
            refundExpiry: authorizationExpiry,
            minFeeBps: FEE_BPS,
            maxFeeBps: FEE_BPS,
            feeReceiver: treasury,
            salt: _salt(params)
        });
    }

    function _salt(SidequestOperator.JobParams memory params) internal view returns (uint256) {
        return op.jobSalt(params);
    }

    /// @dev Mints to the payer, signs the ERC-3009 authorization with `payerPk` and funds via a relayer.
    function _fund(AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params)
        internal
        returns (bytes32 hash)
    {
        token.mint(pi.payer, pi.maxAmount);
        bytes memory sig = _signReceive(payerPk, address(token), pi);
        vm.prank(relayer);
        hash = op.fund(pi, params, sig);
    }

    function _fundDefault()
        internal
        returns (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash)
    {
        params = _params();
        pi = _paymentInfo(params, DEFAULT_AMOUNT);
        hash = _fund(pi, params);
    }

    function _deliver(AuthCaptureEscrow.PaymentInfo memory pi) internal {
        vm.prank(pi.receiver);
        op.deliver(pi, keccak256("artefact"), "");
    }

    function _fundAndDeliver()
        internal
        returns (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash)
    {
        (pi, params, hash) = _fundDefault();
        _deliver(pi);
    }

    function _fundDeliverReject()
        internal
        returns (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash)
    {
        (pi, params, hash) = _fundAndDeliver();
        vm.prank(pi.payer);
        op.reject(pi, "");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Operator signatures
    // ---------------------------------------------------------------------------------------------------------------

    function _signDelivery(uint256 pk, bytes32 hash, bytes32 deliveryHash) internal view returns (bytes memory) {
        return _sign(pk, op.deliveryDigest(hash, deliveryHash));
    }

    function _signApproval(uint256 pk, bytes32 hash) internal view returns (bytes memory) {
        return _sign(pk, op.approvalDigest(hash, op.getJob(hash).deliveryHash));
    }

    function _signRejection(uint256 pk, bytes32 hash) internal view returns (bytes memory) {
        return _sign(pk, op.rejectionDigest(hash, op.getJob(hash).deliveryHash));
    }

    function _signRuling(uint256 pk, bytes32 hash, uint16 bps) internal view returns (bytes memory) {
        return _sign(pk, op.rulingDigest(hash, bps));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Assertions
    // ---------------------------------------------------------------------------------------------------------------

    function _status(bytes32 hash) internal view returns (SidequestOperator.Status) {
        return op.getJob(hash).status;
    }

    function _capturable(bytes32 hash) internal view returns (uint256 capturable) {
        (, capturable,) = escrow.paymentState(hash);
    }

    /// @dev The split `_settle` must produce for `bps` of `amount`.
    function _split(uint256 amount, uint256 bps)
        internal
        pure
        returns (uint256 toReceiver, uint256 fee, uint256 refunded)
    {
        uint256 captured = amount * bps / 10_000;
        fee = captured * FEE_BPS / 10_000;
        toReceiver = captured - fee;
        refunded = amount - captured;
    }
}
