-- The signed terms behind funded Nostr-native jobs (ADR-0003, decision 2): the chain holds only their digest, so the
-- request and every proposal the chain funded are kept for good. A row marks an event in `events` as permanent; any
-- future pruning of `events` must leave every event named here. `job` is the request's id; `role` says which of the
-- two the event is. Written by one idempotent statement from `chain_facts` and `events` (`Native/KeptTerms.ts`), never
-- deleted: a fact a reorganisation undid keeps its terms too.
CREATE TABLE kept_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  job TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('request', 'proposal'))
);
CREATE INDEX kept_events_by_job ON kept_events (job);
