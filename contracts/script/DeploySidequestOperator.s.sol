// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {SidequestOperator} from "../src/SidequestOperator.sol";

/// @notice Deploys `SidequestOperator`. Test networks are allowed; every other chain is refused unless the deploying
///         shell names it in an exact opt-in phrase. A dry run checks and prints everything and deploys nothing.
///
/// Environment:
/// - `SIDEQUEST_FEE_RECEIVER` (required): the treasury that receives every fee. Immutable once deployed. On a chain
///   that is not a test network it must be a contract (a Safe), never a key.
/// - `SIDEQUEST_FEE_BPS` (default 500): the fee in basis points. Immutable once deployed.
/// - `AUTH_CAPTURE_ESCROW` (default the canonical v1.1 deployment): the escrow.
/// - `ERC3009_PAYMENT_COLLECTOR` (default the canonical v1.1 deployment): the ERC-3009 collector.
/// - `SIDEQUEST_DEPLOY_DRY_RUN` (default false): check and print, never broadcast, return the zero address.
/// - `SIDEQUEST_ALLOW_MAINNET_DEPLOY` (unset): to deploy on a chain that is not a test network, exactly
///   `deploy SidequestOperator to mainnet chain <chain id>`, naming the chain the RPC answers for. Nothing else opts
///   in, and a phrase for one chain refuses every other. A dry run does not need it and says whether it is there.
///
/// Dry run (any chain; sends nothing, even with --broadcast):
///   SIDEQUEST_DEPLOY_DRY_RUN=true forge script script/DeploySidequestOperator.s.sol --rpc-url "$RPC_URL"
/// Simulate (sends nothing):
///   forge script script/DeploySidequestOperator.s.sol --rpc-url "$ARC_TESTNET_RPC_URL"
/// Broadcast (testnet, with a key you hold):
///   forge script script/DeploySidequestOperator.s.sol --rpc-url "$ARC_TESTNET_RPC_URL" --account <name> --broadcast
contract DeploySidequestOperator is Script {
    address internal constant CANONICAL_ESCROW = 0xf96815976523E00e65Be8f34cA5e64b4f41EB19c;
    address internal constant CANONICAL_COLLECTOR = 0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88;

    uint256 internal constant ARC_TESTNET = 5_042_002;
    uint256 internal constant BASE_SEPOLIA = 84_532;
    uint256 internal constant LOCAL_ANVIL = 31_337;

    /// @notice What a deployment would be: the chain, its parameters, and where the operator would land.
    struct Plan {
        uint256 chainId;
        bool testnet;
        bool mainnetOptIn;
        address escrow;
        address collector;
        uint16 feeBps;
        address feeReceiver;
        address deployer;
        address predicted;
    }

    /// @notice The chain is not a test network and the shell did not opt in to deploying on it.
    error ChainNotAllowed(uint256 chainId);

    /// @notice `SIDEQUEST_FEE_BPS` does not fit a `uint16` (the constructor caps it lower still).
    error FeeOutOfRange(uint256 feeBps);

    /// @notice No contract is deployed at a dependency address on this chain.
    error MissingCode(address account);

    /// @notice On a chain that is not a test network the immutable fee receiver must be a contract (a Safe), not a key.
    error TreasuryNotAContract(address feeReceiver);

    /// @notice Deploys with parameters from the environment, or on a dry run only checks and prints them.
    /// @return operator The deployed operator; the zero address on a dry run.
    function run() external returns (SidequestOperator operator) {
        bool dryRun = vm.envOr("SIDEQUEST_DEPLOY_DRY_RUN", false);
        if (!dryRun) requireAllowed(block.chainid, vm.envOr("SIDEQUEST_ALLOW_MAINNET_DEPLOY", string("")));
        Plan memory plan = planFromEnv();
        checkOnChain(plan);

        _print(plan, dryRun);
        if (dryRun) return SidequestOperator(address(0));

        vm.startBroadcast();
        operator = new SidequestOperator(plan.escrow, plan.collector, plan.feeBps, plan.feeReceiver);
        vm.stopBroadcast();
        console2.log("SidequestOperator", address(operator));
    }

    /// @notice The deployment the environment describes on the current chain; checks nothing on chain.
    /// @return plan What would be deployed.
    function planFromEnv() public view returns (Plan memory plan) {
        uint256 feeBpsRaw = vm.envOr("SIDEQUEST_FEE_BPS", uint256(500));
        if (feeBpsRaw > type(uint16).max) revert FeeOutOfRange(feeBpsRaw);
        plan.chainId = block.chainid;
        plan.testnet = isTestnet(block.chainid);
        plan.mainnetOptIn = optsIn(block.chainid, vm.envOr("SIDEQUEST_ALLOW_MAINNET_DEPLOY", string("")));
        plan.escrow = vm.envOr("AUTH_CAPTURE_ESCROW", CANONICAL_ESCROW);
        plan.collector = vm.envOr("ERC3009_PAYMENT_COLLECTOR", CANONICAL_COLLECTOR);
        // casting to 'uint16' is safe because the check above bounds it.
        // forge-lint: disable-next-line(unsafe-typecast)
        plan.feeBps = uint16(feeBpsRaw);
        plan.feeReceiver = vm.envAddress("SIDEQUEST_FEE_RECEIVER");
        // The address `vm.startBroadcast()` would deploy from, and so the operator's address at its next nonce.
        (, plan.deployer,) = vm.readCallers();
        plan.predicted = vm.computeCreateAddress(plan.deployer, vm.getNonce(plan.deployer));
    }

    /// @notice Reverts unless the escrow and collector are deployed here and, off test networks, the immutable fee
    ///         receiver is a contract (a Safe) rather than a key.
    /// @param plan The deployment to check.
    function checkOnChain(Plan memory plan) public view {
        if (plan.escrow.code.length == 0) revert MissingCode(plan.escrow);
        if (plan.collector.code.length == 0) revert MissingCode(plan.collector);
        if (!plan.testnet && plan.feeReceiver.code.length == 0) revert TreasuryNotAContract(plan.feeReceiver);
    }

    /// @notice Whether `chainId` is Arc testnet, Base Sepolia or a local Anvil chain.
    /// @param chainId The chain to check.
    /// @return True for a test network.
    function isTestnet(uint256 chainId) public pure returns (bool) {
        return chainId == ARC_TESTNET || chainId == BASE_SEPOLIA || chainId == LOCAL_ANVIL;
    }

    /// @notice The exact phrase that opts in to deploying on `chainId`.
    /// @param chainId The chain.
    /// @return The phrase.
    function optInPhrase(uint256 chainId) public pure returns (string memory) {
        return string.concat("deploy SidequestOperator to mainnet chain ", vm.toString(chainId));
    }

    /// @notice Whether `phrase` is exactly the opt-in for `chainId`.
    /// @param chainId The chain.
    /// @param phrase What the shell set.
    /// @return True only for the exact phrase.
    function optsIn(uint256 chainId, string memory phrase) public pure returns (bool) {
        return keccak256(bytes(phrase)) == keccak256(bytes(optInPhrase(chainId)));
    }

    /// @notice Reverts unless `chainId` is a test network, or `phrase` is exactly that chain's opt-in.
    /// @param chainId The chain to check.
    /// @param phrase `SIDEQUEST_ALLOW_MAINNET_DEPLOY` as set, or empty.
    function requireAllowed(uint256 chainId, string memory phrase) public pure {
        if (!isTestnet(chainId) && !optsIn(chainId, phrase)) revert ChainNotAllowed(chainId);
    }

    /// @notice Reverts unless `chainId` is a test network: the refusal without any opt-in.
    /// @param chainId The chain to check.
    function requireTestnet(uint256 chainId) public pure {
        requireAllowed(chainId, "");
    }

    function _print(Plan memory plan, bool dryRun) internal pure {
        console2.log(dryRun ? "DRY RUN: nothing is deployed" : "deploying");
        console2.log("chain id", plan.chainId);
        console2.log("test network", plan.testnet);
        if (!plan.testnet) {
            console2.log("mainnet opt-in present", plan.mainnetOptIn);
            console2.log("opt-in phrase", optInPhrase(plan.chainId));
        }
        console2.log("escrow", plan.escrow);
        console2.log("collector", plan.collector);
        console2.log("fee bps (immutable)", plan.feeBps);
        console2.log("fee receiver (immutable)", plan.feeReceiver);
        console2.log("deployer", plan.deployer);
        console2.log("operator address at the deployer's next nonce", plan.predicted);
    }
}
