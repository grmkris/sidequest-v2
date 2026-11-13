// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuthCaptureEscrow} from "commerce-payments/src/AuthCaptureEscrow.sol";

import {SidequestOperator} from "../src/SidequestOperator.sol";
import {OperatorTestBase} from "./utils/OperatorTestBase.sol";
import {MockERC1271Wallet} from "./utils/SigningKit.sol";

/// @dev `deliverDelegated` and `revokeDeliveryDelegate`: every way a delegated delivery is accepted or refused.
contract DeliverDelegatedTest is OperatorTestBase {
    bytes32 internal constant ARTEFACT = keccak256("artefact");

    /// @dev A funded job, a delegation to `delegate` for a day, and the delegate's signature of `ARTEFACT`.
    function _delegated()
        internal
        returns (
            AuthCaptureEscrow.PaymentInfo memory pi,
            bytes32 hash,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        )
    {
        (pi,, hash) = _fundDefault();
        expiry = uint48(vm.getBlockTimestamp() + 1 days);
        delegationSig = _signDelegation(receiverPk, hash, delegate, expiry);
        delegateSig = _signDelivery(delegatePk, hash, ARTEFACT);
    }

    function _expectUnauthorized(address signer) internal {
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, signer));
    }

    function _expectStatus(bytes32 hash, SidequestOperator.Status status, SidequestOperator.Status required) internal {
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.InvalidStatus.selector, hash, status, required));
    }

    function test_deliveryDelegateDigest_matchesEip712() public view {
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
        bytes32 typeHash = keccak256("DeliveryDelegate(bytes32 paymentInfoHash,address delegate,uint48 expiry)");
        assertEq(op.DELIVERY_DELEGATE_TYPEHASH(), typeHash);
        bytes32 structHash = keccak256(abi.encode(typeHash, hash, delegate, uint256(1_900_000_000)));
        assertEq(
            op.deliveryDelegateDigest(hash, delegate, 1_900_000_000),
            keccak256(abi.encodePacked("\x19\x01", domain, structHash))
        );
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Accepted
    // ---------------------------------------------------------------------------------------------------------------

    function test_deliverDelegated_relayedRecordsTheDeliveryAndNamesTheDelegate() public {
        (
            AuthCaptureEscrow.PaymentInfo memory pi,
            bytes32 hash,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        ) = _delegated();
        uint48 now_ = uint48(vm.getBlockTimestamp());
        vm.expectEmit(address(op));
        emit SidequestOperator.JobDelivered(hash, keccak256("terms"), ARTEFACT, now_, now_ + REVIEW);
        vm.expectEmit(address(op));
        emit SidequestOperator.JobDeliveryDelegated(hash, delegate, expiry);
        vm.prank(relayer);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);

        SidequestOperator.Job memory job = op.getJob(hash);
        assertEq(uint8(job.status), uint8(SidequestOperator.Status.Delivered));
        assertEq(job.deliveredAt, now_);
        assertEq(job.deliveryHash, ARTEFACT);
        assertEq(_capturable(hash), DEFAULT_AMOUNT, "delivery moves no funds");
    }

    function test_deliverDelegated_byTheDelegateItselfWithoutItsSignature() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash, uint48 expiry,, bytes memory delegationSig) =
            _delegated();
        vm.prank(delegate);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, "", delegationSig);
        assertEq(op.getJob(hash).deliveryHash, ARTEFACT);
    }

    function test_deliverDelegated_byTheReceiverWithoutTheDelegationSignature() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash, uint48 expiry, bytes memory delegateSig,) = _delegated();
        vm.prank(receiver);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, "");
        assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Delivered));
    }

    /// @dev The delegated delivery is an ordinary delivery afterwards: the payer approves it and the receiver is paid;
    ///      the delegate receives nothing.
    function test_deliverDelegated_thenApprovedPaysTheReceiver() public {
        (
            AuthCaptureEscrow.PaymentInfo memory pi,
            bytes32 hash,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        ) = _delegated();
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);
        bytes memory approval = _signApproval(payerPk, hash);
        op.approve(pi, approval);
        assertEq(token.balanceOf(receiver), 950e6);
        assertEq(token.balanceOf(treasury), 50e6);
        assertEq(token.balanceOf(delegate), 0);
        assertEq(uint8(op.getJob(hash).outcome), uint8(SidequestOperator.Outcome.Approved));
    }

    function test_deliverDelegated_atLastSecondBeforeExpiry() public {
        (
            AuthCaptureEscrow.PaymentInfo memory pi,
            bytes32 hash,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        ) = _delegated();
        vm.warp(expiry - 1);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);
        assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Delivered));
    }

    function test_deliverDelegated_smartWalletReceiverDelegates() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(receiver);
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.receiver = address(wallet);
        bytes32 hash = _fund(pi, params);
        uint48 expiry = uint48(vm.getBlockTimestamp() + 1 days);
        bytes memory delegationSig = _signDelegation(receiverPk, hash, delegate, expiry);
        bytes memory delegateSig = _signDelivery(delegatePk, hash, ARTEFACT);
        vm.prank(relayer);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);
        assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Delivered));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Refused: who signed
    // ---------------------------------------------------------------------------------------------------------------

    function test_deliverDelegated_revertsWhenAnotherKeySignsTheDelivery() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash, uint48 expiry,, bytes memory delegationSig) =
            _delegated();
        bytes memory strangerSig = _signDelivery(strangerPk, hash, ARTEFACT);
        _expectUnauthorized(delegate);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, strangerSig, delegationSig);
    }

    /// @dev A stranger cannot pose as the delegate: the receiver delegated to `delegate`, not to the stranger.
    function test_deliverDelegated_revertsForADelegateTheReceiverDidNotName() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash, uint48 expiry,, bytes memory delegationSig) =
            _delegated();
        bytes memory strangerSig = _signDelivery(strangerPk, hash, ARTEFACT);
        _expectUnauthorized(receiver);
        op.deliverDelegated(pi, ARTEFACT, stranger, expiry, strangerSig, delegationSig);
        _expectUnauthorized(receiver);
        vm.prank(stranger);
        op.deliverDelegated(pi, ARTEFACT, stranger, expiry, "", delegationSig);
    }

    function test_deliverDelegated_revertsWhenTheDelegationIsSignedByAnotherKey() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash, uint48 expiry, bytes memory delegateSig,) = _delegated();
        bytes memory forged = _signDelegation(strangerPk, hash, delegate, expiry);
        _expectUnauthorized(receiver);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, forged);
        // The delegate cannot delegate to itself either.
        bytes memory self = _signDelegation(delegatePk, hash, delegate, expiry);
        _expectUnauthorized(receiver);
        vm.prank(delegate);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, "", self);
    }

    function test_deliverDelegated_revertsWithoutAnyDelegation() public {
        (AuthCaptureEscrow.PaymentInfo memory pi,, uint48 expiry, bytes memory delegateSig,) = _delegated();
        _expectUnauthorized(receiver);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, "");
    }

    /// @dev A relayer cannot stretch the window: the expiry is inside the receiver's signature.
    function test_deliverDelegated_revertsWhenTheExpiryDiffersFromTheSigned() public {
        (
            AuthCaptureEscrow.PaymentInfo memory pi,,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        ) = _delegated();
        _expectUnauthorized(receiver);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry + 1, delegateSig, delegationSig);
    }

    function test_deliverDelegated_revertsWhenTheDelegateSignedAnotherArtefact() public {
        (
            AuthCaptureEscrow.PaymentInfo memory pi,,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        ) = _delegated();
        _expectUnauthorized(delegate);
        op.deliverDelegated(pi, keccak256("something else"), delegate, expiry, delegateSig, delegationSig);
    }

    function test_deliverDelegated_revertsOnAMalformedDelegateSignature() public {
        (
            AuthCaptureEscrow.PaymentInfo memory pi,,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        ) = _delegated();
        _expectUnauthorized(delegate);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, hex"1234", delegationSig);
        // High-s twin of a valid signature: ECDSA's malleability check refuses it.
        bytes32 r;
        bytes32 s;
        assembly {
            r := mload(add(delegateSig, 32))
            s := mload(add(delegateSig, 64))
        }
        uint8 v = uint8(delegateSig[64]);
        bytes32 highS = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        _expectUnauthorized(delegate);
        op.deliverDelegated(
            pi, ARTEFACT, delegate, expiry, abi.encodePacked(r, highS, v == 27 ? 28 : 27), delegationSig
        );
    }

    /// @dev Delegates are EOA keys: a contract wallet named as delegate is not asked (ERC-1271) for its signature.
    function test_deliverDelegated_doesNotAskASmartWalletDelegate() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash,,,) = _delegated();
        MockERC1271Wallet wallet = new MockERC1271Wallet(delegate);
        uint48 expiry = uint48(vm.getBlockTimestamp() + 1 days);
        bytes memory delegationSig = _signDelegation(receiverPk, hash, address(wallet), expiry);
        bytes memory ownerSig = _signDelivery(delegatePk, hash, ARTEFACT);
        _expectUnauthorized(address(wallet));
        op.deliverDelegated(pi, ARTEFACT, address(wallet), expiry, ownerSig, delegationSig);
    }

    function test_deliverDelegated_revertsForASmartWalletReceiverWithTheWrongOwnerKey() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(receiver);
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.receiver = address(wallet);
        bytes32 hash = _fund(pi, params);
        uint48 expiry = uint48(vm.getBlockTimestamp() + 1 days);
        bytes memory forged = _signDelegation(strangerPk, hash, delegate, expiry);
        bytes memory delegateSig = _signDelivery(delegatePk, hash, ARTEFACT);
        _expectUnauthorized(address(wallet));
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, forged);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Refused: which payment, which action
    // ---------------------------------------------------------------------------------------------------------------

    function test_deliverDelegated_revertsWithADelegationForAnotherPayment() public {
        (,, bytes32 hashA) = _fundDefault();
        (AuthCaptureEscrow.PaymentInfo memory piB,, bytes32 hashB) = _fundDefault();
        uint48 expiry = uint48(vm.getBlockTimestamp() + 1 days);
        bytes memory delegationForA = _signDelegation(receiverPk, hashA, delegate, expiry);
        bytes memory delegateSigForB = _signDelivery(delegatePk, hashB, ARTEFACT);
        _expectUnauthorized(receiver);
        op.deliverDelegated(piB, ARTEFACT, delegate, expiry, delegateSigForB, delegationForA);
        // Nor does the delegate's own signature for another payment help.
        bytes memory delegationForB = _signDelegation(receiverPk, hashB, delegate, expiry);
        bytes memory delegateSigForA = _signDelivery(delegatePk, hashA, ARTEFACT);
        _expectUnauthorized(delegate);
        op.deliverDelegated(piB, ARTEFACT, delegate, expiry, delegateSigForA, delegationForB);
    }

    function test_deliverDelegated_revertsWithADelegationForAnotherOperatorDomain() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash, uint48 expiry, bytes memory delegateSig,) = _delegated();
        SidequestOperator other = new SidequestOperator(address(escrow), address(collector), FEE_BPS, treasury);
        bytes memory elsewhere = _sign(receiverPk, other.deliveryDelegateDigest(hash, delegate, expiry));
        _expectUnauthorized(receiver);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, elsewhere);
    }

    /// @dev The two receiver types do not mix: a delegation is no `Delivery`, and a `Delivery` is no delegation.
    function test_delegationAndDeliverySignaturesDoNotStandInForEachOther() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash, uint48 expiry,, bytes memory delegationSig) =
            _delegated();
        _expectUnauthorized(receiver);
        op.deliver(pi, ARTEFACT, delegationSig);
        bytes memory receiverDelivery = _signDelivery(receiverPk, hash, ARTEFACT);
        bytes memory delegateSig = _signDelivery(delegatePk, hash, ARTEFACT);
        _expectUnauthorized(receiver);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, receiverDelivery);
    }

    /// @dev A delegate has no say in the review: its signatures and calls approve, reject and rule nothing.
    function test_delegateCannotApproveRejectOrRule() public {
        (
            AuthCaptureEscrow.PaymentInfo memory pi,
            bytes32 hash,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        ) = _delegated();
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);

        bytes memory approval = _signApproval(delegatePk, hash);
        bytes memory rejection = _signRejection(delegatePk, hash);
        _expectUnauthorized(payer);
        op.approve(pi, approval);
        _expectUnauthorized(payer);
        op.reject(pi, rejection);
        vm.startPrank(delegate);
        _expectUnauthorized(payer);
        op.approve(pi, "");
        _expectUnauthorized(payer);
        op.reject(pi, "");
        vm.stopPrank();

        vm.prank(payer);
        op.reject(pi, "");
        bytes memory ruling = _signRuling(delegatePk, hash, 10_000);
        _expectUnauthorized(arbitrator);
        op.rule(pi, 10_000, ruling);
        _expectUnauthorized(arbitrator);
        vm.prank(delegate);
        op.rule(pi, 10_000, "");
        assertEq(_capturable(hash), DEFAULT_AMOUNT, "nothing moved");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Refused: when
    // ---------------------------------------------------------------------------------------------------------------

    function test_deliverDelegated_revertsAtExpiry() public {
        (
            AuthCaptureEscrow.PaymentInfo memory pi,,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        ) = _delegated();
        vm.warp(expiry);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.DelegationExpired.selector, uint256(expiry), expiry));
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);
        // The receiver itself still delivers.
        _deliver(pi);
    }

    function test_deliverDelegated_revertsAtTheDeliveryDeadlineEvenWithALaterExpiry() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, SidequestOperator.JobParams memory params, bytes32 hash) =
            _fundDefault();
        uint48 expiry = params.deliveryDeadline + 30 days;
        bytes memory delegationSig = _signDelegation(receiverPk, hash, delegate, expiry);
        bytes memory delegateSig = _signDelivery(delegatePk, hash, ARTEFACT);
        vm.warp(params.deliveryDeadline);
        vm.expectRevert(
            abi.encodeWithSelector(
                SidequestOperator.DeadlinePassed.selector, params.deliveryDeadline, params.deliveryDeadline
            )
        );
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);
    }

    function test_deliverDelegated_revertsOnZeroHash() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash, uint48 expiry,, bytes memory delegationSig) =
            _delegated();
        bytes memory zeroSig = _signDelivery(delegatePk, hash, bytes32(0));
        vm.expectRevert(SidequestOperator.ZeroDeliveryHash.selector);
        op.deliverDelegated(pi, bytes32(0), delegate, expiry, zeroSig, delegationSig);
    }

    function test_deliverDelegated_revertsOnReplayAfterDelivery() public {
        (
            AuthCaptureEscrow.PaymentInfo memory pi,
            bytes32 hash,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        ) = _delegated();
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);
        _expectStatus(hash, SidequestOperator.Status.Delivered, SidequestOperator.Status.Funded);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);
        // A second artefact under the same delegation is refused the same way.
        bytes memory second = _signDelivery(delegatePk, hash, keccak256("second"));
        _expectStatus(hash, SidequestOperator.Status.Delivered, SidequestOperator.Status.Funded);
        op.deliverDelegated(pi, keccak256("second"), delegate, expiry, second, delegationSig);
        // And the receiver cannot overwrite it directly.
        _expectStatus(hash, SidequestOperator.Status.Delivered, SidequestOperator.Status.Funded);
        vm.prank(receiver);
        op.deliver(pi, keccak256("second"), "");
    }

    /// @dev A delegation does not take the receiver's own delivery away; once the receiver delivered, the delegation
    ///      is dead.
    function test_receiverStillDeliversDirectlyUnderADelegation() public {
        (
            AuthCaptureEscrow.PaymentInfo memory pi,
            bytes32 hash,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        ) = _delegated();
        bytes memory receiverSig = _signDelivery(receiverPk, hash, keccak256("own"));
        op.deliver(pi, keccak256("own"), receiverSig);
        assertEq(op.getJob(hash).deliveryHash, keccak256("own"));
        _expectStatus(hash, SidequestOperator.Status.Delivered, SidequestOperator.Status.Funded);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);
    }

    function test_deliverDelegated_revertsOnASettledJob() public {
        (
            AuthCaptureEscrow.PaymentInfo memory pi,
            bytes32 hash,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        ) = _delegated();
        vm.warp(op.getJob(hash).deliveryDeadline);
        op.refundUndelivered(pi);
        _expectStatus(hash, SidequestOperator.Status.Settled, SidequestOperator.Status.Funded);
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Revocation
    // ---------------------------------------------------------------------------------------------------------------

    function test_revokeDeliveryDelegate_byTheReceiverEndsTheDelegation() public {
        (
            AuthCaptureEscrow.PaymentInfo memory pi,
            bytes32 hash,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        ) = _delegated();
        vm.expectEmit(address(op));
        emit SidequestOperator.DeliveryDelegateRevoked(hash, receiver, delegate);
        vm.prank(receiver);
        op.revokeDeliveryDelegate(hash, delegate);
        assertTrue(op.isDeliveryDelegateRevoked(receiver, hash, delegate));

        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.DelegationRevoked.selector, hash, delegate));
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);
        // A fresh delegation to the same key, with a new expiry, is revoked too: revocation names the key.
        uint48 later = expiry + 1 days;
        bytes memory again = _signDelegation(receiverPk, hash, delegate, later);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.DelegationRevoked.selector, hash, delegate));
        op.deliverDelegated(pi, ARTEFACT, delegate, later, delegateSig, again);
        // Another key the receiver delegates to afterwards works.
        bytes memory toStranger = _signDelegation(receiverPk, hash, stranger, expiry);
        bytes memory strangerSig = _signDelivery(strangerPk, hash, ARTEFACT);
        op.deliverDelegated(pi, ARTEFACT, stranger, expiry, strangerSig, toStranger);
        assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Delivered));
    }

    /// @dev Only the receiver's revocation counts: anyone may call, but writes only under their own address.
    function test_revokeDeliveryDelegate_byAnyoneElseChangesNothing() public {
        (
            AuthCaptureEscrow.PaymentInfo memory pi,
            bytes32 hash,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        ) = _delegated();
        address[3] memory others = [payer, stranger, delegate];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            op.revokeDeliveryDelegate(hash, delegate);
            assertTrue(op.isDeliveryDelegateRevoked(others[i], hash, delegate));
        }
        assertFalse(op.isDeliveryDelegateRevoked(receiver, hash, delegate));
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);
        assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Delivered));
    }

    /// @dev The receiver may revoke before the payment is funded: the payment hash is known from the terms.
    function test_revokeDeliveryDelegate_beforeFunding() public {
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        bytes32 hash = escrow.getHash(pi);
        vm.prank(receiver);
        op.revokeDeliveryDelegate(hash, delegate);
        assertEq(_fund(pi, params), hash);
        uint48 expiry = uint48(vm.getBlockTimestamp() + 1 days);
        bytes memory delegationSig = _signDelegation(receiverPk, hash, delegate, expiry);
        bytes memory delegateSig = _signDelivery(delegatePk, hash, ARTEFACT);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.DelegationRevoked.selector, hash, delegate));
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);
    }

    /// @dev A contract-wallet receiver revokes by calling from the wallet.
    function test_revokeDeliveryDelegate_bySmartWalletReceiver() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(receiver);
        SidequestOperator.JobParams memory params = _params();
        AuthCaptureEscrow.PaymentInfo memory pi = _paymentInfo(params, DEFAULT_AMOUNT);
        pi.receiver = address(wallet);
        bytes32 hash = _fund(pi, params);
        uint48 expiry = uint48(vm.getBlockTimestamp() + 1 days);
        bytes memory delegationSig = _signDelegation(receiverPk, hash, delegate, expiry);
        bytes memory delegateSig = _signDelivery(delegatePk, hash, ARTEFACT);
        // The wallet's owner key revoking from its own address is not the receiver.
        vm.prank(receiver);
        op.revokeDeliveryDelegate(hash, delegate);
        assertFalse(op.isDeliveryDelegateRevoked(address(wallet), hash, delegate));
        vm.prank(address(wallet));
        op.revokeDeliveryDelegate(hash, delegate);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.DelegationRevoked.selector, hash, delegate));
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);
    }

    /// @dev A revocation after the delegated delivery was mined changes nothing: the delivery stands.
    function test_revokeDeliveryDelegate_afterTheDeliveryLeavesItStanding() public {
        (
            AuthCaptureEscrow.PaymentInfo memory pi,
            bytes32 hash,
            uint48 expiry,
            bytes memory delegateSig,
            bytes memory delegationSig
        ) = _delegated();
        op.deliverDelegated(pi, ARTEFACT, delegate, expiry, delegateSig, delegationSig);
        vm.prank(receiver);
        op.revokeDeliveryDelegate(hash, delegate);
        assertEq(op.getJob(hash).deliveryHash, ARTEFACT);
        assertEq(uint8(_status(hash)), uint8(SidequestOperator.Status.Delivered));
    }
}
