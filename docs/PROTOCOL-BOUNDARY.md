# Protocol boundary

This repository does not yet implement Sidequest v1 or v2 job behavior. The protocol package currently exposes only a foundation status contract.

The first records, from [ADR-0001](adr/0001-v2-scope.md) and track A of the [feature-port plan](FEATURE-PORT-PLAN.md), are WorkRequest, Proposal, Agreement, PaymentIntent, Receipt, AssetRef and NetworkRef. Delivery, Review, Dispute, room messages and settlement references follow. Each must be defined as a schema before any business operation uses it.

These rules hold for every record:

- Amounts are integers in an AssetRef's atomic units, with no implicit conversion.
- A message never amends an Agreement.
- A provider receipt, including Nod's, is a claim until Sidequest's own chain reader confirms it.
- Payment states are `prepared`, `approval_pending`, `submitted` and `confirmed`, with the outcomes `failed`, `expired`, `reorged` and `receipt_mismatch`. A refund is an escrow settlement outcome, not a payment state.
- A Nostr key never authorizes a payment.
