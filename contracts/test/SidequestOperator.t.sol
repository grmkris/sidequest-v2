// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuthCaptureEscrow} from "commerce-payments/src/AuthCaptureEscrow.sol";
import {ERC3009PaymentCollector} from "commerce-payments/src/collectors/ERC3009PaymentCollector.sol";
import {OperatorRefundCollector} from "commerce-payments/src/collectors/OperatorRefundCollector.sol";

import {SidequestOperator} from "../src/SidequestOperator.sol";
import {OperatorTestBase} from "./utils/OperatorTestBase.sol";
import {MockERC1271Wallet} from "./utils/SigningKit.sol";

contract ConstructorTest is OperatorTestBase {
    function test_constructor_setsImmutables() public view {
        assertEq(address(op.ESCROW()), address(escrow));
        assertEq(op.COLLECTOR(), address(collector));
        assertEq(op.FEE_BPS(), FEE_BPS);
        assertEq(op.FEE_RECEIVER(), treasury);
    }

    function test_constructor_acceptsMaxFeeAndZeroFee() public {
        assertEq(new SidequestOperator(address(escrow), address(collector), 2000, treasury).FEE_BPS(), 2000);
        assertEq(new SidequestOperator(address(escrow), address(collector), 0, treasury).FEE_BPS(), 0);
    }

    function test_constructor_revertsOnZeroEscrow() public {
        vm.expectRevert(SidequestOperator.ZeroAddress.selector);
        new SidequestOperator(address(0), address(collector), FEE_BPS, treasury);
    }

    function test_constructor_revertsOnZeroCollector() public {
        vm.expectRevert(SidequestOperator.ZeroAddress.selector);
        new SidequestOperator(address(escrow), address(0), FEE_BPS, treasury);
    }

    function test_constructor_revertsOnZeroFeeReceiver() public {
        vm.expectRevert(SidequestOperator.ZeroAddress.selector);
        new SidequestOperator(address(escrow), address(collector), FEE_BPS, address(0));
    }

    function test_constructor_revertsOnFeeAboveMax() public {
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.FeeTooHigh.selector, uint16(2001)));
        new SidequestOperator(address(escrow), address(collector), 2001, treasury);
    }

    function test_constructor_revertsOnCollectorOfAnotherEscrow() public {
        ERC3009PaymentCollector other = new ERC3009PaymentCollector(address(new AuthCaptureEscrow()), address(1));
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.InvalidCollector.selector, address(other)));
        new SidequestOperator(address(escrow), address(other), FEE_BPS, treasury);
    }

    function test_constructor_revertsOnRefundCollector() public {
        OperatorRefundCollector refundCollector = new OperatorRefundCollector(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.InvalidCollector.selector, address(refundCollector)));
        new SidequestOperator(address(escrow), address(refundCollector), FEE_BPS, treasury);
    }

    function test_eip712Domain_bindsNameVersionChainAndContract() public view {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) = op.eip712Domain();
        assertEq(name, "SidequestOperator");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(op));
    }
}

