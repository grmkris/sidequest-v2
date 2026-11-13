// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuthCaptureEscrow} from "commerce-payments/src/AuthCaptureEscrow.sol";

import {DeployedCode} from "../utils/DeployedCode.sol";

interface IUsdcDomain {
    function name() external view returns (string memory);
    function version() external view returns (string memory);
    function decimals() external view returns (uint8);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @dev Read-only checks against Base mainnet (chain 8453) that a production stage on Base would rely on: the escrow
///      and collector at the addresses `packages/settlement` pins are commerce-payments v1.1.0 as vendored here, and
///      USDC's EIP-712 domain is the one its configuration names. Nothing is deployed or signed; skipped unless
///      `BASE_MAINNET_RPC_URL` is set.
contract BaseMainnetForkTest is DeployedCode {
    uint256 internal constant BASE_MAINNET_CHAIN_ID = 8453;
    AuthCaptureEscrow internal constant ESCROW = AuthCaptureEscrow(0xf96815976523E00e65Be8f34cA5e64b4f41EB19c);
    address internal constant COLLECTOR = 0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88;
    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    IUsdcDomain internal constant USDC = IUsdcDomain(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);

    function setUp() public {
        string memory rpc = vm.envOr("BASE_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "BASE_MAINNET_RPC_URL is not set");
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, BASE_MAINNET_CHAIN_ID, "not Base mainnet");
    }

    function test_fork_deployedBytecodeMatchesVendoredV110() public view {
        _assertCommercePaymentsV110(ESCROW, COLLECTOR, MULTICALL3);
    }

    /// @dev Base mainnet USDC's domain name is "USD Coin", not Arc's "USDC": a stage on Base must not reuse Arc's.
    function test_fork_usdcDomain() public view {
        assertEq(USDC.name(), "USD Coin");
        assertEq(USDC.version(), "2");
        assertEq(USDC.decimals(), 6);
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USD Coin"),
                keccak256("2"),
                BASE_MAINNET_CHAIN_ID,
                address(USDC)
            )
        );
        assertEq(USDC.DOMAIN_SEPARATOR(), expected);
    }
}
