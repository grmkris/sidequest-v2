# Glossary

- **Agreement**: the accepted terms of a job: deliverable, beneficiary, asset, amount, settlement network, deadline, payment mode and revision rules. A message never amends it.
- **AssetRef**: the registry entry for an asset: issuer, decimals, address, network and canonical id. Amounts are integers in its atomic units.
- **Foundation**: the Sidequest v2 runtime and quality baseline before product behavior.
- **Foldkit**: the Effect-powered Elm-style browser framework used by the web app.
- **Hosted room / sealed room**: a hosted room is the default and Sidequest can read it; a sealed room is end-to-end encrypted and opt-in.
- **Job**: the lifecycle of one WorkRequest, from request to settlement. `jobId` is the WorkRequest's id.
- **NetworkRef**: a CAIP-2-style chain reference plus any provider-specific ids.
- **Nod**: the Stellar wallet inside AI chats (passkeys, a spending-limit allowance), live at trynod.si from `~/code/hack-meridian-2026`; Sidequest v2's future wallet. It is ported into this monorepo as its own app and packages, and it is both a standalone wallet and Sidequest's first-class embedded wallet.
- **Payment adapter**: the `begin / lookup / cancel` interface every payment rail implements. Nod is one implementation; a plain external wallet is another.
- **Payment mode**: `direct` (the wallet pays the agent; no on-chain recourse, so review is feedback only) or `escrow` (the V2 contracts). Recorded on the Agreement.
- **Proposal**: an offer against a WorkRequest: price, schedule, method and expiry.
- **Protocol**: the typed public schemas shared by future HTTP, MCP and agent clients.
- **Room**: a Sidequest-hosted conversation for a job, shaped like Nostr (NIP-17 messages plus a room layer). The database is its authority; a relay is only a transport cache.
- **Settlement adapter**: a future chain-specific implementation behind a chain-neutral interface. It owns contract addresses, token units, deadlines, finality and receipt parsing for one chain.
- **SIDE**: the Sidequest token. Canonical on Monad, bridged to Base, and the only bond asset.
- **v1**: the existing Sidequest product and live Monad protocol.
- **WorkRequest**: what a human or agent asks for: the desired result, constraints, acceptance criteria and expiry.
