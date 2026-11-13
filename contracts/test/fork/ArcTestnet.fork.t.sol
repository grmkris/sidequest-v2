// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {AuthCaptureEscrow} from "commerce-payments/src/AuthCaptureEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SidequestOperator} from "../../src/SidequestOperator.sol";
import {DeployedCode} from "../utils/DeployedCode.sol";
import {SigningKit} from "../utils/SigningKit.sol";

/// @dev Stand-in for Arc's native-coin precompile at 0x1800…0000, which forge's local EVM does not implement.
///
///      On Arc, USDC is the native coin (18 decimals) and the ERC-20 at 0x3600…0000 is a 6-decimal view over the same
///      balance: its `balanceOf` reads the native balance divided by 1e12 (that part works in a local fork), and its
///      `transfer`/`transferFrom` call this precompile's `transfer(from, to, amount18)` to move native balance (that
///      part does not, so we install this shim). The shim moves native balance with the `deal` cheatcode and accepts
///      calls from the USDC contract only. Everything else in these tests is the real bytecode deployed on Arc.
contract ArcNativeCoinShim {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant USDC = 0x3600000000000000000000000000000000000000;

    fallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == USDC, "shim: only USDC");
        require(bytes4(data[:4]) == bytes4(keccak256("transfer(address,address,uint256)")), "shim: unknown call");
        (address from, address to, uint256 amount) = abi.decode(data[4:], (address, address, uint256));
        require(from.balance >= amount, "shim: insufficient native balance");
        VM.deal(from, from.balance - amount);
        VM.deal(to, to.balance + amount);
        return abi.encode(true);
    }
}

