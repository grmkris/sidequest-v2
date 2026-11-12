// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {AuthCaptureEscrow} from "commerce-payments/src/AuthCaptureEscrow.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

interface IERC3009Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @dev Signs ERC-3009 `ReceiveWithAuthorization` exactly as `ERC3009PaymentCollector` will redeem it, and raw digests.
abstract contract SigningKit {
    Vm private constant _VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev USDC's `RECEIVE_WITH_AUTHORIZATION_TYPEHASH`.
    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    AuthCaptureEscrow private _signingEscrow;
    address private _signingCollector;

    function _bindSigning(AuthCaptureEscrow escrow_, address collector_) internal {
        _signingEscrow = escrow_;
        _signingCollector = collector_;
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = _VM.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev The nonce the collector uses: the escrow hash of `pi` with `payer` zeroed.
    function _erc3009Nonce(AuthCaptureEscrow.PaymentInfo memory pi) internal view returns (bytes32) {
        address p = pi.payer;
        pi.payer = address(0);
        bytes32 nonce = _signingEscrow.getHash(pi);
        pi.payer = p;
        return nonce;
    }

    function _receiveDigest(address token, AuthCaptureEscrow.PaymentInfo memory pi) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                pi.payer,
                _signingCollector,
                uint256(pi.maxAmount),
                uint256(0),
                uint256(pi.preApprovalExpiry),
                _erc3009Nonce(pi)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", IERC3009Domain(token).DOMAIN_SEPARATOR(), structHash));
    }

    function _signReceive(uint256 pk, address token, AuthCaptureEscrow.PaymentInfo memory pi)
        internal
        view
        returns (bytes memory)
    {
        return _sign(pk, _receiveDigest(token, pi));
    }
}

/// @dev A minimal ERC-1271 smart account: valid iff its owner key signed the digest.
contract MockERC1271Wallet is IERC1271 {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) return IERC1271.isValidSignature.selector;
        return 0xffffffff;
    }
}