contract FundTest is OperatorTestBase {
    function test_fund_registersJobAndAuthorizesFullAmount() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        token.mint(payer, DEFAULT_AMOUNT);
        bytes memory sig = _signReceive(payerPk, address(token), pi);
        bytes32 expectedHash = escrow.getHash(pi);

        vm.expectEmit(address(op));
        emit SidequestOperator.JobFunded(
            expectedHash,
            params.jobId,
            params.termsDigest,
            payer,
            receiver,
            address(token),
            DEFAULT_AMOUNT,
            params.deliveryDeadline,
            REVIEW,
            DISPUTE,
            ARBITRATION,
            arbitrator,
            pi.authorizationExpiry
        );
        vm.prank(relayer);
        bytes32 hash = op.fund(pi, params, sig);

        assertEq(hash, expectedHash);
        SidequestOperator.Job memory job = op.getJob(hash);
        assertEq(uint8(job.status), uint8(SidequestOperator.Status.Funded));
        assertEq(uint8(job.outcome), uint8(SidequestOperator.Outcome.None));
        assertEq(job.deliveryDeadline, params.deliveryDeadline);
        assertEq(job.reviewWindow, REVIEW);
        assertEq(job.disputeWindow, DISPUTE);
        assertEq(job.arbitrationWindow, ARBITRATION);
        assertEq(job.arbitrator, arbitrator);
        assertEq(job.termsDigest, params.termsDigest);
        assertEq(job.deliveredAt, 0);
        assertEq(job.deliveryHash, bytes32(0));
        assertEq(_capturable(hash), DEFAULT_AMOUNT);
        assertEq(token.balanceOf(payer), 0);
        assertEq(token.balanceOf(escrow.getTokenStore(address(op))), DEFAULT_AMOUNT);
        assertEq(token.balanceOf(address(op)), 0);
    }

    function test_fund_acceptsSmartWalletPayer() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(payer);
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.payer = address(wallet);
        token.mint(address(wallet), DEFAULT_AMOUNT);
        bytes memory sig = _signReceive(payerPk, address(token), pi);
        bytes32 hash = op.fund(pi, params, sig);
        assertEq(_capturable(hash), DEFAULT_AMOUNT);
    }

    function test_fund_revertsOnForeignOperator() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.operator = relayer;
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.InvalidOperator.selector, relayer));
        op.fund(pi, params, "");
    }

    function test_fund_revertsOnWrongMinFee() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.minFeeBps = 0;
        vm.expectRevert(
            abi.encodeWithSelector(SidequestOperator.InvalidFeeTerms.selector, uint16(0), FEE_BPS, treasury)
        );
        op.fund(pi, params, "");
    }

    function test_fund_revertsOnWrongMaxFee() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.maxFeeBps = 600;
        vm.expectRevert(
            abi.encodeWithSelector(SidequestOperator.InvalidFeeTerms.selector, FEE_BPS, uint16(600), treasury)
        );
        op.fund(pi, params, "");
    }

    function test_fund_revertsOnWrongFeeReceiver() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.feeReceiver = address(0);
        vm.expectRevert(
            abi.encodeWithSelector(SidequestOperator.InvalidFeeTerms.selector, FEE_BPS, FEE_BPS, address(0))
        );
        op.fund(pi, params, "");
    }

    /// @dev Every job parameter is bound by the salt: changing any one after the payer signed breaks `fund`.
    function test_fund_revertsWhenAnyParamDiffersFromSalt() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        for (uint256 field; field < 7; ++field) {
            SidequestOperator.JobParams memory tampered = _copy(params);
            if (field == 0) tampered.jobId = keccak256("other job");
            if (field == 1) tampered.termsDigest = keccak256("other terms");
            if (field == 2) tampered.deliveryDeadline -= 1;
            if (field == 3) tampered.reviewWindow += 1;
            if (field == 4) tampered.disputeWindow += 1;
            if (field == 5) tampered.arbitrationWindow -= 1;
            if (field == 6) tampered.arbitrator = stranger;
            vm.expectRevert(
                abi.encodeWithSelector(SidequestOperator.SaltMismatch.selector, pi.salt, op.jobSalt(tampered))
            );
            op.fund(pi, tampered, "");
        }
    }

    function test_jobSalt_isTheEip712StructHash() public {
        SidequestOperator.JobParams memory p = _params();
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "JobParams(bytes32 jobId,bytes32 termsDigest,uint48 deliveryDeadline,uint32 reviewWindow,uint32 disputeWindow,uint32 arbitrationWindow,address arbitrator)"
                ),
                p.jobId,
                p.termsDigest,
                uint256(p.deliveryDeadline),
                uint256(p.reviewWindow),
                uint256(p.disputeWindow),
                uint256(p.arbitrationWindow),
                p.arbitrator
            )
        );
        assertEq(op.jobSalt(p), uint256(expected));
    }

    function test_fund_revertsOnZeroPayer() public {
        _expectInvalidParty(0);
    }

    function test_fund_revertsOnZeroReceiver() public {
        _expectInvalidParty(1);
    }

    function test_fund_revertsOnZeroToken() public {
        _expectInvalidParty(2);
    }

    function test_fund_revertsOnZeroArbitrator() public {
        _expectInvalidParty(3);
    }

    function test_fund_revertsWhenArbitratorIsPayer() public {
        _expectInvalidParty(4);
    }

    function test_fund_revertsWhenArbitratorIsReceiver() public {
        _expectInvalidParty(5);
    }

    function test_fund_windowBounds() public {
        uint32[6] memory bounds = [uint32(1 hours), 14 days, 1 hours, 14 days, 12 hours, 14 days];
        for (uint256 w; w < 3; ++w) {
            uint32 min = bounds[2 * w];
            uint32 max = bounds[2 * w + 1];
            _expectWindowRevert(w, min - 1, min, max);
            _expectWindowRevert(w, max + 1, min, max);
            _fundWithWindow(w, min);
            _fundWithWindow(w, max);
        }
    }

    function test_fund_revertsWhenDeliveryDeadlineIsNow() public {
        SidequestOperator.JobParams memory params = _params();
        params.deliveryDeadline = uint48(vm.getBlockTimestamp());
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(SidequestOperator.DeliveryDeadlineInPast.selector, params.deliveryDeadline)
        );
        op.fund(pi, params, "");
    }

    function test_fund_acceptsDeliveryDeadlineOneSecondAhead() public {
        SidequestOperator.JobParams memory params = _params();
        params.deliveryDeadline = uint48(vm.getBlockTimestamp() + 1);
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.preApprovalExpiry = params.deliveryDeadline;
        _fund(pi, params);
    }

    function test_fund_revertsWhenAuthorizationExpiryOneSecondShort() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        uint256 required = pi.authorizationExpiry;
        pi.authorizationExpiry -= 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.AuthorizationExpiryTooEarly.selector, pi.authorizationExpiry, required
            )
        );
        op.fund(pi, params, "");
    }

    function test_fund_acceptsLaterAuthorizationExpiry() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.authorizationExpiry += 30 days;
        pi.refundExpiry = pi.authorizationExpiry;
        _fund(pi, params);
    }

    function test_fund_revertsWhenFundedTwice() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash) =
            _fundDefault();
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                hash,
                SidequestOperator.Status.Funded,
                SidequestOperator.Status.None
            )
        );
        op.fund(pi, params, "");
    }

    function test_fund_revertsOnSignatureByAnotherKey() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        token.mint(payer, DEFAULT_AMOUNT);
        bytes memory sig = _signReceive(strangerPk, address(token), pi);
        vm.expectRevert("MockERC3009: invalid signature");
        op.fund(pi, params, sig);
    }

    /// @dev The payer signed one payment; a relayer cannot redirect it to another receiver.
    function test_fund_revertsWhenReceiverSwappedAfterSigning() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        token.mint(payer, DEFAULT_AMOUNT);
        bytes memory sig = _signReceive(payerPk, address(token), pi);
        pi.receiver = stranger;
        vm.expectRevert("MockERC3009: invalid signature");
        op.fund(pi, params, sig);
    }

    function test_fund_revertsOnZeroAmount() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, 0);
        vm.expectRevert(AuthCaptureEscrow.ZeroAmount.selector);
        op.fund(pi, params, "");
    }

    function test_fund_revertsAfterPreApprovalExpiry() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        token.mint(payer, DEFAULT_AMOUNT);
        bytes memory sig = _signReceive(payerPk, address(token), pi);
        vm.warp(pi.preApprovalExpiry);
        vm.expectRevert(
            abi.encodeWithSelector(
                AuthCaptureEscrow.AfterPreApprovalExpiry.selector, pi.preApprovalExpiry, pi.preApprovalExpiry
            )
        );
        op.fund(pi, params, sig);
    }

    function _copy(SidequestOperator.JobParams memory p) internal pure returns (SidequestOperator.JobParams memory) {
        return SidequestOperator.JobParams(
            p.jobId,
            p.termsDigest,
            p.deliveryDeadline,
            p.reviewWindow,
            p.disputeWindow,
            p.arbitrationWindow,
            p.arbitrator
        );
    }

    function _expectInvalidParty(uint256 which) internal {
        SidequestOperator.JobParams memory params = _params();
        if (which == 3) params.arbitrator = address(0);
        if (which == 4) params.arbitrator = payer;
        if (which == 5) params.arbitrator = receiver;
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        if (which == 0) pi.payer = address(0);
        if (which == 1) pi.receiver = address(0);
        if (which == 2) pi.token = address(0);
        vm.expectRevert(SidequestOperator.InvalidParty.selector);
        op.fund(pi, params, "");
    }

    function _withWindow(uint256 which, uint32 value) internal returns (SidequestOperator.JobParams memory params) {
        params = _params();
        if (which == 0) params.reviewWindow = value;
        if (which == 1) params.disputeWindow = value;
        if (which == 2) params.arbitrationWindow = value;
    }

    function _expectWindowRevert(uint256 which, uint32 value, uint32 min, uint32 max) internal {
        SidequestOperator.JobParams memory params = _withWindow(which, value);
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.InvalidWindow.selector, value, min, max));
        op.fund(pi, params, "");
    }

    function _fundWithWindow(uint256 which, uint32 value) internal {
        SidequestOperator.JobParams memory params = _withWindow(which, value);
        bytes32 hash = _fund(_paymentInfo(params, DEFAULT_AMOUNT), params);
        assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Funded));
    }
}

