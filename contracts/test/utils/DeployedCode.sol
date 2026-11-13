// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuthCaptureEscrow} from "commerce-payments/src/AuthCaptureEscrow.sol";

/// @dev Compares contracts deployed on a forked chain with this workspace's build of the vendored sources.
abstract contract DeployedCode is Test {
    /// @dev The deployed escrow, collector and token store are commerce-payments v1.1.0 as vendored here, built with
    ///      this workspace's settings: identical except for the CBOR metadata (source paths differ, so the IPFS hash
    ///      does) and the immutables, which are masked.
    function _assertCommercePaymentsV110(AuthCaptureEscrow escrow, address collector, address multicall3)
        internal
        view
    {
        address tokenStoreImpl = escrow.tokenStoreImplementation();
        _assertSameCode(
            "AuthCaptureEscrow.sol:AuthCaptureEscrow", address(escrow), _one(tokenStoreImpl), "AuthCaptureEscrow"
        );
        _assertSameCode(
            "ERC3009PaymentCollector.sol:ERC3009PaymentCollector",
            collector,
            _two(address(escrow), multicall3),
            "ERC3009PaymentCollector"
        );
        _assertSameCode("TokenStore.sol:TokenStore", tokenStoreImpl, _one(address(escrow)), "TokenStore");
    }

    function _assertSameCode(string memory artifact, address deployed, address[] memory immutables, string memory name)
        internal
        view
    {
        bytes memory local = _stripMetadata(vm.getDeployedCode(artifact));
        bytes memory live = _stripMetadata(deployed.code);
        for (uint256 i; i < immutables.length; ++i) {
            _zeroOccurrences(live, immutables[i]);
        }
        assertEq(live.length, local.length, string.concat(name, ": length"));
        assertEq(keccak256(live), keccak256(local), string.concat(name, ": bytecode"));
    }

    /// @dev Drops the trailing CBOR metadata, whose length is the code's last two bytes.
    function _stripMetadata(bytes memory code) internal pure returns (bytes memory out) {
        uint256 metaLength = (uint256(uint8(code[code.length - 2])) << 8) | uint8(code[code.length - 1]);
        out = new bytes(code.length - metaLength - 2);
        for (uint256 i; i < out.length; ++i) {
            out[i] = code[i];
        }
    }

    /// @dev Zeroes every occurrence of `value`; the compiler leaves immutables as zeros in the artifact.
    function _zeroOccurrences(bytes memory code, address value) internal pure {
        bytes20 needle = bytes20(value);
        for (uint256 i; i + 20 <= code.length; ++i) {
            bool hit = true;
            for (uint256 k; k < 20 && hit; ++k) {
                hit = code[i + k] == needle[k];
            }
            if (hit) {
                for (uint256 k; k < 20; ++k) {
                    code[i + k] = 0;
                }
            }
        }
    }

    function _one(address a) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = a;
    }

    function _two(address a, address b) internal pure returns (address[] memory list) {
        list = new address[](2);
        list[0] = a;
        list[1] = b;
    }
}
