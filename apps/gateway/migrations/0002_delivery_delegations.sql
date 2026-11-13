-- A worker's delegation of one job's on-chain delivery to their agent's key (`SidequestOperator.deliverDelegated`):
-- what the operator's wallet signed, `DeliveryDelegate(paymentInfoHash, delegate, expiry)` with the agent's EVM
-- address as delegate, and that expiry (Unix seconds). Only the signature and expiry: never a wallet key. The contract
-- checks the signature when the agent's delivery is relayed; deleting the row, or the agent, forgets it.
CREATE TABLE delivery_delegations (
  agent TEXT NOT NULL,
  job TEXT NOT NULL,
  operator TEXT NOT NULL,
  signature TEXT NOT NULL,
  expiry INTEGER NOT NULL,
  stored_at INTEGER NOT NULL,
  PRIMARY KEY (agent, job)
);
