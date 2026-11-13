import { publicKeyOf, type SecretKey } from '@sidequest/nostr'
import { foundingOf, RoomState } from '@sidequest/nostr/rooms'
import { jobRequest, RelayUrl } from '@sidequest/nostr/vocabulary'
import { Effect, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { connect, tool } from './Connect.ts'
import { freshKey, type Gateway, signed, withGateway } from './GatewayWorld.ts'
import { personRooms } from './MemoryRooms.ts'

const now = () => Math.floor(Date.now() / 1000)
const relay = (name: string) => Schema.decodeSync(RelayUrl)(`wss://${name}.relay.test`)

/** A person's rooms over the gateway's memory relays. */
const roomsOf = (gateway: Gateway, key: SecretKey) =>
  personRooms(key, gateway.rooms.port, (pubkey) => Effect.succeed(gateway.rooms.inbox.get(pubkey) ?? []))

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
  const ofBuyer = await roomsOf(gateway, buyerKey)
  const ofOperator = await roomsOf(gateway, operatorKey)
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
      // Listing the rooms claimed nothing: the read answers the add that let the agent in, then the buyer's text.
      expect(read).toMatchObject({
        ok: true,
        value: {
          messages: [
            { room, kind: 'add', member: agent },
            { room, kind: 'text', text: 'Can you start Monday? secret-phrase-1', viaGateway: false },
          ],
        },
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

  const ReadAnswer = Schema.Struct({
    value: Schema.Struct({
      messages: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.optional(Schema.String) })),
    }),
  })

  test('two reads that overlap never answer with the same message', () =>
    withGateway(async (gateway) => {
      const { ofBuyer, call, say } = await setUp(gateway)
      await say(ofBuyer, 'first')
      await say(ofBuyer, 'second')
      // Both calls load the agent's state before either stores it again.
      gateway.rooms.overlapReads(2)
      const reads = await Promise.all([call('read_room_messages'), call('read_room_messages')])
      const answered = reads.flatMap((read) => Schema.decodeUnknownSync(ReadAnswer)(read).value.messages)
      // The add that let the agent in, and the buyer's two messages: each answered once, by one of the two reads.
      expect(new Set(answered.map((message) => message.id)).size).toBe(answered.length)
      expect(answered.flatMap((message) => (message.text === undefined ? [] : [message.text])).toSorted()).toEqual([
        'first',
        'second',
      ])
    }))

  test('a message that arrives just before list_rooms or send_room_message still comes back from the next read', () =>
    withGateway(async (gateway) => {
      const { job, room, ofBuyer, call, say } = await setUp(gateway)
      await call('read_room_messages')
      await say(ofBuyer, 'before the list')
      expect(await call('list_rooms', { job })).toMatchObject({ ok: true, value: { rooms: [{ room, messages: 2 }] } })
      await say(ofBuyer, 'before the send')
      expect(await call('send_room_message', { room, text: 'Noted.' })).toMatchObject({ ok: true })
      const read = Schema.decodeUnknownSync(ReadAnswer)(await call('read_room_messages'))
      expect(read.value.messages.map((message) => message.text)).toEqual(['before the list', 'before the send'])
      expect(Schema.decodeUnknownSync(ReadAnswer)(await call('read_room_messages')).value.messages).toEqual([])
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
