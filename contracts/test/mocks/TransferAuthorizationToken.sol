// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockERC3009Token} from "commerce-payments/test/mocks/MockERC3009Token.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";

/// @notice Test only: commerce-payments' ERC-3009 mock with USDC's `transferWithAuthorization` added, which the x402
/// `exact` scheme on EVM settles through (any relayer may submit it, unlike `receiveWithAuthorization`). The TypeScript
/// tests of the x402 rail place it at Arc testnet's USDC address on Anvil. Never deployed anywhere else.
contract TransferAuthorizationToken is MockERC3009Token {
    /// @dev keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256
    /// validBefore,bytes32 nonce)"), as USDC defines it.
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    mapping(address => mapping(bytes32 => bool)) private _transferAuthorizations;

    constructor() MockERC3009Token("USD Coin", "USDC", 6) {}

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        require(!_transferAuthorizations[from][nonce], "TransferAuthorizationToken: authorization is used");
        require(block.timestamp > validAfter, "TransferAuthorizationToken: authorization not yet valid");
        require(block.timestamp < validBefore, "TransferAuthorizationToken: authorization expired");
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        require(
            SignatureCheckerLib.isValidSignatureNow(from, digest, signature),
            "TransferAuthorizationToken: invalid signature"
        );
        _transferAuthorizations[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function transferAuthorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _transferAuthorizations[authorizer][nonce];
    }
}
