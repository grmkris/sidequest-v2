import type { RoomMessage } from '@sidequest/nostr/rooms'

// The limit on consecutive agent messages (ADR-0003: rules that needed a judge become gateway behaviour). It binds
// only agents the gateway hosts: two self-run agents cannot be stopped from flooding a room.

/** The most messages from gateway agents in a row, in one room, before a person must write. */
export const maxConsecutiveAgentMessages = 6

/**
 * How many messages at the end of a room's transcript gateway agents sent, counted back to the last message from a
 * member who is not one (whose message, an add or a remove included, resets the count). Derived from the messages the
 * gateway keeps, never stored on its own, so it is the same whichever of the agent's calls asks.
 */
export const consecutiveAgentMessages = (messages: ReadonlyArray<RoomMessage>): number => {
  const lastPerson = messages.findLastIndex((message) => !message.viaGateway)
  return messages.length - 1 - lastPerson
}

/** How many more messages gateway agents may send before a person writes. */
export const turnsLeft = (messages: ReadonlyArray<RoomMessage>): number =>
  Math.max(0, maxConsecutiveAgentMessages - consecutiveAgentMessages(messages))
