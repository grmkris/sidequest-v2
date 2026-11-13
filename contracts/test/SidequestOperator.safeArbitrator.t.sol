// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuthCaptureEscrow} from "commerce-payments/src/AuthCaptureEscrow.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {SidequestOperator} from "../src/SidequestOperator.sol";
import {OperatorTestBase} from "./utils/OperatorTestBase.sol";

/// @dev A k-of-n multisig that validates ERC-1271 signatures the way Safe's `CompatibilityFallbackHandler` does: the
///      digest is wrapped in the wallet's own `SafeMessage` EIP-712 domain, and either `threshold` owner signatures
///      (65 bytes each, owners strictly ascending) sign that wrapped hash, or, with an empty signature, the wallet
///      marked the wrapped hash signed on chain (Safe's `SignMessageLib`). It can also call any contract itself once
///      `threshold` owners signed the call (Safe's `execTransaction`). Not Safe's code: its validation rules.
contract SafeStyleMultisig is IERC1271 {
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(uint256 chainId,address verifyingContract)");
    bytes32 private constant SAFE_MSG_TYPEHASH = keccak256("SafeMessage(bytes message)");
    bytes32 private constant EXEC_TYPEHASH = keccak256("Exec(address to,bytes32 data,uint256 nonce)");

    mapping(address owner => bool isOwner) public isOwner;
    uint256 public immutable threshold;
    uint256 public nonce;
    mapping(bytes32 messageHash => bool signed) public signedMessages;

    error NotEnoughSignatures();
    error BadSigner(address recovered);
    error OnlySelf();
    error CallFailed(bytes returned);

    constructor(address[] memory owners, uint256 threshold_) {
        for (uint256 i; i < owners.length; ++i) {
            isOwner[owners[i]] = true;
        }
        threshold = threshold_;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, block.chainid, address(this)));
    }

    /// @notice The hash owners sign for an ERC-1271 check of `hash`.
    function messageHash(bytes32 hash) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(abi.encode(hash))));
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSeparator(), structHash));
    }

    /// @notice The hash owners sign to let the wallet call `to` with `data` at the current nonce.
    function execHash(address to, bytes calldata data) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(EXEC_TYPEHASH, to, keccak256(data), nonce));
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSeparator(), structHash));
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        bytes32 wrapped = messageHash(hash);
        if (signature.length == 0) return signedMessages[wrapped] ? IERC1271.isValidSignature.selector : bytes4(0);
        return _checkSignatures(wrapped, signature) ? IERC1271.isValidSignature.selector : bytes4(0);
    }

    /// @notice Marks `hash` signed on chain; only through `exec`, as Safe's `SignMessageLib` runs by delegatecall.
    function signMessage(bytes32 hash) external {
        if (msg.sender != address(this)) revert OnlySelf();
        signedMessages[messageHash(hash)] = true;
    }

    /// @notice Calls `to` with `data` as the wallet, once `threshold` owners signed `execHash(to, data)`.
    function exec(address to, bytes calldata data, bytes calldata signatures) external returns (bytes memory) {
        if (!_checkSignatures(execHash(to, data), signatures)) revert NotEnoughSignatures();
        ++nonce;
        (bool ok, bytes memory returned) = to.call(data);
        if (!ok) revert CallFailed(returned);
        return returned;
    }

    function _checkSignatures(bytes32 hash, bytes calldata signatures) internal view returns (bool) {
        if (signatures.length < threshold * 65) return false;
        address last = address(0);
        for (uint256 i; i < threshold; ++i) {
            (address recovered, ECDSA.RecoverError err,) =
                ECDSA.tryRecoverCalldata(hash, signatures[i * 65:(i + 1) * 65]);
            if (err != ECDSA.RecoverError.NoError || !isOwner[recovered] || recovered <= last) return false;
            last = recovered;
        }
        return true;
    }
}

