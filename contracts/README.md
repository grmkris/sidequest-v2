# Sidequest contracts

A Foundry workspace with one production contract, `SidequestOperator`: the `operator` of every Sidequest job escrowed in Coinbase's audited `AuthCaptureEscrow` v1.1 ([`base/commerce-payments`](https://github.com/base/commerce-payments)). The escrow holds the buyer's USDC; this contract decides, by fixed rules and signatures, when it is captured to the worker or voided back to the buyer. Specification: `docs/PHASE-1.md` → Settlement, and `docs/adr/0002-usdc-chains-and-escrow.md`.

## Trust statement

- **No owner, no admin, no upgrade, no `delegatecall`, no assembly** in `SidequestOperator` (the OpenZeppelin libraries it uses contain their own audited assembly). Every parameter is immutable or per job.
- **No key has discretion over funds outside its role.** The worker can only record a delivery, or delegate recording one payment's delivery to another key (below), which then can do exactly that and nothing else. The buyer can only approve (pay) or reject (dispute) a delivery. The job's arbitrator can only split a disputed job between worker and buyer, before its deadline. Everything else (settling after silence, refunding an undelivered job, refunding an unruled dispute) is a deadline anyone may trigger.
- **Funds only move to the receiver, the fee receiver or back to the payer.** The escrow sends captures to `PaymentInfo.receiver` and the fee to `PaymentInfo.feeReceiver` (forced to the immutable `FEE_RECEIVER`), and voids to `PaymentInfo.payer`. The operator never holds tokens and never calls the escrow's `refund` or `charge`.
- **Anyone may relay.** Every signed action accepts a signature from the named party (EOA or ERC-1271), or a direct call from that party.
- **The escrow is the backstop.** If nobody settles a job before the escrow's `authorizationExpiry`, the buyer can `reclaim` from the escrow directly. `fund` guarantees that expiry lies after every window of the job, so a reclaim never pre-empts a job still being settled.

## Design

### Binding the buyer's consent: one signature

The buyer signs exactly one thing: the ERC-3009 `ReceiveWithAuthorization` for the job's amount, which the escrow's `ERC3009PaymentCollector` redeems. Its `nonce` is the escrow's payer-agnostic hash of the whole `PaymentInfo` (operator, receiver, token, amount, expiries, fee bounds, fee receiver, salt, chain id and escrow address). `fund` additionally requires:

- `PaymentInfo.operator == address(this)`;
- `minFeeBps == maxFeeBps == FEE_BPS` and `feeReceiver == FEE_RECEIVER`;
- `PaymentInfo.salt == jobSalt(params)`, the EIP-712 struct hash of
  `JobParams(bytes32 jobId,bytes32 termsDigest,uint48 deliveryDeadline,uint32 reviewWindow,uint32 disputeWindow,uint32 arbitrationWindow,address arbitrator)`;
- `authorizationExpiry >= deliveryDeadline + reviewWindow + disputeWindow + arbitrationWindow + MARGIN` (`MARGIN` = 1 day), `deliveryDeadline` in the future, windows within bounds (review and dispute 1 h–14 d, arbitration 12 h–14 d), and an arbitrator that is neither payer nor receiver.

So every job parameter is inside the signed nonce, and a relayer can change nothing: altering any parameter changes the salt, the `PaymentInfo` hash, the nonce, and the signature no longer verifies. `jobId` is in the salt because `termsDigest` alone is not unique: two bidders can propose identical terms. A second EIP-712 signature over the job parameters would show them readably in a wallet, at the cost of a second prompt; we chose one signature and leave readability to the website, which must show the parameters it asks the buyer to sign.

The worker does not sign at funding. The worker's consent is `deliver`: before delivering, the worker (or the server on their behalf) must check the `JobFunded` event against the accepted agreement, including the arbitrator and windows. Delivering to a job with parameters you did not agree to is accepting them.

### Signatures for the other actions

EIP-712, domain `{name: "SidequestOperator", version: "1", chainId, verifyingContract}`, checked with OpenZeppelin's `SignatureChecker` (EOAs, and ERC-1271 for deployed contract wallets):

| Action             | Signer           | Type                                                                       |
| :----------------- | :--------------- | :------------------------------------------------------------------------- |
| `deliver`          | receiver         | `Delivery(bytes32 paymentInfoHash,bytes32 deliveryHash)`                   |
| `deliverDelegated` | receiver, once   | `DeliveryDelegate(bytes32 paymentInfoHash,address delegate,uint48 expiry)` |
|                    | and the delegate | `Delivery(bytes32 paymentInfoHash,bytes32 deliveryHash)` (EOA only)        |
| `approve`          | payer            | `Approval(bytes32 paymentInfoHash,bytes32 deliveryHash)`                   |
| `reject`           | payer            | `Rejection(bytes32 paymentInfoHash,bytes32 deliveryHash)`                  |
| `rule`             | arbitrator       | `Ruling(bytes32 paymentInfoHash,uint16 workerShareBps)`                    |

