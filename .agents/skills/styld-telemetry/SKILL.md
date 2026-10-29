---
name: styld-telemetry
description: Add or review traces, logs and browser telemetry in Styld v2 — Effect-native spans, the bounded metadata seam, the browser relay and Workers Logs queries. Use when instrumenting an operation, adding a log field or span attribute, touching packages/observability or BrowserTelemetry.ts, or investigating behaviour in a deployed preview.
---

# Telemetry in Styld v2

Telemetry is Effect from the browser to the Durable Objects. Instrument only through Effect; application code never calls a vendor or `cloudflare:workers` tracing API.

## How it flows

- **Browser.** `apps/web/src/Telemetry.ts` wraps the Foldkit program with Maple's Foldkit layer: Command spans under a `pageload`/`navigate` parent, crash and slow-phase spans. Effect's `HttpClient` sends `traceparent` on API calls. Spans go as OTLP/JSON to `/api/telemetry/v1/traces` on the same origin; no ingest key exists.
- **Relay.** `packages/server/src/BrowserTelemetry.ts` admits same-origin JSON with a declared length of at most 1 MiB and a per-IP rate allowance (120 a minute, `TELEMETRY_RATE_LIMIT` binding), decodes spans one by one, keeps the attribute and `exception`-event allowlist (a `Map`, with length caps) and logs at most 100 `styld.browser.span` records per request. Logs, metrics and the SDK's session events are acknowledged and dropped; the browser reduces every URL to origin and route (`sanitizeUrl`) and masks element text.
- **Server.** `Cloudflare.Telemetry` provides native traces; `withObservability` in `@styld/observability` adds one named span and the bounded `styld.*` fields to every request, including `styld.browser.trace_id` from a valid `traceparent`. Request handlers log with `Logger.consoleStructured` (set per request: Alchemy's bridge defaults to `consolePretty`, which arrives as one string), so Workers Logs indexes each field under `annotations.*`.

## Rules

- Name reusable operations with `Effect.fn('Styld.<Area>.<operation>')`; add context with `Effect.annotateCurrentSpan`/`Effect.annotateLogs` using `styld.*` keys of bounded cardinality.
- New metadata fields go through `ObservabilityMetadata` with a schema and a test. Never derive operation, job or attempt labels from request headers.
- Never record tokens, cookies, signed URLs, prompts, images, request bodies, emails or free text typed by a user. Browser Command arguments stay off (`commandArgs: 'none'`); navigation names use fixed routes (`routeName`), and the relay drops `url.path`/`url.full`, which the SDK records verbatim.
- A new browser attribute needs an entry in the relay allowlist with a length cap and a privacy review, plus a case in `packages/server/test/BrowserTelemetry.test.ts`. Keep replay, session rows and visitor IDs off unless Kris decides otherwise.
- Telemetry is sampled diagnostics, never the usage or billing ledger; that lives in the Wallet aggregate.
- Browser acceptance asserts a trace export reaches the relay (204) and that no telemetry body contains credentials. Keep both when changing the flow.

## Investigating a deployed preview

Query Workers Logs for the API Worker (`styldappv2-styldworker-preview-*`) through the Cloudflare MCP or the Workers Observability API: filter `message` = `styld.browser.span` and group by `styld.browser.span`, or join by `styld.browser.trace_id` with the server's `styld.http` logs. Retention is 3 days on the free plan and 7 days on paid. The `workers-best-practices` and `effect` skills cover runtime and Effect details.
