import { parseAbi } from 'viem'

// ERC-8004's registries as the specification declares them (ethereum/ERCs 503591a, ERCS/erc-8004.md, CC0; vendored as
// packages/protocol/test/vectors/erc-8004.md), copied from its text and checked against it by
// `test/Erc8004Abi.test.ts`, with the ERC-721 reads the identity registry is (`ownerOf`, `tokenURI`, `Transfer`) and
// the reference implementation's `isAuthorizedOrOwner`, which the reputation registry calls.

/** The Identity Registry: ERC-721 tokens whose URI is an agent's registration file. */
export const erc8004IdentityAbi = parseAbi([
  'struct MetadataEntry { string metadataKey; bytes metadataValue; }',
  'function register(string agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId)',
  'function register(string agentURI) external returns (uint256 agentId)',
  'function register() external returns (uint256 agentId)',
  'function setAgentURI(uint256 agentId, string calldata newURI) external',
  'function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory)',
  'function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external',
  'function getAgentWallet(uint256 agentId) external view returns (address)',
  'function unsetAgentWallet(uint256 agentId) external',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)',
  'event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function tokenURI(uint256 tokenId) external view returns (string)',
  'function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
])

/** The Reputation Registry: clients' feedback on agents. */
export const erc8004ReputationAbi = parseAbi([
  'function getIdentityRegistry() external view returns (address identityRegistry)',
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2, string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash) external',
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external',
  'event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)',
  'function appendResponse(uint256 agentId, address clientAddress, uint64 feedbackIndex, string calldata responseURI, bytes32 responseHash) external',
  'event ResponseAppended(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, address indexed responder, string responseURI, bytes32 responseHash)',
  'function getSummary(uint256 agentId, address[] calldata clientAddresses, string tag1, string tag2) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
  'function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) external view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)',
  'function readAllFeedback(uint256 agentId, address[] calldata clientAddresses, string tag1, string tag2, bool includeRevoked) external view returns (address[] memory clients, uint64[] memory feedbackIndexes, int128[] memory values, uint8[] memory valueDecimals, string[] memory tag1s, string[] memory tag2s, bool[] memory revokedStatuses)',
  'function getResponseCount(uint256 agentId, address clientAddress, uint64 feedbackIndex, address[] responders) external view returns (uint64 count)',
  'function getClients(uint256 agentId) external view returns (address[] memory)',
  'function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64)',
])
