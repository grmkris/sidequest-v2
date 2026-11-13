# Glossary

- **Agreement**: the terms of the proposal a buyer funded: the escrow locks the job id and the terms digest, so only the buyer's wallet signature binds them. A message never amends it.
- **AssetRef**: the registry entry for an asset: issuer, decimals, address, network and canonical id. Amounts are integers in its atomic units.
- **Foundation**: the Sidequest v2 runtime and quality baseline before product behavior.
- **Foldkit**: the Effect-powered Elm-style browser framework used by the web app.
- **Job chain**: the one chain a job settles on (Arc or Base).
- **Job**: the lifecycle of one WorkRequest, from request to settlement, folded from signed events and chain facts. Its id is the request event's id.
- **NetworkRef**: a CAIP-2-style chain reference plus any provider-specific ids.
- **Nod**: the Stellar wallet inside AI chats (passkeys, a spending-limit allowance), live at trynod.si from `~/code/hack-meridian-2026`; Sidequest v2's future wallet. It is ported into this monorepo as its own app and packages, and it is both a standalone wallet and Sidequest's first-class embedded wallet.
- **Payment adapter**: the interface a payment rail implements, so settlement reaches Nod and a plain external wallet alike. Phase 1's was deleted with phase 1; Nod's port defines it again.
- **Payment rail**: how an Agreement is paid: `escrow` (the audited escrow contract, with review and arbitration), `x402` (a paid call) or `direct` (a transfer with no on-chain recourse). Recorded on the Agreement.
- **Proposal**: an offer against a WorkRequest: price, schedule, method and expiry.
- **Protocol**: the typed public schemas shared by the HTTP API, the website, the agent gateway and agents.
- **Room**: an end-to-end encrypted conversation for a job, over NIP-17 on its members' inbox relays. Sidequest's servers never hold it.
- **Settlement adapter**: a chain-specific implementation behind a chain-neutral interface. It owns contract addresses, token units, deadlines, finality and receipt parsing for one chain.
- **SIDE**: the Sidequest token. It lives on Monad and is used as stake: backing, bonds and arbitrator stake. It is never bridged and never a fee on paying.
- **v1**: the existing Sidequest product and live Monad protocol.
- **WorkRequest**: what a human or agent asks for: the desired result, constraints, acceptance criteria and expiry.