contract DeliverTest is OperatorTestBase {
    bytes32 internal constant ARTEFACT = keccak256("artefact");

    function test_deliver_byReceiver() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash) =
            _fundDefault();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectEmit(address(op));
        emit SidequestOperator.JobDelivered(
            hash, params.termsDigest, ARTEFACT, uint48(vm.getBlockTimestamp()), uint48(vm.getBlockTimestamp() + REVIEW)
        );
        vm.prank(receiver);
        op.deliver(pi, ARTEFACT, "");

        SidequestOperator.Job memory job = op.getJob(hash);
        assertEq(uint8(job.status), uint8(SidequestOperator.Status.Delivered));
        assertEq(job.deliveredAt, vm.getBlockTimestamp());
        assertEq(job.deliveryHash, ARTEFACT);
        assertEq(_capturable(hash), DEFAULT_AMOUNT, "delivery moves no funds");
    }

    function test_deliver_relayedWithReceiverSignature() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDefault();
        bytes memory sig = _signDelivery(receiverPk, hash, ARTEFACT);
        vm.prank(relayer);
        op.deliver(pi, ARTEFACT, sig);
        assertEq(op.getJob(hash).deliveryHash, ARTEFACT);
    }

    function test_deliver_relayedWithSmartWalletReceiverSignature() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(receiver);
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.receiver = address(wallet);
        bytes32 hash = _fund(pi, params);
        bytes memory sig = _signDelivery(receiverPk, hash, ARTEFACT);
        vm.prank(relayer);
        op.deliver(pi, ARTEFACT, sig);
        assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Delivered));
    }

    function test_deliver_revertsOnSmartWalletReceiverWithWrongOwnerKey() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(receiver);
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.receiver = address(wallet);
        bytes32 hash = _fund(pi, params);
        bytes memory sig = _signDelivery(strangerPk, hash, ARTEFACT);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, address(wallet)));
        op.deliver(pi, ARTEFACT, sig);
    }

    function test_deliver_atLastSecondBeforeDeadline() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params,) = _fundDefault();
        vm.warp(params.deliveryDeadline - 1);
        _deliver(pi);
    }

    function test_deliver_revertsAtDeadline() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params,) = _fundDefault();
        vm.warp(params.deliveryDeadline);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.DeadlinePassed.selector, params.deliveryDeadline, params.deliveryDeadline
            )
        );
        vm.prank(receiver);
        op.deliver(pi, ARTEFACT, "");
    }

    function test_deliver_revertsOnZeroHash() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,,) = _fundDefault();
        vm.expectRevert(SidequestOperator.ZeroDeliveryHash.selector);
        vm.prank(receiver);
        op.deliver(pi, bytes32(0), "");
    }

    function test_deliver_revertsForStrangerWithoutSignature() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,,) = _fundDefault();
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, receiver));
        vm.prank(stranger);
        op.deliver(pi, ARTEFACT, "");
    }

    function test_deliver_revertsForPayer() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,,) = _fundDefault();
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, receiver));
        vm.prank(payer);
        op.deliver(pi, ARTEFACT, "");
    }

    function test_deliver_revertsOnWrongSigner() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDefault();
        bytes memory sig = _signDelivery(strangerPk, hash, ARTEFACT);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, receiver));
        op.deliver(pi, ARTEFACT, sig);
    }

    function test_deliver_revertsWhenSignatureIsForAnotherHash() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDefault();
        bytes memory sig = _signDelivery(receiverPk, hash, keccak256("something else"));
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, receiver));
        op.deliver(pi, ARTEFACT, sig);
    }

    function test_deliver_revertsOnSignatureFromAnotherJob() public {
        (,, bytes32 hashA) = _fundDefault();
        (AuthCaptureEscrow.PaymentInfo memory piB,,) = _fundDefault();
        bytes memory sigForA = _signDelivery(receiverPk, hashA, ARTEFACT);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, receiver));
        op.deliver(piB, ARTEFACT, sigForA);
    }

    /// @dev A signature for the same job hash under another operator deployment (another EIP-712 domain) is useless.
    function test_deliver_revertsOnSignatureForAnotherOperatorDomain() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDefault();
        SidequestOperator other = new SidequestOperator(address(escrow), address(collector), FEE_BPS, treasury);
        bytes memory sig = _sign(receiverPk, other.deliveryDigest(hash, ARTEFACT));
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, receiver));
        op.deliver(pi, ARTEFACT, sig);
    }

    function test_deliver_revertsOnReplay() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDefault();
        bytes memory sig = _signDelivery(receiverPk, hash, ARTEFACT);
        op.deliver(pi, ARTEFACT, sig);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                hash,
                SidequestOperator.Status.Delivered,
                SidequestOperator.Status.Funded
            )
        );
        op.deliver(pi, ARTEFACT, sig);
    }

    function test_deliver_revertsOnUnknownJob() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                escrow.getHash(pi),
                SidequestOperator.Status.None,
                SidequestOperator.Status.Funded
            )
        );
        vm.prank(receiver);
        op.deliver(pi, ARTEFACT, "");
    }

    /// @dev A job can only be addressed with its exact payment: any altered field yields an unknown hash.
    function test_deliver_revertsOnAlteredPaymentInfo() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,,) = _fundDefault();
        pi.maxAmount += 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                escrow.getHash(pi),
                SidequestOperator.Status.None,
                SidequestOperator.Status.Funded
            )
        );
        vm.prank(receiver);
        op.deliver(pi, ARTEFACT, "");
    }
}

