// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IErc8004Identity, IErc8004Reputation, Erc8004Scenario} from "../erc8004/Erc8004Scenario.sol";

/// @dev The same scenario against the ERC-8004 registries deployed on Arc testnet (the reference implementation,
///      `getVersion()` 2.0.0, at the testnet vanity addresses), on a local fork: the calls the website and the index make
///      behave there as on the local stand-ins. Skipped unless `ARC_TESTNET_RPC_URL` is set.
contract Erc8004ArcTestnetForkTest is Erc8004Scenario {
    address internal constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    function setUp() public {
        string memory url = vm.envOr("ARC_TESTNET_RPC_URL", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        assertEq(block.chainid, 5_042_002);
        identity = IErc8004Identity(IDENTITY);
        reputation = IErc8004Reputation(REPUTATION);
    }
}
