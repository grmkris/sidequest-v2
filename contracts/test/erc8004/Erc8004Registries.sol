// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

/// @dev ERC-8004's Identity Registry, minimal, for local chains only: written here from the specification
///      (ethereum/ERCs at commit 503591a6e80e6e1affdd6403341e25269141f046, ERCS/erc-8004.md, vendored as
///      packages/protocol/test/vectors/erc-8004.md), not the reference implementation, whose licence is unclear and
///      which needs OpenZeppelin's upgradeable contracts (docs/adr/0007). It keeps the reference's observable choices
///      Sidequest relies on: the owner is `msg.sender`, ids count from 0, `agentWallet` starts as the owner and is
///      cleared on transfer, `name()`/`symbol()` are "AgentIdentity"/"AGENT". `setAgentWallet`'s signature check is
///      left out: Sidequest never sets it. Its state starts empty, so its runtime code may be placed at an address
///      with `anvil_setCode`, as the tests place it at the deployed testnet address.
contract Erc8004IdentityRegistry is ERC721URIStorage {
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    uint256 private lastId;
    mapping(uint256 agentId => mapping(string key => bytes value)) private metadata;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );

    constructor() ERC721("", "") {}

    function name() public pure override returns (string memory) {
        return "AgentIdentity";
    }

    function symbol() public pure override returns (string memory) {
        return "AGENT";
    }

    function register(string calldata agentURI, MetadataEntry[] calldata entries) external returns (uint256 agentId) {
        agentId = mint(agentURI);
        for (uint256 i = 0; i < entries.length; i++) {
            require(!isAgentWallet(entries[i].metadataKey), "reserved key");
            metadata[agentId][entries[i].metadataKey] = entries[i].metadataValue;
            emit MetadataSet(agentId, entries[i].metadataKey, entries[i].metadataKey, entries[i].metadataValue);
        }
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        return mint(agentURI);
    }

    function register() external returns (uint256 agentId) {
        return mint("");
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        require(isAuthorizedOrOwner(msg.sender, agentId), "not authorized");
        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        return metadata[agentId][metadataKey];
    }

    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external {
        require(isAuthorizedOrOwner(msg.sender, agentId), "not authorized");
        require(!isAgentWallet(metadataKey), "reserved key");
        metadata[agentId][metadataKey] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return address(bytes20(metadata[agentId]["agentWallet"]));
    }

    function unsetAgentWallet(uint256 agentId) external {
        require(isAuthorizedOrOwner(msg.sender, agentId), "not authorized");
        setWallet(agentId, address(0));
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) public view returns (bool) {
        address owner = _requireOwned(agentId);
        return _isAuthorized(owner, spender, agentId);
    }

    function mint(string memory agentURI) private returns (uint256 agentId) {
        agentId = lastId++;
        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);
        setWallet(agentId, msg.sender);
        emit Registered(agentId, agentURI, msg.sender);
    }

    function setWallet(uint256 agentId, address wallet) private {
        bytes memory value = wallet == address(0) ? bytes("") : abi.encodePacked(wallet);
        metadata[agentId]["agentWallet"] = value;
        emit MetadataSet(agentId, "agentWallet", "agentWallet", value);
    }

    function isAgentWallet(string memory key) private pure returns (bool) {
        return keccak256(bytes(key)) == keccak256("agentWallet");
    }

    /// @dev A transfer clears `agentWallet`, as the specification requires; a mint sets it after this runs.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0)) setWallet(tokenId, address(0));
    }
}

/// @dev ERC-8004's Reputation Registry, minimal, for local chains only, from the same specification text. Anyone may
///      give feedback but the agent's owner or an approved operator; `feedbackIndex` counts from 1 per client and
///      agent; `endpoint`, `feedbackURI` and `feedbackHash` are emitted and not stored. Responses and the summary's
///      aggregation are left out: Sidequest reads feedback back with `readFeedback`, `getLastIndex` and `getClients`.
contract Erc8004ReputationRegistry {
    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        bool isRevoked;
    }

    int128 private constant MAX_ABS_VALUE = 1e38;

    Erc8004IdentityRegistry private identity;
    mapping(uint256 agentId => mapping(address client => Feedback[])) private feedback;
    mapping(uint256 agentId => address[]) private clients;
    mapping(uint256 agentId => mapping(address client => bool)) private known;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);

    function initialize(address identityRegistry_) external {
        require(address(identity) == address(0), "initialized");
        identity = Erc8004IdentityRegistry(identityRegistry_);
    }

    function getIdentityRegistry() external view returns (address) {
        return address(identity);
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        require(valueDecimals <= 18, "valueDecimals");
        require(value <= MAX_ABS_VALUE && value >= -MAX_ABS_VALUE, "value");
        require(!identity.isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not allowed");
        if (!known[agentId][msg.sender]) {
            known[agentId][msg.sender] = true;
            clients[agentId].push(msg.sender);
        }
        feedback[agentId][msg.sender].push(Feedback(value, valueDecimals, tag1, tag2, false));
        uint64 index = uint64(feedback[agentId][msg.sender].length);
        emit NewFeedback(
            agentId, msg.sender, index, value, valueDecimals, tag1, tag1, tag2, endpoint, feedbackURI, feedbackHash
        );
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        require(feedbackIndex > 0 && feedbackIndex <= feedback[agentId][msg.sender].length, "index");
        feedback[agentId][msg.sender][feedbackIndex - 1].isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        require(feedbackIndex > 0 && feedbackIndex <= feedback[agentId][clientAddress].length, "index");
        Feedback storage found = feedback[agentId][clientAddress][feedbackIndex - 1];
        return (found.value, found.valueDecimals, found.tag1, found.tag2, found.isRevoked);
    }

    function getClients(uint256 agentId) external view returns (address[] memory) {
        return clients[agentId];
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return uint64(feedback[agentId][clientAddress].length);
    }
}
