import { JobView, Message, OpenRequest, Page, ProposalId, roomIdOf, RoomRef } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import type { McpClient } from 'effect/ai'
import { expect, test } from 'vitest'
import { artifactHash, buyerViewOf, named, postJob, recordFunding } from './Hire.ts'
import { ada, ben, origin, terms, withApi } from './HttpWorld.ts'
import { grantedAgent, mcpClient } from './McpWorld.ts'

// An agent's whole part in a hire, through Effect's own MCP client: Ben's agent, granted `discuss`, `propose` and
// `deliver`, finds Ada's open request, proposes, talks in the negotiation room and, once Ada accepted and (by the
// chain's report) funded, hands over the artifact. Ada uses the website's HTTP API throughout.

const url = 'https://files.example/logo.zip'

/** A tool's structured result as `schema` reads it, once `done` holds (views and projections follow eventually). */
const until = <A>(
  client: McpClient.McpClient,
  name: string,
  args: Record<string, unknown>,
  schema: Schema.Decoder<A>,
  done: (value: A) => boolean = () => true,
) =>
  Effect.gen(function* () {
    const tool = (yield* client.listTools()).find((listed) => listed.name === name)
    if (tool === undefined) return yield* Effect.die(new Error(`No tool ${name}`))
    for (let attempt = 1; ; attempt += 1) {
      const result = yield* client.callTool({ tool, arguments: args })
      if (result.isError === true) return yield* Effect.die(new Error(JSON.stringify(result.content)))
      const value = yield* Schema.decodeUnknownEffect(schema)(result.structuredContent).pipe(Effect.orDie)
      if (done(value) || attempt === 100) return value
      yield* Effect.sleep('20 millis')
    }
  })

/** A step a person takes over HTTP, between the agent's calls. */
const http = <A>(call: () => Promise<A>) => Effect.promise(call)

test(
  'an agent finds a request, proposes, talks with the buyer, and delivers once the job is funded',
  () =>
    withApi(async (api) => {
      const buyer = await api.signIn(ada)
      const worker = await api.signIn(ben)
      const { agent, token } = await grantedAgent(worker, ['discuss', 'propose', 'deliver'])
      const job = await postJob(buyer)
      const room = roomIdOf({ job, kind: 'negotiation', bidder: worker.account })

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* mcpClient(api, token)
            expect(client.protocolVersion).toBe('2026-07-28')
            expect(client.serverInfo?.name).toBe('sidequest')
            const open = yield* until(client, 'list_open_requests', {}, Page(OpenRequest), (page) =>
              page.items.some(({ id }) => id === job),
            )
            expect(open.items.find(({ id }) => id === job)?.buyer).toBe(buyer.account)
            yield* until(client, 'propose', { job, terms: terms() }, Schema.Struct({ proposal: ProposalId }))
            const rooms = yield* until(
              client,
              'list_rooms',
              { job },
              Schema.Struct({ rooms: Schema.Array(RoomRef) }),
              (shown) => shown.rooms.length === 1,
            )
            expect(rooms.rooms).toEqual([{ id: room, kind: 'negotiation', bidder: worker.account }])
            yield* until(client, 'send_message', { room, text: 'I can start on Monday.', key: 'm-1' }, Schema.Unknown)
            yield* http(() => buyer.post(`/api/rooms/${room}/messages`, { text: 'Monday works.', key: 'ada-1' }))
            const said = yield* until(
              client,
              'get_room',
              { room },
              Schema.Struct({ messages: Schema.Array(Message) }),
              (read) => read.messages.length === 2,
            )
            expect(said.messages).toEqual([
              { seq: 1, author: worker.account, agent, text: 'I can start on Monday.' },
              { seq: 2, author: buyer.account, text: 'Monday works.' },
            ])

            const [offer] = (yield* http(() => buyerViewOf(buyer, job))).proposals
            if (offer === undefined) return yield* Effect.die(new Error('No proposal arrived'))
            expect((yield* http(() => buyer.post(`/api/jobs/${job}/acceptance`, named(offer)))).status).toBe(204)
            const awarded = yield* http(() => buyerViewOf(buyer, job, (view) => view.state === 'Awarded'))
            const agreement = Option.getOrThrow(Option.fromNullishOr(awarded.agreement))
            yield* http(() => recordFunding(api, agreement))
            yield* http(() => buyerViewOf(buyer, job, (view) => view.state === 'Funded'))

            const won = yield* until(
              client,
              'get_job',
              { job },
              Schema.Struct({ job: JobView }),
              (shown) => shown.job.audience === 'bidder' && shown.job.view.outcome === 'won',
            )
            expect(won.job).toMatchObject({ audience: 'bidder', view: { bidder: worker.account, outcome: 'won' } })
            const delivered = yield* until(client, 'deliver', { job, artifactHash, url }, Schema.Unknown)
            expect(delivered).toMatchObject({
              job,
              nextAction: { kind: 'sign_delivery', actor: 'person', url: `${origin}/jobs/${job}` },
            })
          }),
        ),
      )
      const handedOver = await buyerViewOf(buyer, job, (view) => view.delivery !== null)
      expect(handedOver.delivery).toEqual({ job, artifactHash, url })
    }),
  20_000,
)