The named party may also call the function itself with an empty signature. `approve` and `reject` name the recorded delivery hash, so a buyer approves or rejects that delivery and no other.

### Delivery delegation

An agent should be able to record its operator's delivery unattended, without a wallet prompt per delivery. The receiver signs, once per payment, `DeliveryDelegate(paymentInfoHash, delegate, expiry)`; `deliverDelegated` then accepts a delivery signed by `delegate` (the same `Delivery` struct the receiver would sign) together with that delegation, strictly before `expiry` and the delivery deadline, while the job is `Funded`. It records exactly what `deliver` records and emits the unchanged `JobDelivered`, followed by `JobDeliveryDelegated(paymentInfoHash, delegate, delegationExpiry)`, so the logs show who signed.

- **Scope.** One payment (the hash is in the delegation) and one action: nothing but `deliverDelegated` reads a delegation, so a delegate can never approve, reject, rule, refund or move money, and a delegation is worthless on any other job. A junk delivery by a delegate (or by a thief of its key) is handled like a junk delivery by the receiver: the payer rejects within the review window and the arbitrator rules.
- **Signers.** The receiver's delegation is checked like every receiver signature (EOA or ERC-1271). The delegate is an EOA key, checked with `ecrecover` (OpenZeppelin `ECDSA`, low-s); no ERC-1271 call is made for a delegate. Either may instead call the function itself.
- **Revocation.** `revokeDeliveryDelegate(paymentInfoHash, delegate)` sets a flag under the caller's own address; `deliverDelegated` reads only the flag of the payment's receiver, so anyone may call it but only the receiver's call counts, and no `PaymentInfo` is needed (it works before funding, and from a contract wallet calling itself). We chose a per-payment, per-delegate flag over a receiver nonce: a nonce would have to be inside the signed struct and would revoke every delegation of the receiver at once, while the flag revokes exactly the delegation's scope and changes nothing a wallet signs. Revocation is permanent for that key and payment; delegate another key to resume. It takes effect once mined: a delegated delivery mined first stands.
- **Replay.** As for every action: the delegation and the delegate's signature are bound to the payment hash, this contract and chain, and become useless once the job leaves `Funded`.
- **Gas.** A relayed delegated delivery costs about 82 600 gas against 72 400 for a relayed direct one (a second `ecrecover`, one revocation read, one more event); a revocation about 46 000.

**Why no nonces are needed.** `paymentInfoHash` is unique forever: it includes the chain id and the escrow's address, and the escrow refuses to authorize the same hash twice. The domain binds this contract and chain. Each signed action is valid in exactly one status (`deliver` in `Funded`; `approve` and `reject` in `Delivered`; `rule` in `Disputed`) and every action moves the job out of that status; statuses only move forward. So each signature can take effect at most once, on one job, on one deployment. The tests replay every signature type, across jobs, across deployments, across chain ids and across types. Signatures carry no expiry: an unsubmitted signature stays usable until the job leaves the status it is valid in.

### State machine

Times are block timestamps; "before" means strictly before.

| Function            | Caller                                         | Requires                  | Time                                                    | Effect                                                                        |
| :------------------ | :--------------------------------------------- | :------------------------ | :------------------------------------------------------ | :---------------------------------------------------------------------------- |
| `fund`              | anyone, with payer's ERC-3009                  | `None`                    | before `deliveryDeadline` and `preApprovalExpiry`       | → `Funded`; escrow `authorize(maxAmount)`                                     |
| `deliver`           | receiver or their signature                    | `Funded`                  | before `deliveryDeadline`                               | → `Delivered`; records `deliveredAt`, `deliveryHash`                          |
| `deliverDelegated`  | anyone, with delegation + delegate's signature | `Funded`                  | before `deliveryDeadline` and the delegation's `expiry` | as `deliver`; also emits `JobDeliveryDelegated`                               |
| `approve`           | payer or their signature                       | `Delivered`               | any (capture needs `< authorizationExpiry`)             | → `Settled/Approved`; capture all                                             |
| `settleAfterReview` | anyone                                         | `Delivered`               | from `deliveredAt + reviewWindow`                       | → `Settled/AcceptedBySilence`; capture all                                    |
| `reject`            | payer or their signature                       | `Delivered`               | before `deliveredAt + reviewWindow`                     | → `Disputed`; records `rejectedAt`                                            |
| `rule`              | arbitrator or their signature                  | `Disputed`                | before `rejectedAt + disputeWindow + arbitrationWindow` | → `Settled/Ruled`; capture `workerShareBps`, void the rest                    |
| `settleUnruled`     | anyone                                         | `Disputed`                | from `rejectedAt + disputeWindow + arbitrationWindow`   | → `Settled/Unruled`; void all                                                 |
| `refundUndelivered` | anyone                                         | `Funded`                  | from `deliveryDeadline`                                 | → `Settled/Undelivered`; void all                                             |
| escrow `reclaim`    | payer (on the escrow)                          | anything still authorised | from `authorizationExpiry`                              | escrow returns all; the job stays non-terminal here, every later call reverts |