contract ReviewTest is OperatorTestBase {
    function test_approve_byPayerCapturesFullAmountLessFee() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash) =
            _fundAndDeliver();
        (uint256 toReceiver, uint256 fee,) = _split(DEFAULT_AMOUNT, 10_000);
        vm.expectEmit(address(op));
        emit SidequestOperator.JobSettled(
            hash,
            params.termsDigest,
            SidequestOperator.Outcome.Approved,
            10_000,
            DEFAULT_AMOUNT,
            fee,
            0,
            uint48(vm.getBlockTimestamp())
        );
        vm.prank(payer);
        op.approve(pi, "");

        assertEq(token.balanceOf(receiver), toReceiver);
        assertEq(token.balanceOf(receiver), 950e6);
        assertEq(token.balanceOf(treasury), 50e6);
        assertEq(token.balanceOf(payer), 0);
        assertEq(_capturable(hash), 0);
        SidequestOperator.Job memory job = op.getJob(hash);
        assertEq(uint8(job.status), uint8(SidequestOperator.Status.Settled));
        assertEq(uint8(job.outcome), uint8(SidequestOperator.Outcome.Approved));
    }

    function test_approve_relayedWithPayerSignature() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundAndDeliver();
        bytes memory sig = _signApproval(payerPk, hash);
        vm.prank(relayer);
        op.approve(pi, sig);
        assertEq(token.balanceOf(receiver), 950e6);
    }

    function test_approve_relayedWithSmartWalletPayerSignature() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(payer);
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.payer = address(wallet);
        bytes32 hash = _fund(pi, params);
        _deliver(pi);
        bytes memory sig = _signApproval(payerPk, hash);
        vm.prank(relayer);
        op.approve(pi, sig);
        assertEq(token.balanceOf(receiver), 950e6);
    }

    function test_approve_afterReviewWindowStillWorks() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,,) = _fundAndDeliver();
        vm.warp(vm.getBlockTimestamp() + REVIEW + 1 days);
        vm.prank(payer);
        op.approve(pi, "");
        assertEq(token.balanceOf(receiver), 950e6);
    }

    function test_approve_revertsBeforeDelivery() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDefault();
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                hash,
                SidequestOperator.Status.Funded,
                SidequestOperator.Status.Delivered
            )
        );
        vm.prank(payer);
        op.approve(pi, "");
    }

    function test_approve_revertsForReceiver() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,,) = _fundAndDeliver();
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, payer));
        vm.prank(receiver);
        op.approve(pi, "");
    }

    /// @dev Approvals and rejections name the delivery: one signed for another artefact (or before delivery) fails.
    function test_approveAndReject_revertForAnotherDeliveryHash() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundAndDeliver();
        bytes memory approval = _sign(payerPk, op.approvalDigest(hash, keccak256("not the artefact")));
        bytes memory rejection = _sign(payerPk, op.rejectionDigest(hash, bytes32(0)));
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, payer));
        op.approve(pi, approval);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, payer));
        op.reject(pi, rejection);
    }

    function test_approve_revertsOnWrongSigner() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundAndDeliver();
        bytes memory sig = _signApproval(receiverPk, hash);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, payer));
        op.approve(pi, sig);
    }

    /// @dev An approval signature cannot be replayed as a rejection (different EIP-712 type), and vice versa.
    function test_approve_revertsOnRejectionSignature() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundAndDeliver();
        bytes memory rejection = _signRejection(payerPk, hash);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, payer));
        op.approve(pi, rejection);
        bytes memory approval = _signApproval(payerPk, hash);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, payer));
        op.reject(pi, approval);
    }

    function test_approve_revertsOnReplay() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundAndDeliver();
        bytes memory sig = _signApproval(payerPk, hash);
        op.approve(pi, sig);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                hash,
                SidequestOperator.Status.Settled,
                SidequestOperator.Status.Delivered
            )
        );
        op.approve(pi, sig);
    }

    function test_approve_revertsAfterAuthorizationExpiry() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,,) = _fundAndDeliver();
        vm.warp(pi.authorizationExpiry);
        vm.expectRevert(
            abi.encodeWithSelector(
                AuthCaptureEscrow.AfterAuthorizationExpiry.selector, pi.authorizationExpiry, pi.authorizationExpiry
            )
        );
        vm.prank(payer);
        op.approve(pi, "");
    }

    function test_settleAfterReview_atReviewDeadline() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash) =
            _fundAndDeliver();
        vm.warp(vm.getBlockTimestamp() + REVIEW);
        vm.expectEmit(address(op));
        emit SidequestOperator.JobSettled(
            hash,
            params.termsDigest,
            SidequestOperator.Outcome.AcceptedBySilence,
            10_000,
            DEFAULT_AMOUNT,
            50e6,
            0,
            uint48(vm.getBlockTimestamp())
        );
        vm.prank(stranger);
        op.settleAfterReview(pi);
        assertEq(token.balanceOf(receiver), 950e6);
        assertEq(token.balanceOf(treasury), 50e6);
        assertEq(uint8(op.getJob(hash).outcome), uint8(SidequestOperator.Outcome.AcceptedBySilence));
    }

    function test_settleAfterReview_revertsOneSecondEarly() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,,) = _fundAndDeliver();
        uint256 reviewDeadline = vm.getBlockTimestamp() + REVIEW;
        vm.warp(reviewDeadline - 1);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.TooEarly.selector, reviewDeadline - 1, reviewDeadline));
        op.settleAfterReview(pi);
    }

    function test_settleAfterReview_revertsWhenRejected() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDeliverReject();
        vm.warp(vm.getBlockTimestamp() + REVIEW);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                hash,
                SidequestOperator.Status.Disputed,
                SidequestOperator.Status.Delivered
            )
        );
        op.settleAfterReview(pi);
    }

    /// @dev Liveness: if nobody settles before `authorizationExpiry`, the escrow lets the payer reclaim instead.
    function test_settleAfterReview_revertsAfterAuthorizationExpiryAndPayerReclaims() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundAndDeliver();
        vm.warp(pi.authorizationExpiry);
        vm.expectRevert(
            abi.encodeWithSelector(
                AuthCaptureEscrow.AfterAuthorizationExpiry.selector, pi.authorizationExpiry, pi.authorizationExpiry
            )
        );
        op.settleAfterReview(pi);
        vm.prank(payer);
        escrow.reclaim(pi);
        assertEq(token.balanceOf(payer), DEFAULT_AMOUNT);
        assertEq(_capturable(hash), 0);
    }

    function test_reject_byPayerOpensDispute() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash) =
            _fundAndDeliver();
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.expectEmit(address(op));
        emit SidequestOperator.JobRejected(
            hash,
            params.termsDigest,
            uint48(vm.getBlockTimestamp()),
            uint48(vm.getBlockTimestamp() + DISPUTE + ARBITRATION)
        );
        vm.prank(payer);
        op.reject(pi, "");
        SidequestOperator.Job memory job = op.getJob(hash);
        assertEq(uint8(job.status), uint8(SidequestOperator.Status.Disputed));
        assertEq(job.rejectedAt, vm.getBlockTimestamp());
        assertEq(_capturable(hash), DEFAULT_AMOUNT, "rejection moves no funds");
    }

    function test_reject_relayedWithPayerSignature() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundAndDeliver();
        bytes memory sig = _signRejection(payerPk, hash);
        vm.prank(relayer);
        op.reject(pi, sig);
        assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Disputed));
    }

    function test_reject_relayedWithSmartWalletPayerSignature() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(payer);
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.payer = address(wallet);
        bytes32 hash = _fund(pi, params);
        _deliver(pi);
        bytes memory sig = _signRejection(payerPk, hash);
        op.reject(pi, sig);
        assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Disputed));
    }

    function test_reject_atLastSecondOfReview() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundAndDeliver();
        vm.warp(vm.getBlockTimestamp() + REVIEW - 1);
        vm.prank(payer);
        op.reject(pi, "");
        assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Disputed));
    }

    function test_reject_revertsAtReviewDeadline() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,,) = _fundAndDeliver();
        uint256 reviewDeadline = vm.getBlockTimestamp() + REVIEW;
        vm.warp(reviewDeadline);
        vm.expectRevert(
            abi.encodeWithSelector(SidequestOperator.DeadlinePassed.selector, reviewDeadline, reviewDeadline)
        );
        vm.prank(payer);
        op.reject(pi, "");
    }

    function test_reject_revertsBeforeDelivery() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDefault();
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                hash,
                SidequestOperator.Status.Funded,
                SidequestOperator.Status.Delivered
            )
        );
        vm.prank(payer);
        op.reject(pi, "");
    }

    function test_reject_revertsOnWrongSigner() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundAndDeliver();
        bytes memory sig = _signRejection(arbitratorPk, hash);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, payer));
        op.reject(pi, sig);
    }

    function test_reject_revertsOnReplay() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundAndDeliver();
        bytes memory sig = _signRejection(payerPk, hash);
        op.reject(pi, sig);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                hash,
                SidequestOperator.Status.Disputed,
                SidequestOperator.Status.Delivered
            )
        );
        op.reject(pi, sig);
    }

    /// @dev A rejection cannot be followed by an approval: the dispute is the arbitrator's to settle.
    function test_approve_revertsWhenDisputed() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDeliverReject();
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                hash,
                SidequestOperator.Status.Disputed,
                SidequestOperator.Status.Delivered
            )
        );
        vm.prank(payer);
        op.approve(pi, "");
    }
}

