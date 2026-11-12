// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {SidequestOperator} from "../src/SidequestOperator.sol";

/// @notice Deploys `SidequestOperator` on a test network. Refuses every chain that is not on the testnet allowlist.
///
/// Environment:
/// - `SIDEQUEST_FEE_RECEIVER` (required): the treasury that receives every fee.
/// - `SIDEQUEST_FEE_BPS` (default 500): the fee in basis points.
/// - `AUTH_CAPTURE_ESCROW` (default the canonical v1.1 deployment): the escrow.
/// - `ERC3009_PAYMENT_COLLECTOR` (default the canonical v1.1 deployment): the ERC-3009 collector.
///
/// Simulate (sends nothing):
///   forge script script/DeploySidequestOperator.s.sol --rpc-url "$ARC_TESTNET_RPC_URL"
/// Broadcast (testnet only, with a key you hold):
///   forge script script/DeploySidequestOperator.s.sol --rpc-url "$ARC_TESTNET_RPC_URL" --account <name> --broadcast
contract DeploySidequestOperator is Script {
    address internal constant CANONICAL_ESCROW = 0xf96815976523E00e65Be8f34cA5e64b4f41EB19c;
    address internal constant CANONICAL_COLLECTOR = 0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88;

    uint256 internal constant ARC_TESTNET = 5_042_002;
    uint256 internal constant BASE_SEPOLIA = 84_532;
    uint256 internal constant LOCAL_ANVIL = 31_337;

    /// @notice The chain is not an allowed test network.
    error ChainNotAllowed(uint256 chainId);

    /// @notice `SIDEQUEST_FEE_BPS` does not fit a `uint16` (the constructor caps it lower still).
    error FeeOutOfRange(uint256 feeBps);

    /// @notice No contract is deployed at a dependency address on this chain.
    error MissingCode(address account);

    /// @notice Deploys with parameters from the environment.
    /// @return operator The deployed operator.
    function run() external returns (SidequestOperator operator) {
        requireTestnet(block.chainid);
        address escrow = vm.envOr("AUTH_CAPTURE_ESCROW", CANONICAL_ESCROW);
        address collector = vm.envOr("ERC3009_PAYMENT_COLLECTOR", CANONICAL_COLLECTOR);
        address feeReceiver = vm.envAddress("SIDEQUEST_FEE_RECEIVER");
        uint256 feeBpsRaw = vm.envOr("SIDEQUEST_FEE_BPS", uint256(500));
        if (feeBpsRaw > type(uint16).max) revert FeeOutOfRange(feeBpsRaw);
        // casting to 'uint16' is safe because the line above bounds it.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 feeBps = uint16(feeBpsRaw);
        if (escrow.code.length == 0) revert MissingCode(escrow);
        if (collector.code.length == 0) revert MissingCode(collector);

        vm.startBroadcast();
        operator = new SidequestOperator(escrow, collector, feeBps, feeReceiver);
        vm.stopBroadcast();

        console2.log("chain id", block.chainid);
        console2.log("SidequestOperator", address(operator));
        console2.log("escrow", escrow);
        console2.log("collector", collector);
        console2.log("fee bps", feeBps);
        console2.log("fee receiver", feeReceiver);
    }

    /// @notice Reverts unless `chainId` is Arc testnet, Base Sepolia or a local Anvil chain.
    /// @param chainId The chain to check.
    function requireTestnet(uint256 chainId) public pure {
        if (chainId != ARC_TESTNET && chainId != BASE_SEPOLIA && chainId != LOCAL_ANVIL) {
            revert ChainNotAllowed(chainId);
        }
    }
}
