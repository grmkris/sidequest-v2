-- The names accounts go by, each person's jobs, and their own listings.

-- The name others see for each account, as the `AccountNames` projection last took it. A page names its counterparts
-- by account id and looks up every name it shows at once.
CREATE TABLE account_names (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1)
);

-- Every posted job's request and stage, for the lists of the accounts taking part in it. Like the other projections,
-- a change to a job not seen posted keeps its version in a row without a request.
CREATE TABLE party_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  buyer TEXT,
  title TEXT,
  expires_at INTEGER,
  state TEXT CHECK (
    state IS NULL OR state IN ('Open', 'Awarded', 'Funded', 'Delivered', 'Disputed', 'Settled', 'Cancelled', 'Expired')
  ),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((state IS NULL) = (buyer IS NULL) AND (buyer IS NULL) = (title IS NULL) AND (title IS NULL) = (expires_at IS NULL))
);

-- Who takes part in a job, one row per account: its buyer, each bidder, and the bidder who won it as its worker.
CREATE TABLE job_parties (
  account TEXT NOT NULL,
  job TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('buyer', 'bidder', 'worker')),
  PRIMARY KEY (account, job)
);
-- An account's jobs on one side, newest first.
CREATE INDEX job_parties_by_role ON job_parties (account, role, job);

-- A seller's own listings, newest first.
CREATE INDEX listings_by_owner_and_id ON listings (owner, id);
