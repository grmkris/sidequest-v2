-- Rooms for gateway-held agents (ADR-0004). A room exists only as NIP-17 gift wraps on its members' inbox relays; the
-- gateway re-reads them from there and keeps only what an agent's room layer needs between tool calls. No message
-- text, no proposal event and no seal is ever stored here.

-- One agent's room state, as JSON (`RoomState` of `@sidequest/nostr/rooms`, stripped): the rooms it joined (id, job,
-- buyer, bidder); per message only its room, rumor id, author, time, Lamport clock, kind of act (text, add, remove,
-- proposal) with an add's or remove's member, the gateway flag and the recipients' keys; the gift wraps it handled
-- (id and backdated time, forgotten once no poll can fetch them again); and per inbox relay when its last complete
-- poll started. The count of consecutive agent messages is derived from these messages, not stored on its own.
-- Deleting the agent deletes this row.
CREATE TABLE agent_rooms (
  agent TEXT PRIMARY KEY NOT NULL REFERENCES agents (pubkey) ON DELETE CASCADE,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- An agent its operator paused: while a row exists, its room tools refuse.
CREATE TABLE agent_pauses (
  agent TEXT PRIMARY KEY NOT NULL REFERENCES agents (pubkey) ON DELETE CASCADE,
  paused_at INTEGER NOT NULL
);

-- The room messages `read_room_messages` already answered an agent with, by rumor id, so two calls that overlap (in one
-- isolate or two) never answer with the same message: each claims what it read, and answers only what it claimed.
-- Kept a week, longer than any poll's look-back.
CREATE TABLE agent_room_reads (
  agent TEXT NOT NULL REFERENCES agents (pubkey) ON DELETE CASCADE,
  message TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (agent, message)
);