contract DisputeTest is OperatorTestBase {
    function test_rule_fullToWorker() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDeliverReject();
        _ruleAndCheck(pi, hash, 10_000);
        assertEq(token.balanceOf(receiver), 950e6);
        assertEq(token.balanceOf(payer), 0);
    }

    function test_rule_fullRefund() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDeliverReject();
        _ruleAndCheck(pi, hash, 0);
        assertEq(token.balanceOf(receiver), 0);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(token.balanceOf(payer), DEFAULT_AMOUNT);
    }

    function test_rule_evenSplit() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDeliverReject();
        _ruleAndCheck(pi, hash, 5000);
        assertEq(token.balanceOf(receiver), 475e6);
        assertEq(token.balanceOf(treasury), 25e6);
        assertEq(token.balanceOf(payer), 500e6);
    }

    /// @dev 3333 bps of 1 000 000 007 units: captured 333 300 002 (floor), fee 16 665 000 (floor), dust to payer.
    function test_rule_oddShareRoundsDownForWorker() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, 1_000_000_007);
        bytes32 hash = _fund(pi, params);
        _deliver(pi);
        vm.prank(payer);
        op.reject(pi, "");
        _ruleAndCheck(pi, hash, 3333);
        assertEq(token.balanceOf(treasury), 16_665_000);
        assertEq(token.balanceOf(receiver), 333_300_002 - 16_665_000);
        assertEq(token.balanceOf(payer), 1_000_000_007 - 333_300_002);
    }

    /// @dev A share so small it rounds to zero captures nothing and voids everything.
    function test_rule_tinyShareOfTinyAmountVoidsAll() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, 3);
        bytes32 hash = _fund(pi, params);
        _deliver(pi);
        vm.prank(payer);
        op.reject(pi, "");
        _ruleAndCheck(pi, hash, 1);
        assertEq(token.balanceOf(payer), 3);
    }

    /// @dev A captured amount below 20 units pays no fee at 5 %: the fee rounds down, as the escrow's bounds do.
    function test_rule_feeRoundsToZeroOnDust() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, 30);
        bytes32 hash = _fund(pi, params);
        _deliver(pi);
        vm.prank(payer);
        op.reject(pi, "");
        _ruleAndCheck(pi, hash, 5000);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(token.balanceOf(receiver), 15);
        assertEq(token.balanceOf(payer), 15);
    }

    function test_rule_relayedWithArbitratorSignature() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDeliverReject();
        bytes memory sig = _signRuling(arbitratorPk, hash, 7000);
        vm.prank(relayer);
        op.rule(pi, 7000, sig);
        assertEq(uint8(op.getJob(hash).outcome), uint8(SidequestOperator.Outcome.Ruled));
        assertEq(token.balanceOf(payer), 300e6);
    }

    function test_rule_relayedWithSmartWalletArbitratorSignature() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(arbitrator);
        SidequestOperator.JobParams memory params = _params();
        params.arbitrator = address(wallet);
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        bytes32 hash = _fund(pi, params);
        _deliver(pi);
        vm.prank(payer);
        op.reject(pi, "");
        bytes memory sig = _signRuling(arbitratorPk, hash, 2500);
        op.rule(pi, 2500, sig);
        assertEq(token.balanceOf(payer), 750e6);
    }

    function test_rule_revertsOnWrongSigner() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDeliverReject();
        bytes memory sig = _signRuling(payerPk, hash, 0);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, arbitrator));
        op.rule(pi, 0, sig);
    }

    function test_rule_revertsWhenPayerCallsDirectly() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,,) = _fundDeliverReject();
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, arbitrator));
        vm.prank(payer);
        op.rule(pi, 0, "");
    }

    /// @dev A relayer cannot change the share the arbitrator signed.
    function test_rule_revertsWhenShareDiffersFromSigned() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDeliverReject();
        bytes memory sig = _signRuling(arbitratorPk, hash, 2000);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, arbitrator));
        op.rule(pi, 2001, sig);
    }

    function test_rule_revertsOnShareAbove10000() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,,) = _fundDeliverReject();
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.InvalidWorkerShare.selector, uint16(10_001)));
        vm.prank(arbitrator);
        op.rule(pi, 10_001, "");
    }

    function test_rule_revertsWhenNotDisputed() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundAndDeliver();
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                hash,
                SidequestOperator.Status.Delivered,
                SidequestOperator.Status.Disputed
            )
        );
        vm.prank(arbitrator);
        op.rule(pi, 5000, "");
    }

    function test_rule_atLastSecondBeforeArbitrationDeadline() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDeliverReject();
        vm.warp(vm.getBlockTimestamp() + DISPUTE + ARBITRATION - 1);
        _ruleAndCheck(pi, hash, 5000);
    }

    /// @dev The arbitrator may rule during the dispute window already.
    function test_rule_immediatelyAfterRejection() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDeliverReject();
        _ruleAndCheck(pi, hash, 6000);
    }

    function test_rule_revertsAtArbitrationDeadline() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,,) = _fundDeliverReject();
        uint256 deadline = vm.getBlockTimestamp() + DISPUTE + ARBITRATION;
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.DeadlinePassed.selector, deadline, deadline));
        vm.prank(arbitrator);
        op.rule(pi, 5000, "");
    }

    function test_rule_revertsOnReplay() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDeliverReject();
        bytes memory sig = _signRuling(arbitratorPk, hash, 5000);
        op.rule(pi, 5000, sig);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                hash,
                SidequestOperator.Status.Settled,
                SidequestOperator.Status.Disputed
            )
        );
        op.rule(pi, 5000, sig);
    }

    /// @dev Equivocation: two different signed rulings exist; whichever lands first is final, the other is dead.
    function test_rule_secondConflictingRulingIsDead() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDeliverReject();
        bytes memory forWorker = _signRuling(arbitratorPk, hash, 10_000);
        bytes memory forPayer = _signRuling(arbitratorPk, hash, 0);
        op.rule(pi, 0, forPayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                hash,
                SidequestOperator.Status.Settled,
                SidequestOperator.Status.Disputed
            )
        );
        op.rule(pi, 10_000, forWorker);
        assertEq(token.balanceOf(payer), DEFAULT_AMOUNT);
    }

    function test_settleUnruled_refundsPayerAtDeadline() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash) =
            _fundDeliverReject();
        vm.warp(vm.getBlockTimestamp() + DISPUTE + ARBITRATION);
        vm.expectEmit(address(op));
        emit SidequestOperator.JobSettled(
            hash,
            params.termsDigest,
            SidequestOperator.Outcome.Unruled,
            0,
            0,
            0,
            DEFAULT_AMOUNT,
            uint48(vm.getBlockTimestamp())
        );
        vm.prank(stranger);
        op.settleUnruled(pi);
        assertEq(token.balanceOf(payer), DEFAULT_AMOUNT);
        assertEq(token.balanceOf(receiver), 0);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(uint8(op.getJob(hash).outcome), uint8(SidequestOperator.Outcome.Unruled));
    }

    function test_settleUnruled_revertsOneSecondEarly() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,,) = _fundDeliverReject();
        uint256 deadline = vm.getBlockTimestamp() + DISPUTE + ARBITRATION;
        vm.warp(deadline - 1);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.TooEarly.selector, deadline - 1, deadline));
        op.settleUnruled(pi);
    }

    function test_settleUnruled_revertsWhenNotDisputed() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundAndDeliver();
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                hash,
                SidequestOperator.Status.Delivered,
                SidequestOperator.Status.Disputed
            )
        );
        op.settleUnruled(pi);
    }

    /// @dev `void` has no expiry, so the unruled refund still works after `authorizationExpiry` (unless the payer
    ///      already reclaimed, which pays the payer the same).
    function test_settleUnruled_worksAfterAuthorizationExpiry() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,,) = _fundDeliverReject();
        vm.warp(pi.authorizationExpiry + 1);
        op.settleUnruled(pi);
        assertEq(token.balanceOf(payer), DEFAULT_AMOUNT);
    }

    function _ruleAndCheck(AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash, uint16 bps) internal {
        uint256 amount = pi.maxAmount;
        (uint256 toReceiver, uint256 fee, uint256 refunded) = _split(amount, bps);
        uint256 payerBefore = token.balanceOf(payer);
        vm.expectEmit(address(op));
        emit SidequestOperator.JobSettled(
            hash,
            op.getJob(hash).termsDigest,
            SidequestOperator.Outcome.Ruled,
            bps,
            toReceiver + fee,
            fee,
            refunded,
            uint48(vm.getBlockTimestamp())
        );
        vm.prank(arbitrator);
        op.rule(pi, bps, "");
        assertEq(token.balanceOf(receiver), toReceiver, "receiver");
        assertEq(token.balanceOf(treasury), fee, "treasury");
        assertEq(token.balanceOf(payer) - payerBefore, refunded, "payer");
        assertEq(_capturable(hash), 0, "nothing left in escrow");
        assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Settled));
    }
}