/// @dev The contract accepts a contract arbitrator: `_requireAuthorized` checks ERC-1271 through OpenZeppelin's
///      `SignatureChecker` for any arbitrator with code, and accepts a direct call from it. These tests prove that a
///      Safe-style 2-of-3 multisig can rule in each way a Safe can sign, and that fewer than its threshold cannot.
contract SidequestOperatorSafeArbitratorTest is OperatorTestBase {
    uint256 internal ownerOnePk = 0x5AFE01;
    uint256 internal ownerTwoPk = 0x5AFE02;
    uint256 internal ownerThreePk = 0x5AFE03;
    SafeStyleMultisig internal safe;

    function setUp() public override {
        super.setUp();
        address[] memory owners = new address[](3);
        owners[0] = vm.addr(ownerOnePk);
        owners[1] = vm.addr(ownerTwoPk);
        owners[2] = vm.addr(ownerThreePk);
        safe = new SafeStyleMultisig(owners, 2);
    }

    /// @dev Two owners' signatures over `hash`, ordered by owner address as Safe requires.
    function _twoOf(bytes32 hash, uint256 aPk, uint256 bPk) internal pure returns (bytes memory) {
        (uint256 low, uint256 high) = vm.addr(aPk) < vm.addr(bPk) ? (aPk, bPk) : (bPk, aPk);
        return abi.encodePacked(_sign(low, hash), _sign(high, hash));
    }

    /// @dev A job funded, delivered and rejected whose arbitrator is the multisig.
    function _disputedUnderSafe() internal returns (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash) {
        SidequestOperator.JobParams memory params = _params();
        params.arbitrator = address(safe);
        pi = _paymentInfo(params, DEFAULT_AMOUNT);
        hash = _fund(pi, params);
        _deliver(pi);
        vm.prank(payer);
        op.reject(pi, "");
    }

    function test_safeArbitrator_rulesWithThresholdSignaturesRelayed() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash) = _disputedUnderSafe();
        bytes memory sigs = _twoOf(safe.messageHash(op.rulingDigest(hash, 6000)), ownerOnePk, ownerThreePk);
        vm.prank(relayer);
        op.rule(pi, 6000, sigs);
        (uint256 toReceiver, uint256 fee, uint256 refunded) = _split(DEFAULT_AMOUNT, 6000);
        assertEq(uint8(op.getJob(hash).outcome), uint8(SidequestOperator.Outcome.Ruled));
        assertEq(token.balanceOf(receiver), toReceiver);
        assertEq(token.balanceOf(treasury), fee);
        assertEq(token.balanceOf(payer), refunded);
    }

    function test_safeArbitrator_refusesBelowThreshold() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash) = _disputedUnderSafe();
        bytes memory one = _sign(ownerOnePk, safe.messageHash(op.rulingDigest(hash, 6000)));
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, address(safe)));
        vm.prank(relayer);
        op.rule(pi, 6000, one);
    }

    /// @dev One owner's key, or a key outside the wallet, is worth nothing on its own: a stolen single key cannot rule.
    function test_safeArbitrator_refusesAStrangerAsSecondSigner() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash) = _disputedUnderSafe();
        bytes memory sigs = _twoOf(safe.messageHash(op.rulingDigest(hash, 10_000)), ownerOnePk, strangerPk);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, address(safe)));
        op.rule(pi, 10_000, sigs);
    }

    /// @dev Owners must sign the wallet's wrapped message hash, not the operator's digest itself.
    function test_safeArbitrator_refusesSignaturesOverTheBareDigest() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash) = _disputedUnderSafe();
        bytes memory sigs = _twoOf(op.rulingDigest(hash, 6000), ownerOnePk, ownerTwoPk);
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, address(safe)));
        op.rule(pi, 6000, sigs);
    }

    function test_safeArbitrator_rulesByCallingItself() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash) = _disputedUnderSafe();
        bytes memory call = abi.encodeCall(SidequestOperator.rule, (pi, uint16(2500), bytes("")));
        safe.exec(address(op), call, _twoOf(safe.execHash(address(op), call), ownerTwoPk, ownerThreePk));
        assertEq(uint8(op.getJob(hash).outcome), uint8(SidequestOperator.Outcome.Ruled));
        assertEq(token.balanceOf(payer), DEFAULT_AMOUNT - DEFAULT_AMOUNT * 2500 / 10_000);
    }

    /// @dev Safe's on-chain message signing: the wallet marks the ruling's digest signed, then anyone relays the ruling
    ///      with an empty signature.
    function test_safeArbitrator_rulesWithAnOnChainSignedMessage() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash) = _disputedUnderSafe();
        bytes32 digest = op.rulingDigest(hash, 0);
        bytes memory call = abi.encodeCall(SafeStyleMultisig.signMessage, (digest));
        safe.exec(address(safe), call, _twoOf(safe.execHash(address(safe), call), ownerOnePk, ownerTwoPk));
        vm.prank(relayer);
        op.rule(pi, 0, "");
        assertEq(uint8(op.getJob(hash).outcome), uint8(SidequestOperator.Outcome.Ruled));
        assertEq(token.balanceOf(payer), DEFAULT_AMOUNT);
    }

    /// @dev A share the owners did not sign is refused even with an on-chain signed message for another share.
    function test_safeArbitrator_onChainMessageCoversOnlyItsShare() public {
        (AuthCaptureEscrow.PaymentInfo memory pi, bytes32 hash) = _disputedUnderSafe();
        bytes memory call = abi.encodeCall(SafeStyleMultisig.signMessage, (op.rulingDigest(hash, 0)));
        safe.exec(address(safe), call, _twoOf(safe.execHash(address(safe), call), ownerOnePk, ownerTwoPk));
        vm.expectRevert(abi.encodeWithSelector(SidequestOperator.Unauthorized.selector, address(safe)));
        op.rule(pi, 10_000, "");
    }
}