/// @dev Fork tests against Arc testnet (chain 5042002), using the deployed `AuthCaptureEscrow` and
///      `ERC3009PaymentCollector` and Arc's USDC. Skipped unless `ARC_TESTNET_RPC_URL` is set.
contract ArcTestnetForkTest is DeployedCode, SigningKit {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    AuthCaptureEscrow internal constant ESCROW = AuthCaptureEscrow(0xf96815976523E00e65Be8f34cA5e64b4f41EB19c);
    address internal constant COLLECTOR = 0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88;
    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    IERC20 internal constant USDC = IERC20(0x3600000000000000000000000000000000000000);
    address internal constant NATIVE_COIN_PRECOMPILE = 0x1800000000000000000000000000000000000000;
    /// @dev Arc's native USDC has 18 decimals; the ERC-20 view has 6.
    uint256 internal constant NATIVE_PER_ERC20_UNIT = 1e12;
    uint16 internal constant FEE_BPS = 500;
    uint256 internal constant AMOUNT = 250e6;

    SidequestOperator internal op;
    uint256 internal payerPk = uint256(keccak256("sidequest fork payer"));
    uint256 internal receiverPk = uint256(keccak256("sidequest fork receiver"));
    uint256 internal arbitratorPk = uint256(keccak256("sidequest fork arbitrator"));
    address internal payer;
    address internal receiver;
    address internal arbitrator;
    address internal treasury;
    address internal relayer;

    function setUp() public {
        string memory rpc = vm.envOr("ARC_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "ARC_TESTNET_RPC_URL is not set");
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, ARC_TESTNET_CHAIN_ID, "not Arc testnet");

        payer = vm.addr(payerPk);
        receiver = vm.addr(receiverPk);
        arbitrator = vm.addr(arbitratorPk);
        treasury = makeAddr("sidequest fork treasury");
        relayer = makeAddr("sidequest fork relayer");
        // Fresh addresses must hold nothing on the live chain, or the balance assertions below mean nothing.
        assertEq(USDC.balanceOf(payer) + USDC.balanceOf(receiver) + USDC.balanceOf(treasury), 0);

        vm.etch(NATIVE_COIN_PRECOMPILE, type(ArcNativeCoinShim).runtimeCode);
        vm.allowCheatcodes(NATIVE_COIN_PRECOMPILE);
        op = new SidequestOperator(address(ESCROW), COLLECTOR, FEE_BPS, treasury);
        _bindSigning(ESCROW, COLLECTOR);

        // Fund the payer the Arc way: native balance in 18 decimals, which the ERC-20 reports in 6.
        vm.deal(payer, AMOUNT * NATIVE_PER_ERC20_UNIT);
        assertEq(USDC.balanceOf(payer), AMOUNT, "ERC-20 view of the native balance");
    }

    /// @dev The deployed escrow, collector and token store are commerce-payments v1.1.0 as vendored here, built with
    ///      this workspace's settings: identical except for the CBOR metadata (source paths differ, so the IPFS hash
    ///      does) and the immutables, which are masked.
    function test_fork_deployedBytecodeMatchesVendoredV110() public view {
        _assertCommercePaymentsV110(ESCROW, COLLECTOR, MULTICALL3);
    }

    function test_fork_fundDeliverApprove() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash) = _fund();
        assertEq(USDC.balanceOf(payer), 0);
        (, uint120 capturable,) = ESCROW.paymentState(hash);
        assertEq(capturable, AMOUNT);

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        bytes32 artefact = keccak256("fork artefact");
        bytes memory deliverySig = _sign(receiverPk, op.deliveryDigest(hash, artefact));
        vm.prank(relayer);
        op.deliver(pi, artefact, deliverySig);

        bytes memory approvalSig = _sign(payerPk, op.approvalDigest(hash, artefact));
        vm.prank(relayer);
        op.approve(pi, approvalSig);

        uint256 fee = AMOUNT * FEE_BPS / 10_000;
        assertEq(USDC.balanceOf(receiver), AMOUNT - fee);
        assertEq(USDC.balanceOf(treasury), fee);
        assertEq(receiver.balance, (AMOUNT - fee) * NATIVE_PER_ERC20_UNIT, "native view agrees");
        (, capturable,) = ESCROW.paymentState(hash);
        assertEq(capturable, 0);
        assertEq(uint8(op.getJob(hash).outcome), uint8(SidequestOperator.Outcome.Approved));
    }

    /// @dev The receiver delegates the delivery to an agent's key once; the agent's signature alone records it, and the
    ///      payer's approval pays the receiver through the deployed escrow.
    function test_fork_fundDelegatedDeliveryApprove() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash) = _fund();
        uint256 agentPk = uint256(keccak256("sidequest fork agent"));
        address agent = vm.addr(agentPk);
        uint48 expiry = uint48(vm.getBlockTimestamp() + 1 days);
        bytes memory delegationSig = _sign(receiverPk, op.deliveryDelegateDigest(hash, agent, expiry));

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        bytes32 artefact = keccak256("fork delegated artefact");
        bytes memory agentSig = _sign(agentPk, op.deliveryDigest(hash, artefact));
        vm.prank(relayer);
        op.deliverDelegated(pi, artefact, agent, expiry, agentSig, delegationSig);
        assertEq(op.getJob(hash).deliveryHash, artefact);

        bytes memory approvalSig = _sign(payerPk, op.approvalDigest(hash, artefact));
        vm.prank(relayer);
        op.approve(pi, approvalSig);
        uint256 fee = AMOUNT * FEE_BPS / 10_000;
        assertEq(USDC.balanceOf(receiver), AMOUNT - fee);
        assertEq(USDC.balanceOf(agent), 0);
        assertEq(uint8(op.getJob(hash).outcome), uint8(SidequestOperator.Outcome.Approved));
    }

    function test_fork_fundDeliverRejectRule() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash) = _fund();
        vm.prank(receiver);
        op.deliver(pi, keccak256("fork artefact"), "");

        vm.warp(vm.getBlockTimestamp() + 1 days);
        bytes memory rejectionSig = _sign(payerPk, op.rejectionDigest(hash, keccak256("fork artefact")));
        vm.prank(relayer);
        op.reject(pi, rejectionSig);

        vm.warp(vm.getBlockTimestamp() + 3 days);
        uint16 bps = 6000;
        bytes memory rulingSig = _sign(arbitratorPk, op.rulingDigest(hash, bps));
        vm.prank(relayer);
        op.rule(pi, bps, rulingSig);

        uint256 captured = AMOUNT * bps / 10_000;
        uint256 fee = captured * FEE_BPS / 10_000;
        assertEq(USDC.balanceOf(receiver), captured - fee);
        assertEq(USDC.balanceOf(treasury), fee);
        assertEq(USDC.balanceOf(payer), AMOUNT - captured);
        (, uint120 capturable,) = ESCROW.paymentState(hash);
        assertEq(capturable, 0);
        assertEq(uint8(op.getJob(hash).outcome), uint8(SidequestOperator.Outcome.Ruled));
    }

    function _fund() internal returns (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash) {
        SidequestOperator.JobParams memory params = SidequestOperator.JobParams({
            jobId: keccak256("fork job"),
            termsDigest: keccak256("fork terms"),
            deliveryDeadline: uint48(vm.getBlockTimestamp() + 7 days),
            reviewWindow: 3 days,
            disputeWindow: 2 days,
            arbitrationWindow: 7 days,
            arbitrator: arbitrator
        });
        uint48 expiry = uint48(params.deliveryDeadline + 3 days + 2 days + 7 days + op.MARGIN());
        pi = AuthCaptureEscrow.PaymentInfo({
            operator: address(op),
            payer: payer,
            receiver: receiver,
            token: address(USDC),
            maxAmount: uint120(AMOUNT),
            preApprovalExpiry: uint48(vm.getBlockTimestamp() + 1 days),
            authorizationExpiry: expiry,
            refundExpiry: expiry,
            minFeeBps: FEE_BPS,
            maxFeeBps: FEE_BPS,
            feeReceiver: treasury,
            salt: op.jobSalt(params)
        });
        bytes memory sig = _signReceive(payerPk, address(USDC), pi);
        vm.prank(relayer);
        hash = op.fund(pi, params, sig);
    }
}