`Settled` is the only terminal status, and `outcome` records which of the five ways it was reached. The dispute window and the arbitration window run back to back after a rejection; the arbitrator may rule at any point in either.

**Unruled disputes refund the buyer.** If the arbitrator does not rule by the deadline, `settleUnruled` voids everything back to the payer. Reasons: it is what the escrow itself does when nobody acts (`reclaim` after expiry), so the default and the backstop agree; `void` has no expiry, so the default can never be raced away, while a default that captured would have to land before `authorizationExpiry`; and the rejected work is unpaid either way, which leaves the arbitrator's liveness, not the worker's, as the thing to fix. The cost: a buyer gains from a rejection whenever the arbitrator fails to act, so arbitrator liveness must be monitored.

### Fees and rounding

`FEE_BPS` (constructor, at most 2000; Sidequest uses 500) and `FEE_RECEIVER` are immutable and must equal the payment's fee bounds and fee receiver. A capture of `c` units pays `fee = floor(c × FEE_BPS / 10 000)` to the fee receiver and `c − fee` to the receiver, which is the only fee the escrow accepts when `minFeeBps == maxFeeBps`. A ruling captures `c = floor(amount × workerShareBps / 10 000)` and voids `amount − c`; rounding dust goes to the payer, the fee is proportional to the captured part only, and a share of 0 or a share that rounds to 0 captures nothing, a share of 10 000 voids nothing.

### Known limits

- **Liveness.** After silence, someone must call `settleAfterReview` before `authorizationExpiry`, or the buyer can reclaim delivered work. The gap is at least `disputeWindow + arbitrationWindow + MARGIN` (≥ 1 day 13 hours). The settlement saga must keep this as a scheduled job.
- **Token-level blocking.** USDC can block addresses. If the receiver or fee receiver is blocked, captures revert and the job falls back to the buyer's reclaim after expiry; if the payer is blocked, voids revert and funds wait in the escrow. `FEE_RECEIVER` is immutable: a blocked treasury degrades every job of that deployment to refunds.
- **Any ERC-3009 token** is accepted; the chain reader must check that the token is the expected USDC.
- **No early exits.** There is no mutual cancel and no worker-initiated refund before the deadline; a buyer who rejected cannot then approve.
- **ERC-6492** (undeployed smart wallets) works for the buyer's ERC-3009 signature, through the collector, but not for the EIP-712 actions here.
- **Delivery delegation is new and unaudited surface** (`deliverDelegated`, `revokeDeliveryDelegate`). What it risks: a stolen delegate key can record a junk delivery hash on the one payment it was delegated for, before the delegation's expiry, unless the receiver revoked it or delivered first; a receiver who delegated cannot then record a different delivery once the delegate's is mined. Nothing else: it moves no funds and no other action reads it. A revocation can be front-run by a delegated delivery already in the mempool. Delegates must be EOA keys.

## Layout

| Path                                      | What                                                                                      |
| :---------------------------------------- | :---------------------------------------------------------------------------------------- |
| `src/SidequestOperator.sol`               | The contract.                                                                             |
| `test/SidequestOperator.t.sol`            | Unit tests: every function, every revert, every signature variant, fee maths, ±1 s edges. |
| `test/SidequestOperator.delegation.t.sol` | Delivery delegation: every accept and refuse case, revocation, ERC-1271 receivers.        |
| `test/SidequestOperator.fuzz.t.sol`       | Fuzz tests on amounts, shares, windows and timings.                                       |
| `test/SidequestOperator.invariant.t.sol`  | Stateful fuzzing with a handler: conservation, one outcome per job, no stranger succeeds. |
| `test/fork/ArcTestnet.fork.t.sol`         | Arc testnet fork tests against the deployed escrow, collector and USDC.                   |
| `test/DeploySidequestOperator.t.sol`      | The deploy script refuses mainnets and reads its parameters from the environment.         |
| `script/DeploySidequestOperator.s.sol`    | Deployment, testnets only.                                                                |

## Running

Requires Foundry 1.8.3 (`foundryup -i 1.8.3`). From `contracts/`:

```sh
forge soldeer install          # fetch the pinned dependencies, verified against soldeer.lock
forge fmt --check
forge build --sizes
forge test                     # unit, fuzz and invariant; the fork suite skips itself
forge coverage --ir-minimum --report summary --no-match-coverage '(test|script|dependencies)/'
FOUNDRY_PROFILE=ci forge test  # more fuzz and invariant runs, as CI does
```

