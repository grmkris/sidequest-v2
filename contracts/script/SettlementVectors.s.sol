// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {AuthCaptureEscrow} from "commerce-payments/src/AuthCaptureEscrow.sol";
import {ERC3009PaymentCollector} from "commerce-payments/src/collectors/ERC3009PaymentCollector.sol";
import {MockERC3009Token} from "commerce-payments/test/mocks/MockERC3009Token.sol";

import {SidequestOperator} from "../src/SidequestOperator.sol";

/// @notice Prints test vectors for `packages/settlement`: for fixed inputs, the hashes and EIP-712 digests the deployed
///         contracts compute (`jobSalt`, the escrow's `getHash` with and without the payer, the five action digests,
///         and the token's `ReceiveWithAuthorization` digest). The TypeScript builders must reproduce every one.
///
/// Sends nothing: it deploys into the script's own simulation, on Arc testnet's chain id. Regenerate and compare with
/// `bun tools/settlement-bindings.ts` (writes) or `--check` (fails on any difference).
contract SettlementVectors is Script {
    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;

    AuthCaptureEscrow internal escrow;
    ERC3009PaymentCollector internal collector;
    MockERC3009Token internal token;
    SidequestOperator internal op;

    struct Case {
        SidequestOperator.JobParams params;
        address payer;
        address receiver;
        uint120 amount;
        bytes32 deliveryHash;
        uint16 workerShareBps;
        address delegate;
        uint48 delegationExpiry;
    }

    function run() external {
        vm.chainId(5_042_002);
        escrow = new AuthCaptureEscrow();
        collector = new ERC3009PaymentCollector(address(escrow), address(0xCA11));
        token = new MockERC3009Token("USD Coin", "USDC", 6);
        op = new SidequestOperator(address(escrow), address(collector), 500, address(0x7EA5));

        string memory root = "root";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "escrow", address(escrow));
        vm.serializeAddress(root, "collector", address(collector));
        vm.serializeAddress(root, "token", address(token));
        vm.serializeBytes32(root, "tokenDomainSeparator", token.DOMAIN_SEPARATOR());
        vm.serializeAddress(root, "operator", address(op));
        vm.serializeUint(root, "feeBps", op.FEE_BPS());
        vm.serializeAddress(root, "feeReceiver", op.FEE_RECEIVER());
        // One JSON document per line: the deployment first, then one per case.
        console2.log(vm.serializeUint(root, "margin", op.MARGIN()));
        console2.log(_vector("typical", _typical()));
        console2.log(_vector("extremes", _extremes()));
        console2.log(_vector("minimal", _minimal()));
    }

    function _typical() internal pure returns (Case memory) {
        return Case({
            params: SidequestOperator.JobParams({
                jobId: 0x0000000000000000000000000000000001933bf25cd54505b3e8782f13e02c2a,
                termsDigest: 0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08,
                deliveryDeadline: 1_798_761_600,
                reviewWindow: 3 days,
                disputeWindow: 2 days,
                arbitrationWindow: 7 days,
                arbitrator: address(0xA4B17)
            }),
            payer: address(0xA11CE),
            receiver: address(0xB0B),
            amount: 250_000_000,
            deliveryHash: 0x2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae,
            workerShareBps: 6000,
            delegate: address(0xA6E7),
            delegationExpiry: 1_798_675_200
        });
    }

    function _extremes() internal pure returns (Case memory) {
        return Case({
            params: SidequestOperator.JobParams({
                jobId: 0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff,
                termsDigest: 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff,
                deliveryDeadline: type(uint48).max - 43 days,
                reviewWindow: 14 days,
                disputeWindow: 14 days,
                arbitrationWindow: 14 days,
                arbitrator: address(type(uint160).max)
            }),
            payer: address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF),
            receiver: address(0x8000000000000000000000000000000000000001),
            amount: type(uint120).max,
            deliveryHash: 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff,
            workerShareBps: 10_000,
            delegate: address(type(uint160).max - 1),
            delegationExpiry: type(uint48).max
        });
    }

    function _minimal() internal pure returns (Case memory) {
        return Case({
            params: SidequestOperator.JobParams({
                jobId: bytes32(uint256(1)),
                termsDigest: bytes32(uint256(2)),
                deliveryDeadline: 1,
                reviewWindow: 1 hours,
                disputeWindow: 1 hours,
                arbitrationWindow: 12 hours,
                arbitrator: address(3)
            }),
            payer: address(4),
            receiver: address(5),
            amount: 1,
            deliveryHash: bytes32(uint256(6)),
            workerShareBps: 0,
            delegate: address(7),
            delegationExpiry: 0
        });
    }

    function _paymentInfo(Case memory c) internal view returns (AuthCaptureEscrow.PaymentInfo memory) {
        SidequestOperator.JobParams memory p = c.params;
        uint48 expiry =
            uint48(uint256(p.deliveryDeadline) + p.reviewWindow + p.disputeWindow + p.arbitrationWindow + op.MARGIN());
        return AuthCaptureEscrow.PaymentInfo({
            operator: address(op),
            payer: c.payer,
            receiver: c.receiver,
            token: address(token),
            maxAmount: c.amount,
            preApprovalExpiry: p.deliveryDeadline,
            authorizationExpiry: expiry,
            refundExpiry: expiry,
            minFeeBps: op.FEE_BPS(),
            maxFeeBps: op.FEE_BPS(),
            feeReceiver: op.FEE_RECEIVER(),
            salt: op.jobSalt(p)
        });
    }

    function _vector(string memory name, Case memory c) internal returns (string memory) {
        AuthCaptureEscrow.PaymentInfo memory info = _paymentInfo(c);
        bytes32 hash = escrow.getHash(info);
        AuthCaptureEscrow.PaymentInfo memory agnostic = _paymentInfo(c);
        agnostic.payer = address(0);
        bytes32 nonce = escrow.getHash(agnostic);
        SidequestOperator.JobParams memory p = c.params;

        string memory key = name;
        vm.serializeString(key, "name", name);
        vm.serializeBytes32(key, "jobId", p.jobId);
        vm.serializeBytes32(key, "termsDigest", p.termsDigest);
        vm.serializeUint(key, "deliveryDeadline", p.deliveryDeadline);
        vm.serializeUint(key, "reviewWindow", p.reviewWindow);
        vm.serializeUint(key, "disputeWindow", p.disputeWindow);
        vm.serializeUint(key, "arbitrationWindow", p.arbitrationWindow);
        vm.serializeAddress(key, "arbitrator", p.arbitrator);
        vm.serializeAddress(key, "payer", c.payer);
        vm.serializeAddress(key, "receiver", c.receiver);
        vm.serializeString(key, "amount", vm.toString(uint256(c.amount)));
        vm.serializeBytes32(key, "deliveryHash", c.deliveryHash);
        vm.serializeUint(key, "workerShareBps", c.workerShareBps);
        vm.serializeUint(key, "authorizationExpiry", info.authorizationExpiry);
        vm.serializeString(key, "salt", vm.toString(info.salt));
        vm.serializeBytes32(key, "paymentInfoHash", hash);
        vm.serializeBytes32(key, "payerAgnosticHash", nonce);
        vm.serializeBytes32(key, "deliveryDigest", op.deliveryDigest(hash, c.deliveryHash));
        vm.serializeBytes32(key, "approvalDigest", op.approvalDigest(hash, c.deliveryHash));
        vm.serializeBytes32(key, "rejectionDigest", op.rejectionDigest(hash, c.deliveryHash));
        vm.serializeBytes32(key, "rulingDigest", op.rulingDigest(hash, c.workerShareBps));
        vm.serializeAddress(key, "delegate", c.delegate);
        vm.serializeUint(key, "delegationExpiry", c.delegationExpiry);
        vm.serializeBytes32(
            key, "deliveryDelegateDigest", op.deliveryDelegateDigest(hash, c.delegate, c.delegationExpiry)
        );
        return vm.serializeBytes32(key, "receiveWithAuthorizationDigest", _receiveDigest(info, nonce));
    }

    /// @dev The digest `MockERC3009Token.receiveWithAuthorization` checks for the collector's call.
    function _receiveDigest(AuthCaptureEscrow.PaymentInfo memory info, bytes32 nonce) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                info.payer,
                address(collector),
                uint256(info.maxAmount),
                uint256(0),
                uint256(info.preApprovalExpiry),
                nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }
}
