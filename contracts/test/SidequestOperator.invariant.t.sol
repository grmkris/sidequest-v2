// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {AuthCaptureEscrow} from "commerce-payments/src/AuthCaptureEscrow.sol";
import {ERC3009PaymentCollector} from "commerce-payments/src/collectors/ERC3009PaymentCollector.sol";
import {MockERC3009Token} from "commerce-payments/test/mocks/MockERC3009Token.sol";

import {SidequestOperator} from "../src/SidequestOperator.sol";
import {SigningKit} from "./utils/SigningKit.sol";

/// @dev Drives many concurrent jobs through every transition, in any order and at any time, including the payer's
///      escrow `reclaim` and a stranger's attempts. Violations are recorded as ghost flags, because a failed assertion
///      inside a handler is just a revert to the fuzzer.
contract OperatorHandler is Test, SigningKit {
    uint16 internal constant FEE_BPS = 500;

    AuthCaptureEscrow public escrow;
    MockERC3009Token public token;
    SidequestOperator public op;
    address public treasury;

    uint256[3] internal payerPks = [uint256(0x1001), 0x1002, 0x1003];
    uint256[3] internal receiverPks = [uint256(0x2001), 0x2002, 0x2003];
    uint256 internal arbitratorPk = 0x3001;
    uint256 internal strangerPk = 0x4001;
    /// @dev The agent key each receiver delegates its deliveries to, by receiver index.
    uint256[3] internal delegatePks = [uint256(0x5001), 0x5002, 0x5003];

    struct Tracked {
        AuthCaptureEscrow.PaymentInfo pi;
        bytes32 hash;
        uint256 settleCount;
        bool reclaimed;
        uint8 lastStatus;
        bool delegateRevoked;
    }

    Tracked[] internal _jobs;
    uint256 public totalMinted;
    uint256 public jobNonce;

    bool public leakedOrMiscounted;
    bool public strangerSucceeded;
    /// @dev A delegated delivery landed although revoked or expired, or a delegate's key did anything but deliver.
    bool public delegationBreached;
    bool public statusWentBackwards;
    bool public wrongSplit;

    mapping(bytes32 => uint256) public calls;
    mapping(bytes32 => uint256) public successes;

    constructor(AuthCaptureEscrow escrow_, address collector_, MockERC3009Token token_, SidequestOperator op_) {
        escrow = escrow_;
        token = token_;
        op = op_;
        treasury = op_.FEE_RECEIVER();
        _bindSigning(escrow_, collector_);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------------------------------------------

    function fund(uint256 actorSeed, uint256 amount, uint256 windowSeed, uint256 deadlineSeed) external {
        calls["fund"]++;
        uint256 payerPk = payerPks[actorSeed % 3];
        address payer = vm.addr(payerPk);
        address receiver = vm.addr(receiverPks[(actorSeed / 3) % 3]);
        amount = bound(amount, 1, 1e15);

        SidequestOperator.JobParams memory params = SidequestOperator.JobParams({
            jobId: keccak256(abi.encode(++jobNonce)),
            termsDigest: keccak256(abi.encode("terms", jobNonce)),
            deliveryDeadline: uint48(vm.getBlockTimestamp() + bound(deadlineSeed, 1, 30 days)),
            reviewWindow: uint32(bound(windowSeed, 1 hours, 14 days)),
            disputeWindow: uint32(bound(windowSeed >> 32, 1 hours, 14 days)),
            arbitrationWindow: uint32(bound(windowSeed >> 64, 12 hours, 14 days)),
            arbitrator: vm.addr(arbitratorPk)
        });
        uint48 expiry = uint48(
            uint256(params.deliveryDeadline) + params.reviewWindow + params.disputeWindow + params.arbitrationWindow
                + op.MARGIN()
        );
        AuthCaptureEscrow.PaymentInfo memory pi = AuthCaptureEscrow.PaymentInfo({
            operator: address(op),
            payer: payer,
            receiver: receiver,
            token: address(token),
            maxAmount: uint120(amount),
            preApprovalExpiry: params.deliveryDeadline,
            authorizationExpiry: expiry,
            refundExpiry: expiry,
            minFeeBps: FEE_BPS,
            maxFeeBps: FEE_BPS,
            feeReceiver: treasury,
            salt: op.jobSalt(params)
        });
        token.mint(payer, amount);
        totalMinted += amount;
        bytes32 hash = op.fund(pi, params, _signReceive(payerPk, address(token), pi));
        _jobs.push(
            Tracked({pi: pi, hash: hash, settleCount: 0, reclaimed: false, lastStatus: 1, delegateRevoked: false})
        );
    }

    function deliver(uint256 jobSeed, bool relayed) external {
        if (_jobs.length == 0) return;
        calls["deliver"]++;
        Tracked storage t = _pick(jobSeed, SidequestOperator.Status.Funded);
        bytes32 artefact = keccak256(abi.encode(t.hash));
        if (relayed) {
            try op.deliver(t.pi, artefact, _sign(_receiverPk(t.pi.receiver), op.deliveryDigest(t.hash, artefact))) {
                successes["deliver"]++;
            } catch {}
        } else {
            vm.prank(t.pi.receiver);
            try op.deliver(t.pi, artefact, "") {
                successes["deliver"]++;
            } catch {}
        }
        _observe(t);
    }

    /// @dev The receiver's agent key delivers under a delegation that may already have expired or been revoked; it
    ///      must land exactly when it is neither, and only while the job is funded and before its deadline.
    function deliverDelegated(uint256 jobSeed, uint256 expirySeed, bool delegateCalls) external {
        if (_jobs.length == 0) return;
        calls["deliverDelegated"]++;
        Tracked storage t = _pick(jobSeed, SidequestOperator.Status.Funded);
        uint256 receiverIndex = _receiverIndex(t.pi.receiver);
        uint256 delegatePk = delegatePks[receiverIndex];
        address delegate = vm.addr(delegatePk);
        // From an hour ago to a week ahead: about one in eight delegations has already expired.
        uint48 expiry = uint48(vm.getBlockTimestamp() + bound(expirySeed, 0, 8 days) - 1 hours);
        bytes32 artefact = keccak256(abi.encode("delegated", t.hash));
        bytes memory delegation = _sign(receiverPks[receiverIndex], op.deliveryDelegateDigest(t.hash, delegate, expiry));
        bytes memory delivery = delegateCalls ? bytes("") : _sign(delegatePk, op.deliveryDigest(t.hash, artefact));
        SidequestOperator.Job memory before = op.getJob(t.hash);
        bool allowed = before.status == SidequestOperator.Status.Funded
            && vm.getBlockTimestamp() < before.deliveryDeadline && vm.getBlockTimestamp() < expiry && !t.delegateRevoked;
        if (delegateCalls) vm.prank(delegate);
        try op.deliverDelegated(t.pi, artefact, delegate, expiry, delivery, delegation) {
            successes["deliverDelegated"]++;
            if (!allowed) delegationBreached = true;
            if (op.getJob(t.hash).deliveryHash != artefact) delegationBreached = true;
        } catch {
            // Delivery calls no escrow function, so even a reclaimed (still `Funded`) job accepts an allowed one.
            if (allowed) delegationBreached = true;
        }
        _observe(t);
    }

    /// @dev The receiver revokes its agent key's delegation for a job; on one call in four, so that most delegations
    ///      stay usable and runs reach delegated deliveries.
    function revokeDelegate(uint256 jobSeed, uint8 chance) external {
        if (_jobs.length == 0 || chance % 4 != 0) return;
        calls["revokeDelegate"]++;
        Tracked storage t = _pick(jobSeed, SidequestOperator.Status.Funded);
        vm.prank(t.pi.receiver);
        op.revokeDeliveryDelegate(t.hash, vm.addr(delegatePks[_receiverIndex(t.pi.receiver)]));
        t.delegateRevoked = true;
        successes["revokeDelegate"]++;
        _observe(t);
    }

    function approve(uint256 jobSeed) external {
        if (_jobs.length == 0) return;
        calls["approve"]++;
        Tracked storage t = _pick(jobSeed, SidequestOperator.Status.Delivered);
        bytes memory sig = _sign(_payerPk(t.pi.payer), op.approvalDigest(t.hash, op.getJob(t.hash).deliveryHash));
        _settleCall(t, abi.encodeCall(op.approve, (t.pi, sig)), 10_000);
    }

    function settleAfterReview(uint256 jobSeed) external {
        if (_jobs.length == 0) return;
        calls["settleAfterReview"]++;
        Tracked storage t = _pick(jobSeed, SidequestOperator.Status.Delivered);
        _settleCall(t, abi.encodeCall(op.settleAfterReview, (t.pi)), 10_000);
    }

    function reject(uint256 jobSeed) external {
        if (_jobs.length == 0) return;
        calls["reject"]++;
        Tracked storage t = _pick(jobSeed, SidequestOperator.Status.Delivered);
        vm.prank(t.pi.payer);
        try op.reject(t.pi, "") {
            successes["reject"]++;
        } catch {}
        _observe(t);
    }

    function rule(uint256 jobSeed, uint16 bps) external {
        if (_jobs.length == 0) return;
        calls["rule"]++;
        Tracked storage t = _pick(jobSeed, SidequestOperator.Status.Disputed);
        bps = uint16(bound(bps, 0, 10_000));
        bytes memory sig = _sign(arbitratorPk, op.rulingDigest(t.hash, bps));
        _settleCall(t, abi.encodeCall(op.rule, (t.pi, bps, sig)), bps);
    }

    function settleUnruled(uint256 jobSeed) external {
        if (_jobs.length == 0) return;
        calls["settleUnruled"]++;
        Tracked storage t = _pick(jobSeed, SidequestOperator.Status.Disputed);
        _settleCall(t, abi.encodeCall(op.settleUnruled, (t.pi)), 0);
    }

    function refundUndelivered(uint256 jobSeed) external {
        if (_jobs.length == 0) return;
        calls["refundUndelivered"]++;
        Tracked storage t = _pick(jobSeed, SidequestOperator.Status.Funded);
        _settleCall(t, abi.encodeCall(op.refundUndelivered, (t.pi)), 0);
    }

    /// @dev The payer's own escrow exit. Must only ever succeed at or after `authorizationExpiry`.
    function reclaim(uint256 jobSeed) external {
        if (_jobs.length == 0) return;
        calls["reclaim"]++;
        Tracked storage t = _pick(jobSeed);
        uint256 before = token.balanceOf(t.pi.payer);
        vm.prank(t.pi.payer);
        try escrow.reclaim(t.pi) {
            if (vm.getBlockTimestamp() < t.pi.authorizationExpiry) leakedOrMiscounted = true;
            if (token.balanceOf(t.pi.payer) - before != t.pi.maxAmount) leakedOrMiscounted = true;
            t.reclaimed = true;
            successes["reclaim"]++;
        } catch {}
        _observe(t);
    }

    /// @dev A stranger with its own key tries every signed action. None may succeed.
    function strangerAttack(uint256 jobSeed, uint16 bps) external {
        if (_jobs.length == 0) return;
        calls["strangerAttack"]++;
        Tracked storage t = _pick(jobSeed);
        bps = uint16(bound(bps, 0, 10_000));
        address stranger = vm.addr(strangerPk);
        bytes32 artefact = keccak256("forged");
        vm.startPrank(stranger);
        try op.deliver(t.pi, artefact, _sign(strangerPk, op.deliveryDigest(t.hash, artefact))) {
            strangerSucceeded = true;
        } catch {}
        try op.approve(t.pi, _sign(strangerPk, op.approvalDigest(t.hash, op.getJob(t.hash).deliveryHash))) {
            strangerSucceeded = true;
        } catch {}
        try op.reject(t.pi, _sign(strangerPk, op.rejectionDigest(t.hash, op.getJob(t.hash).deliveryHash))) {
            strangerSucceeded = true;
        } catch {}
        try op.rule(t.pi, bps, _sign(strangerPk, op.rulingDigest(t.hash, bps))) {
            strangerSucceeded = true;
        } catch {}
        // A delegation the stranger signed for itself is no delegation.
        uint48 expiry = uint48(vm.getBlockTimestamp() + 1 days);
        bytes memory selfDelegation = _sign(strangerPk, op.deliveryDelegateDigest(t.hash, stranger, expiry));
        try op.deliverDelegated(t.pi, artefact, stranger, expiry, "", selfDelegation) {
            strangerSucceeded = true;
        } catch {}
        vm.stopPrank();
        _observe(t);
    }

    /// @dev The job's delegate key, which the receiver trusts to deliver, tries every other action, with a signature
    ///      and as the caller. None may succeed.
    function delegateAttack(uint256 jobSeed, uint16 bps) external {
        if (_jobs.length == 0) return;
        calls["delegateAttack"]++;
        Tracked storage t = _pick(jobSeed);
        bps = uint16(bound(bps, 0, 10_000));
        uint256 delegatePk = delegatePks[_receiverIndex(t.pi.receiver)];
        bytes32 delivered = op.getJob(t.hash).deliveryHash;
        bytes memory approval = _sign(delegatePk, op.approvalDigest(t.hash, delivered));
        bytes memory rejection = _sign(delegatePk, op.rejectionDigest(t.hash, delivered));
        bytes memory ruling = _sign(delegatePk, op.rulingDigest(t.hash, bps));
        bytes memory delivery = _sign(delegatePk, op.deliveryDigest(t.hash, keccak256("undelegated")));
        vm.startPrank(vm.addr(delegatePk));
        try op.approve(t.pi, approval) {
            delegationBreached = true;
        } catch {}
        try op.approve(t.pi, "") {
            delegationBreached = true;
        } catch {}
        try op.reject(t.pi, rejection) {
            delegationBreached = true;
        } catch {}
        try op.reject(t.pi, "") {
            delegationBreached = true;
        } catch {}
        try op.rule(t.pi, bps, ruling) {
            delegationBreached = true;
        } catch {}
        try op.rule(t.pi, bps, "") {
            delegationBreached = true;
        } catch {}
        // Without the receiver's delegation its `Delivery` signature is a stranger's.
        try op.deliver(t.pi, keccak256("undelegated"), delivery) {
            delegationBreached = true;
        } catch {}
        vm.stopPrank();
        _observe(t);
    }

    function warp(uint256 seconds_) external {
        calls["warp"]++;
        vm.warp(vm.getBlockTimestamp() + bound(seconds_, 1, 4 days));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Views for the invariants
    // ---------------------------------------------------------------------------------------------------------------

    function jobCount() external view returns (uint256) {
        return _jobs.length;
    }

    function job(uint256 i) external view returns (AuthCaptureEscrow.PaymentInfo memory, bytes32, uint256, bool) {
        Tracked storage t = _jobs[i];
        return (t.pi, t.hash, t.settleCount, t.reclaimed);
    }

    function partyBalances() external view returns (uint256 sum) {
        for (uint256 i; i < 3; ++i) {
            sum += token.balanceOf(vm.addr(payerPks[i])) + token.balanceOf(vm.addr(receiverPks[i]));
        }
        sum += token.balanceOf(treasury);
    }

    function outsiders() external view returns (address[7] memory) {
        return [
            address(op),
            address(this),
            vm.addr(strangerPk),
            vm.addr(arbitratorPk),
            vm.addr(delegatePks[0]),
            vm.addr(delegatePks[1]),
            vm.addr(delegatePks[2])
        ];
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev Calls a settling action and, if it succeeds, checks that exactly `bps` of the amount went to the receiver
    ///      side (fee proportional) and the rest to the payer, and nothing anywhere else.
    function _settleCall(Tracked storage t, bytes memory data, uint16 bps) internal {
        uint256 r0 = token.balanceOf(t.pi.receiver);
        uint256 f0 = token.balanceOf(treasury);
        uint256 p0 = token.balanceOf(t.pi.payer);
        (bool ok,) = address(op).call(data);
        if (ok) {
            successes[bytes32(bytes4(data))]++;
            t.settleCount++;
            uint256 amount = t.pi.maxAmount;
            uint256 captured = amount * bps / 10_000;
            uint256 fee = captured * FEE_BPS / 10_000;
            if (token.balanceOf(treasury) - f0 != fee) wrongSplit = true;
            if (token.balanceOf(t.pi.receiver) - r0 != captured - fee) wrongSplit = true;
            if (token.balanceOf(t.pi.payer) - p0 != amount - captured) wrongSplit = true;
            if (t.reclaimed) wrongSplit = true;
        }
        _observe(t);
    }

    function _observe(Tracked storage t) internal {
        uint8 s = uint8(op.getJob(t.hash).status);
        if (s < t.lastStatus) statusWentBackwards = true;
        t.lastStatus = s;
    }

    function _pick(uint256 seed) internal view returns (Tracked storage) {
        return _jobs[seed % _jobs.length];
    }

    /// @dev Mostly a job in `wanted` status, so runs get deep into the lifecycle; one seed in eight (or when no job is
    ///      in that status) any job, so wrong-state calls are exercised too.
    function _pick(uint256 seed, SidequestOperator.Status wanted) internal view returns (Tracked storage) {
        uint256 n = _jobs.length;
        if (seed % 8 != 0) {
            for (uint256 i; i < n; ++i) {
                Tracked storage t = _jobs[(seed % n + i) % n];
                if (op.getJob(t.hash).status == wanted) return t;
            }
        }
        return _jobs[seed % n];
    }

    function _payerPk(address a) internal view returns (uint256) {
        for (uint256 i; i < 3; ++i) {
            if (vm.addr(payerPks[i]) == a) return payerPks[i];
        }
        revert();
    }

    function _receiverPk(address a) internal view returns (uint256) {
        for (uint256 i; i < 3; ++i) {
            if (vm.addr(receiverPks[i]) == a) return receiverPks[i];
        }
        revert();
    }

    function _receiverIndex(address a) internal view returns (uint256) {
        for (uint256 i; i < 3; ++i) {
            if (vm.addr(receiverPks[i]) == a) return i;
        }
        revert();
    }
}

contract SidequestOperatorInvariantTest is Test {
    AuthCaptureEscrow internal escrow;
    MockERC3009Token internal token;
    SidequestOperator internal op;
    OperatorHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        escrow = new AuthCaptureEscrow();
        ERC3009PaymentCollector collector = new ERC3009PaymentCollector(address(escrow), makeAddr("multicall3"));
        token = new MockERC3009Token("USD Coin", "USDC", 6);
        op = new SidequestOperator(address(escrow), address(collector), 500, makeAddr("treasury"));
        handler = new OperatorHandler(escrow, address(collector), token, op);
        targetContract(address(handler));
    }

    /// @dev Money is conserved and only ever sits with the payers, receivers, the treasury or the escrow's store.
    function invariant_fundsOnlyReachParties() public view {
        uint256 store = token.balanceOf(escrow.getTokenStore(address(op)));
        assertEq(handler.partyBalances() + store, handler.totalMinted(), "conservation");
        assertEq(token.totalSupply(), handler.totalMinted(), "no other minting");
        address[7] memory outsiders = handler.outsiders();
        for (uint256 i; i < outsiders.length; ++i) {
            assertEq(token.balanceOf(outsiders[i]), 0, "outsider holds tokens");
        }
        assertFalse(handler.leakedOrMiscounted(), "reclaim misbehaved");
        assertFalse(handler.wrongSplit(), "a settlement paid the wrong amounts");
    }

    /// @dev The escrow's store holds exactly what live jobs still have authorised.
    function invariant_storeMatchesLiveJobs() public view {
        uint256 live;
        uint256 n = handler.jobCount();
        for (uint256 i; i < n; ++i) {
            (, bytes32 hash,,) = handler.job(i);
            (, uint120 capturable,) = escrow.paymentState(hash);
            live += capturable;
        }
        assertEq(token.balanceOf(escrow.getTokenStore(address(op))), live);
    }

    /// @dev Each job reaches at most one terminal outcome; a settled job has nothing left in escrow; a live job that
    ///      was not reclaimed still has its full amount; statuses only move forward.
    function invariant_oneOutcomePerJob() public view {
        uint256 n = handler.jobCount();
        for (uint256 i; i < n; ++i) {
            (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash, uint256 settleCount, bool reclaimed) =
                handler.job(i);
            SidequestOperator.Job memory j = op.getJob(hash);
            (, uint120 capturable,) = escrow.paymentState(hash);
            assertLe(settleCount, 1, "settled twice");
            assertFalse(settleCount == 1 && reclaimed, "settled and reclaimed");
            if (j.status == SidequestOperator.Status.Settled) {
                assertEq(settleCount, 1);
                assertTrue(j.outcome != SidequestOperator.Outcome.None);
                assertEq(capturable, 0);
            } else {
                assertEq(settleCount, 0);
                assertTrue(j.outcome == SidequestOperator.Outcome.None);
                assertEq(capturable, reclaimed ? 0 : pi.maxAmount);
            }
        }
        assertFalse(handler.statusWentBackwards(), "status went backwards");
        assertFalse(handler.strangerSucceeded(), "a stranger's signature was accepted");
        assertFalse(handler.delegationBreached(), "a delegation reached past its payment, action, expiry or revocation");
    }

    /// @dev Shows (with -vv) that the runs really reach every transition rather than reverting their way through.
    function afterInvariant() external view {
        console2.log("jobs funded", handler.jobCount());
        console2.log("deliveries", handler.successes("deliver"));
        console2.log("delegated deliveries", handler.successes("deliverDelegated"));
        console2.log("delegate revocations", handler.successes("revokeDelegate"));
        console2.log("rejections", handler.successes("reject"));
        console2.log("reclaims", handler.successes("reclaim"));
        console2.log("approvals", handler.successes(bytes32(op.approve.selector)));
        console2.log("silent acceptances", handler.successes(bytes32(op.settleAfterReview.selector)));
        console2.log("rulings", handler.successes(bytes32(op.rule.selector)));
        console2.log("unruled refunds", handler.successes(bytes32(op.settleUnruled.selector)));
        console2.log("undelivered refunds", handler.successes(bytes32(op.refundUndelivered.selector)));
    }
}