contract UndeliveredTest is OperatorTestBase {
    function test_refundUndelivered_atDeadline() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash) =
            _fundDefault();
        vm.warp(params.deliveryDeadline);
        vm.expectEmit(address(op));
        emit SidequestOperator.JobSettled(
            hash,
            params.termsDigest,
            SidequestOperator.Outcome.Undelivered,
            0,
            0,
            0,
            DEFAULT_AMOUNT,
            uint48(vm.getBlockTimestamp())
        );
        vm.prank(stranger);
        op.refundUndelivered(pi);
        assertEq(token.balanceOf(payer), DEFAULT_AMOUNT);
        assertEq(_capturable(hash), 0);
        assertEq(uint8(op.getJob(hash).outcome), uint8(SidequestOperator.Outcome.Undelivered));
    }

    function test_refundUndelivered_revertsOneSecondEarly() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params,) = _fundDefault();
        vm.warp(params.deliveryDeadline - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.TooEarly.selector, params.deliveryDeadline - 1, params.deliveryDeadline
            )
        );
        op.refundUndelivered(pi);
    }

    function test_refundUndelivered_revertsAfterDelivery() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash) =
            _fundAndDeliver();
        vm.warp(params.deliveryDeadline);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                hash,
                SidequestOperator.Status.Delivered,
                SidequestOperator.Status.Funded
            )
        );
        op.refundUndelivered(pi);
    }

    function test_refundUndelivered_revertsTwice() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash) =
            _fundDefault();
        vm.warp(params.deliveryDeadline);
        op.refundUndelivered(pi);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.InvalidStatus.selector,
                hash,
                SidequestOperator.Status.Settled,
                SidequestOperator.Status.Funded
            )
        );
        op.refundUndelivered(pi);
    }

    /// @dev After a void nothing can be captured, and a late delivery is refused.
    function test_nothingAfterVoid() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash) =
            _fundDefault();
        vm.warp(params.deliveryDeadline);
        op.refundUndelivered(pi);
        bytes4 invalid = SidequestOperator.InvalidStatus.selector;
        vm.expectRevert(
            abi.encodeWithSelector(invalid, hash, SidequestOperator.Status.Settled, SidequestOperator.Status.Funded)
        );
        vm.prank(receiver);
        op.deliver(pi, keccak256("late"), "");
        vm.expectRevert(
            abi.encodeWithSelector(invalid, hash, SidequestOperator.Status.Settled, SidequestOperator.Status.Delivered)
        );
        op.settleAfterReview(pi);
        vm.expectRevert(
            abi.encodeWithSelector(invalid, hash, SidequestOperator.Status.Settled, SidequestOperator.Status.Disputed)
        );
        vm.prank(arbitrator);
        op.rule(pi, 10_000, "");
    }
}