`forge coverage` needs `--ir-minimum`: without the IR pipeline `fund` is too deep for the legacy code generator.

### Fork tests (Arc testnet)

```sh
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network forge test --match-path 'test/fork/*'
```

Without `ARC_TESTNET_RPC_URL` the suite skips. With it, it checks that the deployed `AuthCaptureEscrow` (`0xf96815976523E00e65Be8f34cA5e64b4f41EB19c`), `ERC3009PaymentCollector` (`0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88`) and their `TokenStore` implementation are byte-for-byte the vendored v1.1.0 build, ignoring only the CBOR metadata (its IPFS hash covers source paths, which differ) and the immutables; then runs fund → deliver → approve, fund → delegated delivery → approve and fund → deliver → reject → rule with a fresh, locally signing payer and Arc's real USDC.

Arc's USDC is the native coin, with 18 decimals; the ERC-20 at `0x3600…0000` is a 6-decimal view over the same balance. The test funds the payer the Arc way, with `vm.deal(payer, amount × 10¹²)`, and asserts that the ERC-20 reports `amount`. Transfers in the ERC-20 call Arc's native-coin precompile at `0x1800…0000` (`transfer(from, to, amount18)`), which forge's local EVM does not implement, so the fork test installs a small shim there that moves native balance the same way. Everything else (escrow, collector, the USDC implementation and its ERC-3009 signature check) is the code deployed on Arc. The precompile itself is exercised only by a real testnet transaction, in the phase 1 testnet journey.

### Deploying (testnets only; not done in this slice)

```sh
SIDEQUEST_FEE_RECEIVER=0x… forge script script/DeploySidequestOperator.s.sol --rpc-url "$ARC_TESTNET_RPC_URL"            # simulate
SIDEQUEST_FEE_RECEIVER=0x… forge script script/DeploySidequestOperator.s.sol --rpc-url "$ARC_TESTNET_RPC_URL" --account <name> --broadcast
```

Optional: `SIDEQUEST_FEE_BPS` (default 500), `AUTH_CAPTURE_ESCROW`, `ERC3009_PAYMENT_COLLECTOR` (default the canonical v1.1 addresses). The script refuses any chain but Arc testnet (5042002), Base Sepolia (84532) and Anvil (31337), and refuses addresses with no code.

## Compiler

Solidity 0.8.28 (pinned, `pragma solidity 0.8.28`), EVM `cancun`, optimizer on with 100 000 runs, `via_ir = true`. These are the settings commerce-payments v1.1.0 deployed with (its `deploy` profile; the deployed metadata says 0.8.28), so the escrow the tests run against is the deployed one, as the fork test proves.

## Dependencies

Managed with [Soldeer](https://soldeer.xyz) (`forge soldeer`), not git submodules and not vendored into the repository: `foundry.toml` lists each dependency as a GitHub source archive of an exact commit, and `soldeer.lock` pins each archive's checksum. `dependencies/` is git-ignored and rebuilt by `forge soldeer install`.

| Dependency                            | Version | Commit                                     | Licence                                  | Used for                                                                                     |
| :------------------------------------ | :------ | :----------------------------------------- | :--------------------------------------- | :------------------------------------------------------------------------------------------- |
| `base/commerce-payments`              | v1.1.0  | `6b0a5ef3f0df973857f558e2d6b5dd645b5e97f9` | MIT (test mocks and `IERC3009`: GPL-3.0) | `AuthCaptureEscrow` types and calls; escrow, collector and `MockERC3009Token` in tests only. |
| `OpenZeppelin/openzeppelin-contracts` | v5.0.2  | `1edc2ae004974ebf053f4eba26b45469937b9381` | MIT                                      | The escrow's own imports, the version v1.1.0 pins (through `coinbase/spend-permissions`).    |
| `Vectorized/solady`                   | v0.1.1  | `5ea5d9f57ed6d24a27d00934f4a3448def931415` | MIT                                      | The escrow's own imports, the version v1.1.0 pins.                                           |
| `OpenZeppelin/openzeppelin-contracts` | v5.7.0  | `cab19933c33c2ad1d4c7a84864a3601dddfd16f3` | MIT                                      | `EIP712`, `SignatureChecker`, `ReentrancyGuardTransient` in `SidequestOperator`; test utils. |
| `foundry-rs/forge-std`                | v1.17.0 | `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` | MIT OR Apache-2.0                        | Tests and the deploy script.                                                                 |

The two OpenZeppelin releases are kept apart by a context remapping in `foundry.toml`: files under `dependencies/commerce-payments-1.1.0/` see v5.0.2, everything else sees v5.7.0. `SidequestOperator`'s compilation unit contains no GPL-3.0 file.
