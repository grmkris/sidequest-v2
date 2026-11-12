// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuthCaptureEscrow} from "commerce-payments/src/AuthCaptureEscrow.sol";

import {SidequestOperator} from "../src/SidequestOperator.sol";
import {OperatorTestBase} from "./utils/OperatorTestBase.sol";

contract SidequestOperatorFuzzTest is OperatorTestBase {
    /// @dev Any amount and any share: the escrow accepts the split, money is conserved, and only the three parties
    ///      receive anything.
    function testFuzz_rule_conservesAndSplits(uint256 amount, uint16 bps, uint256 ruleDelay) public {
        amount = bound(amount, 1, type(uint120).max);
        bps = uint16(bound(bps, 0, 10_000));
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash) = _fundAmount(amount);
        _deliver(pi);
        vm.prank(payer);
        op.reject(pi, "");
        vm.warp(vm.getBlockTimestamp() + bound(ruleDelay, 0, DISPUTE + ARBITRATION - 1));

        bytes memory sig = _signRuling(arbitratorPk, hash, bps);
        vm.prank(relayer);
        op.rule(pi, bps, sig);

        (uint256 toReceiver, uint256 fee, uint256 refunded) = _split(amount, bps);
        assertEq(token.balanceOf(receiver), toReceiver);
        assertEq(token.balanceOf(treasury), fee);
        assertEq(token.balanceOf(payer), refunded);
        assertEq(toReceiver + fee + refunded, amount);
        assertEq(token.balanceOf(escrow.getTokenStore(address(op))), 0);
        assertEq(token.balanceOf(address(op)), 0);
        assertEq(token.balanceOf(relayer), 0);
        assertLe(fee, (amount * bps / 10_000) * FEE_BPS / 10_000);
        if (bps == 10_000) assertEq(refunded, 0);
        if (bps == 0) assertEq(toReceiver + fee, 0);
    }

    /// @dev Full captures pay exactly `amount - floor(amount * 5 %)` to the receiver.
    function testFuzz_approve_feeMaths(uint256 amount) public {
        amount = bound(amount, 1, type(uint120).max);
        (AuthCaptureEscrow.PaymentInfo memory pi,) = _fundAmount(amount);
        _deliver(pi);
        vm.prank(payer);
        op.approve(pi, "");
        uint256 fee = amount * FEE_BPS / 10_000;
        assertEq(token.balanceOf(treasury), fee);
        assertEq(token.balanceOf(receiver), amount - fee);
        assertEq(token.balanceOf(payer), 0);
    }

    /// @dev Exactly one of `reject` and `settleAfterReview` is possible at any moment after delivery.
    function testFuzz_reviewBoundary(uint256 elapsed) public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundAndDeliver();
        // Read from the job: the delivery time is what the contract will compare against.
        uint256 deliveredAt = op.getJob(hash).deliveredAt;
        elapsed = bound(elapsed, 0, 2 * uint256(REVIEW));
        vm.warp(deliveredAt + elapsed);
        if (elapsed < REVIEW) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    SidequestOperator.TooEarly.selector, vm.getBlockTimestamp(), deliveredAt + REVIEW
                )
            );
            op.settleAfterReview(pi);
            vm.prank(payer);
            op.reject(pi, "");
            assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Disputed));
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(
                    SidequestOperator.DeadlinePassed.selector, vm.getBlockTimestamp(), deliveredAt + REVIEW
                )
            );
            vm.prank(payer);
            op.reject(pi, "");
            op.settleAfterReview(pi);
            assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Settled));
        }
    }

    /// @dev Exactly one of `rule` and `settleUnruled` is possible at any moment of a dispute.
    function testFuzz_arbitrationBoundary(uint256 elapsed) public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDeliverReject();
        uint256 deadline = uint256(op.getJob(hash).rejectedAt) + DISPUTE + ARBITRATION;
        vm.warp(vm.getBlockTimestamp() + bound(elapsed, 0, 2 * uint256(DISPUTE + ARBITRATION)));
        if (vm.getBlockTimestamp() < deadline) {
            vm.expectRevert(
                abi.encodeWithSelector(SidequestOperator.TooEarly.selector, vm.getBlockTimestamp(), deadline)
            );
            op.settleUnruled(pi);
            vm.prank(arbitrator);
            op.rule(pi, 5000, "");
            assertEq(uint8(op.getJob(hash).outcome), uint8(SidequestOperator.Outcome.Ruled));
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(SidequestOperator.DeadlinePassed.selector, vm.getBlockTimestamp(), deadline)
            );
            vm.prank(arbitrator);
            op.rule(pi, 5000, "");
            op.settleUnruled(pi);
            assertEq(uint8(op.getJob(hash).outcome), uint8(SidequestOperator.Outcome.Unruled));
        }
    }

    /// @dev For any bounded windows and deadline, the latest possible ruling lands before the payer can reclaim, and
    ///      `fund` refuses an expiry one second shorter.
    function testFuzz_windowsNeverOutliveTheAuthorization(
        uint32 review,
        uint32 dispute,
        uint32 arbitration,
        uint256 deadlineOffset,
        uint16 bps
    ) public {
        SidequestOperator.JobParams memory params = _params();
        params.reviewWindow = uint32(bound(review, 1 hours, 14 days));
        params.disputeWindow = uint32(bound(dispute, 1 hours, 14 days));
        params.arbitrationWindow = uint32(bound(arbitration, 12 hours, 14 days));
        params.deliveryDeadline = uint48(vm.getBlockTimestamp() + bound(deadlineOffset, 1, 365 days));
        bps = uint16(bound(bps, 0, 10_000));

        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.preApprovalExpiry = params.deliveryDeadline;

        AuthCaptureEscrow.PaymentInfo memory short = _paymentInfo(params, DEFAULT_AMOUNT);
        short.preApprovalExpiry = params.deliveryDeadline;
        short.authorizationExpiry -= 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.AuthorizationExpiryTooEarly.selector,
                short.authorizationExpiry,
                uint256(pi.authorizationExpiry)
            )
        );
        op.fund(short, params, "");

        bytes32 hash = _fund(pi, params);
        vm.warp(params.deliveryDeadline - 1);
        _deliver(pi);
        vm.warp(vm.getBlockTimestamp() + params.reviewWindow - 1);
        vm.prank(payer);
        op.reject(pi, "");
        vm.warp(vm.getBlockTimestamp() + params.disputeWindow + params.arbitrationWindow - 1);
        assertLt(vm.getBlockTimestamp(), pi.authorizationExpiry);
        vm.expectRevert(
            abi.encodeWithSelector(
                AuthCaptureEscrow.BeforeAuthorizationExpiry.selector,
                uint48(vm.getBlockTimestamp()),
                pi.authorizationExpiry
            )
        );
        vm.prank(payer);
        escrow.reclaim(pi);
        vm.prank(arbitrator);
        op.rule(pi, bps, "");
        assertEq(_capturable(hash), 0);
    }

    /// @dev A signature by any key other than the named party is refused for every signed action.
    function testFuzz_foreignSignaturesAreRefused(uint256 pk) public {
        pk = bound(pk, 1, 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140);
        vm.assume(pk != payerPk && pk != receiverPk && pk != arbitratorPk);
        (AuthCaptureEscrow.PaymentInfo memory pi,, bytes32 hash) = _fundDefault();
        bytes32 artefact = keccak256("artefact");

        // Signatures are made before `expectRevert`: the digest views are external calls and would consume it.
        bytes memory forgedDelivery = _signDelivery(pk, hash, artefact);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, receiver));
        op.deliver(pi, artefact, forgedDelivery);
        op.deliver(pi, artefact, _signDelivery(receiverPk, hash, artefact));

        bytes memory approval = _signApproval(pk, hash);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, payer));
        op.approve(pi, approval);
        bytes memory rejection = _signRejection(pk, hash);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, payer));
        op.reject(pi, rejection);
        op.reject(pi, _signRejection(payerPk, hash));

        bytes memory ruling = _signRuling(pk, hash, 5000);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, arbitrator));
        op.rule(pi, 5000, ruling);
    }

    function _fundAmount(uint256 amount) internal returns (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash) {
        SidequestOperator.JobParams memory params = _params();
        pi = _paymentInfo(params, amount);
        hash = _fund(pi, params);
    }
}
