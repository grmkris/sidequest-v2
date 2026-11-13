// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Erc8004IdentityRegistry, Erc8004ReputationRegistry} from "./Erc8004Registries.sol";
import {IErc8004Identity, IErc8004Reputation, Erc8004Scenario} from "./Erc8004Scenario.sol";

/// @dev The local ERC-8004 registries, placed as the tests on Anvil place them: their runtime code at the testnet
///      deployment's addresses, with no constructor run, then `initialize`.
contract Erc8004RegistriesTest is Erc8004Scenario {
    address internal constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    function setUp() public {
        vm.etch(IDENTITY, address(new Erc8004IdentityRegistry()).code);
        vm.etch(REPUTATION, address(new Erc8004ReputationRegistry()).code);
        Erc8004ReputationRegistry(REPUTATION).initialize(IDENTITY);
        identity = IErc8004Identity(IDENTITY);
        reputation = IErc8004Reputation(REPUTATION);
    }

    function test_idsCountFromZero() public {
        vm.prank(operatorWallet);
        assertEq(identity.register(FILE), 0);
        vm.prank(buyerWallet);
        assertEq(identity.register(FILE), 1);
    }

    function test_initialisesOnce() public {
        vm.expectRevert(bytes("initialized"));
        Erc8004ReputationRegistry(REPUTATION).initialize(address(1));
    }
}