/// @dev The escrow's `reclaim` (payer, from `authorizationExpiry`) can never pre-empt a job still inside its windows.
contract ReclaimTest is OperatorTestBase {
    /// @dev Worst case: delivery at the last second, rejection at the last second of review, ruling at the last
    ///      second of arbitration. Reclaim is refused at every step, and the ruling still captures.
    function test_reclaimCannotPreemptTheLatestPossibleRuling() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash) =
            _fundDefault();

        vm.warp(params.deliveryDeadline - 1);
        _expectReclaimRefused(pi);
        _deliver(pi);

        vm.warp(vm.getBlockTimestamp() + REVIEW - 1);
        _expectReclaimRefused(pi);
        vm.prank(payer);
        op.reject(pi, "");

        vm.warp(vm.getBlockTimestamp() + DISPUTE + ARBITRATION - 1);
        _expectReclaimRefused(pi);
        assertLe(vm.getBlockTimestamp() + op.MARGIN(), pi.authorizationExpiry, "margin left before expiry");
        vm.prank(arbitrator);
        op.rule(pi, 10_000, "");
        assertEq(token.balanceOf(receiver), 950e6);
        assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Settled));
    }

    /// @dev Worst case for silence: the first moment `settleAfterReview` is possible is MARGIN + dispute + arbitration
    ///      before the payer could reclaim.
    function test_reclaimCannotPreemptSettlementAfterReview() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params,) = _fundDefault();
        vm.warp(params.deliveryDeadline - 1);
        _deliver(pi);
        vm.warp(vm.getBlockTimestamp() + REVIEW);
        _expectReclaimRefused(pi);
        assertGe(pi.authorizationExpiry - vm.getBlockTimestamp(), DISPUTE + ARBITRATION + op.MARGIN());
        op.settleAfterReview(pi);
        assertEq(token.balanceOf(receiver), 950e6);
    }

    function _expectReclaimRefused(AuthCaptureEscrow.PaymentInfo memory pi) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                AuthCaptureEscrow.BeforeAuthorizationExpiry.selector,
                uint48(vm.getBlockTimestamp()),
                pi.authorizationExpiry
            )
        );
        vm.prank(payer);
        escrow.reclaim(pi);
    }
}

