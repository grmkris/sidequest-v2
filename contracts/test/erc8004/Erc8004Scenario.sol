// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

/// @dev The ERC-8004 calls Sidequest makes or reads, as the specification declares them
///      (ethereum/ERCs at commit 503591a6e80e6e1affdd6403341e25269141f046, ERCS/erc-8004.md), plus ERC-721's reads.
interface IErc8004Identity {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function setAgentURI(uint256 agentId, string calldata newURI) external;
    function getAgentWallet(uint256 agentId) external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
    function tokenURI(uint256 tokenId) external view returns (string memory);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function name() external view returns (string memory);
}

interface IErc8004Reputation {
    function getIdentityRegistry() external view returns (address);
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);
    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);
    function getClients(uint256 agentId) external view returns (address[] memory);
}

/// @dev What Sidequest relies on from an ERC-8004 deployment, run against the local registries
///      (`Erc8004Registries.t.sol`) and, on a fork, against the ones deployed on Arc testnet, so the local stand-ins
///      are held to the deployed behaviour.
abstract contract Erc8004Scenario is Test {
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    IErc8004Identity internal identity;
    IErc8004Reputation internal reputation;

    address internal operatorWallet = makeAddr("operator wallet");
    address internal buyerWallet = makeAddr("buyer wallet");
    string internal constant FILE =
        "https://sidequest.test/api/erc8004/agents/1111111111111111111111111111111111111111111111111111111111111111/registration";

    function test_theOperatorsWalletOwnsWhatItRegisters() public {
        vm.prank(operatorWallet);
        uint256 agentId = identity.register(FILE);
        assertEq(identity.ownerOf(agentId), operatorWallet);
        assertEq(identity.tokenURI(agentId), FILE);
        assertEq(identity.getAgentWallet(agentId), operatorWallet);
        assertEq(identity.name(), "AgentIdentity");
        assertEq(reputation.getIdentityRegistry(), address(identity));
    }

    function test_registeringEmitsTheIdTheWebsiteReads() public {
        vm.recordLogs();
        vm.prank(operatorWallet);
        uint256 agentId = identity.register(FILE);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 transfer = keccak256("Transfer(address,address,uint256)");
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == transfer) {
                assertEq(logs[i].topics[1], bytes32(0));
                assertEq(uint256(logs[i].topics[3]), agentId);
                assertEq(logs[i].emitter, address(identity));
                found = true;
            }
        }
        assertTrue(found);
    }

    function test_theOwnerMovesTheUriAndATransferMovesOwnership() public {
        vm.startPrank(operatorWallet);
        uint256 agentId = identity.register(FILE);
        identity.setAgentURI(agentId, "https://elsewhere.test/agent.json");
        identity.transferFrom(operatorWallet, buyerWallet, agentId);
        vm.stopPrank();
        assertEq(identity.tokenURI(agentId), "https://elsewhere.test/agent.json");
        assertEq(identity.ownerOf(agentId), buyerWallet);
        assertEq(identity.getAgentWallet(agentId), address(0));
    }

    function test_aClientGivesFeedbackWithoutAnyonesAuthorisation() public {
        vm.prank(operatorWallet);
        uint256 agentId = identity.register(FILE);
        bytes32 hash = keccak256("entry");
        vm.prank(buyerWallet);
        reputation.giveFeedback(agentId, 80, 0, "starred", "sidequest", "", "https://sidequest.test/f", hash);
        assertEq(reputation.getLastIndex(agentId, buyerWallet), 1);
        (int128 value, uint8 decimals, string memory tag1, string memory tag2, bool revoked) =
            reputation.readFeedback(agentId, buyerWallet, 1);
        assertEq(value, 80);
        assertEq(decimals, 0);
        assertEq(tag1, "starred");
        assertEq(tag2, "sidequest");
        assertFalse(revoked);
        assertEq(reputation.getClients(agentId)[0], buyerWallet);
    }

    function test_theOwnerCannotRateItsOwnAgent() public {
        vm.startPrank(operatorWallet);
        uint256 agentId = identity.register(FILE);
        vm.expectRevert();
        reputation.giveFeedback(agentId, 100, 0, "starred", "sidequest", "", "", bytes32(0));
        vm.stopPrank();
    }

    function test_feedbackNeedsARegisteredAgent() public {
        vm.prank(buyerWallet);
        vm.expectRevert();
        reputation.giveFeedback(type(uint128).max, 100, 0, "starred", "sidequest", "", "", bytes32(0));
    }
}
