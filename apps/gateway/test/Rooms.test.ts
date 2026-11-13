import { type PublicKey, publicKeyOf, type SecretKey } from '@sidequest/nostr'
import {
  defaultRoomOptions,
  emptyRoomState,
  foundingOf,
  localRoomSigner,
  makeNip17Rooms,
  RoomState,
} from '@sidequest/nostr/rooms'
import { jobRequest, RelayUrl } from '@sidequest/nostr/vocabulary'
import { webCrypto } from '@sidequest/protocol'
import { Crypto, Effect, Ref, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { connect, tool } from './Connect.ts'
import { freshKey, type Gateway, signed, withGateway } from './GatewayWorld.ts'

const now = () => Math.floor(Date.now() / 1000)
const relay = (name: string) => Schema.decodeSync(RelayUrl)(`wss://${name}.relay.test`)

/** A person's rooms in the test process, over the gateway's memory relays, as their browser would hold them. */
const personRooms = (gateway: Gateway, key: SecretKey) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const held = yield* Ref.make<RoomState>(emptyRoomState)
      return yield* makeNip17Rooms(
        {
          signer: localRoomSigner(key, webCrypto),
          relays: gateway.rooms.port,
          directory: { inboxRelays: (pubkey: PublicKey) => Effect.succeed(gateway.rooms.inbox.get(pubkey) ?? []) },
          store: { load: Ref.get(held), save: (next) => Ref.set(held, next) },
        },
        defaultRoomOptions,
      )
    }).pipe(Effect.provideService(Crypto.Crypto, webCrypto)),
  )

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

/** A buyer's request; its bidder is an operator whose agent (granted `discuss`) they add to their room. */
const setUp = async (gateway: Gateway) => {
  const operatorKey = freshKey()
  const buyerKey = freshKey()
  const agent = await gateway.createAgent(operatorKey)
  await gateway.grant(operatorKey, agent, ['discuss'])
  const { tokens } = await connect(gateway, operatorKey, agent)
  const request = signed(jobRequest, { title: 'Logo', description: 'For a café', expiresAt: now() + 86_400 }, buyerKey)
  gateway.core.events.push(request)
  const buyer = publicKeyOf(buyerKey)
  const operator = publicKeyOf(operatorKey)
  gateway.rooms.inbox.set(buyer, [relay('buyer')])
  gateway.rooms.inbox.set(operator, [relay('operator')])
  gateway.rooms.inbox.set(agent, [relay('agent')])
  const founding = foundingOf(request.id, buyer, operator)
  const ofBuyer = await personRooms(gateway, buyerKey)
  const ofOperator = await personRooms(gateway, operatorKey)
  await run(ofBuyer.create(founding))
  await run(ofOperator.create(founding))
  await run(ofOperator.add(founding.room, agent))
  const call = (name: string, args: object = {}) => tool(gateway, tokens.access_token, name, args)
  // A person's page polls before it sends, so it wraps for every member it knows of: the agent, once added.
  const say = (rooms: typeof ofBuyer, text: string) =>
    run(Effect.andThen(rooms.poll, rooms.send(founding.room, { _tag: 'Text', text })))
  return { operatorKey, agent, job: request.id, room: founding.room, ofBuyer, ofOperator, call, say }
}

describe('rooms for gateway agents', () => {
  test('an agent its operator added lists the room, reads what the buyer wrote, and answers', () =>
    withGateway(async (gateway) => {
      const { agent, job, room, ofBuyer, ofOperator, call, say } = await setUp(gateway)
      expect(await call('set_inbox_relays', { relays: ['wss://other.relay.test'] })).toMatchObject({
        ok: true,
        value: { relays: [relay('agent')], published: false },
      })
      expect(await call('list_rooms', { job })).toMatchObject({
        ok: true,
        value: { rooms: [{ room, job, member: true, turnsLeft: 6 }] },
      })
      await say(ofBuyer, 'Can you start Monday? secret-phrase-1')
      const read = await call('read_room_messages')
      expect(read).toMatchObject({
        ok: true,
        value: { messages: [{ room, kind: 'text', text: 'Can you start Monday? secret-phrase-1', viaGateway: false }] },
      })
      expect(await call('read_room_messages')).toMatchObject({ ok: true, value: { messages: [] } })
      const sent = await call('send_room_message', { room, text: 'Yes, Monday works.' })
      expect(sent).toMatchObject({ ok: true, value: { room, turnsLeft: 5 } })
      await run(ofBuyer.poll)
      const transcript = await run(ofBuyer.transcript(room))
      expect(transcript.messages.at(-1)).toMatchObject({
        author: agent,
        viaGateway: true,
        act: { _tag: 'Text', text: 'Yes, Monday works.' },
      })
      expect((await run(ofOperator.members(room))).members).toContain(agent)
      // What the gateway keeps holds no word anyone wrote, and no seal.
      const kept = JSON.stringify(gateway.sqlite.prepare('SELECT state FROM agent_rooms').all())
      expect(kept).toContain(room)
      expect(kept).not.toContain('secret-phrase-1')
      expect(kept).not.toContain('Monday')
      const stored = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ state: Schema.String })))(
        gateway.sqlite.prepare('SELECT state FROM agent_rooms').all(),
      )
      const messages = stored.flatMap(
        ({ state }) => Schema.decodeUnknownSync(Schema.fromJsonString(RoomState))(state).messages,
      )
      expect(messages.length).toBeGreaterThan(1)
      expect(messages.filter((message) => message.seal !== undefined)).toEqual([])
    }))

  test('the seventh agent message in a row is refused until a person writes', () =>
    withGateway(async (gateway) => {
      const { room, ofBuyer, call, say } = await setUp(gateway)
      for (const turn of [1, 2, 3, 4, 5, 6]) {
        expect(await call('send_room_message', { room, text: `turn ${turn}` })).toMatchObject({
          ok: true,
          value: { turnsLeft: 6 - turn },
        })
      }
      expect(await call('send_room_message', { room, text: 'one more' })).toMatchObject({
        ok: false,
        refusal: { reason: 'TurnLimit' },
      })
      await run(ofBuyer.poll)
      await say(ofBuyer, 'Go on.')
      expect(await call('send_room_message', { room, text: 'Thanks.' })).toMatchObject({
        ok: true,
        value: { turnsLeft: 5 },
      })
    }))

  test('a paused agent’s room tools refuse until its operator resumes it; no one else can pause it', () =>
    withGateway(async (gateway) => {
      const { operatorKey, agent, room, job, call } = await setUp(gateway)
      const path = `/api/agents/${agent}/pause`
      expect((await gateway.asOperator(freshKey(), 'POST', path)).status).toBe(404)
      expect(await gateway.asOperator(operatorKey, 'POST', path)).toMatchObject({
        status: 200,
        body: { agent, paused: true },
      })
      for (const [name, args] of [
        ['list_rooms', { job }],
        ['read_room_messages', {}],
        ['send_room_message', { room, text: 'hello' }],
      ] as const) {
        expect(await call(name, args)).toMatchObject({ ok: false, refusal: { reason: 'Paused' } })
      }
      expect(await gateway.asOperator(operatorKey, 'DELETE', path)).toMatchObject({ body: { paused: false } })
      expect(await call('send_room_message', { room, text: 'hello' })).toMatchObject({ ok: true })
    }))
})