contract DigestTest is OperatorTestBase {
    function test_digests_matchEip712() public view {
        bytes32 hash = keccak256("payment");
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SidequestOperator"),
                keccak256("1"),
                block.chainid,
                address(op)
            )
        );
        assertEq(
            op.deliveryDigest(hash, bytes32(uint256(7))),
            _typed(domain, keccak256(abi.encode(op.DELIVERY_TYPEHASH(), hash, bytes32(uint256(7)))))
        );
        assertEq(
            op.approvalDigest(hash, bytes32(uint256(7))),
            _typed(domain, keccak256(abi.encode(op.APPROVAL_TYPEHASH(), hash, bytes32(uint256(7)))))
        );
        assertEq(
            op.rejectionDigest(hash, bytes32(uint256(7))),
            _typed(domain, keccak256(abi.encode(op.REJECTION_TYPEHASH(), hash, bytes32(uint256(7)))))
        );
        assertEq(
            op.rulingDigest(hash, 4321),
            _typed(domain, keccak256(abi.encode(op.RULING_TYPEHASH(), hash, uint256(4321))))
        );
        assertEq(op.DELIVERY_TYPEHASH(), keccak256("Delivery(bytes32 paymentInfoHash,bytes32 deliveryHash)"));
        assertEq(op.APPROVAL_TYPEHASH(), keccak256("Approval(bytes32 paymentInfoHash,bytes32 deliveryHash)"));
        assertEq(op.REJECTION_TYPEHASH(), keccak256("Rejection(bytes32 paymentInfoHash,bytes32 deliveryHash)"));
        assertEq(op.RULING_TYPEHASH(), keccak256("Ruling(bytes32 paymentInfoHash,uint16 workerShareBps)"));
    }

    /// @dev Every approval digest is bound to the chain: the same signature is worthless on a fork with another id.
    function test_digests_changeWithChainId() public {
        bytes32 hash = keccak256("payment");
        bytes32 before = op.approvalDigest(hash, hash);
        vm.chainId(block.chainid + 1);
        assertTrue(op.approvalDigest(hash, hash) != before);
    }

    function _typed(bytes32 domain, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }
}
