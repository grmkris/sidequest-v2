import { defineConfig } from '@x18n/core'

export default defineConfig({
  sourceLocale: 'en',
  locales: ['en', 'sl'],
  presets: ['react-intl', 'general'],
  resources: [{ pattern: 'packages/i18n/catalogs/{locale}.json' }],
  usage: {
    include: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    exclude: ['packages/i18n/src/**'],
    calls: [
      { callee: 'format', key: 1 },
      { callee: 'formatRich', key: 1 },
      // The website's shorthand for a message that takes no values (apps/web/src/Text.ts).
      { callee: 'say', key: 1 },
    ],
  },
  extract: {
    autoDetect: true,
    // Log events (`Sidequest.<Area> …`) are read by operators in Workers Logs, never shown to people.
    // `noopener noreferrer` is the `rel` of a link to a delivery, an attribute value rather than text.
    ignore: ['Sidequest', 'English', 'Slovenščina', '/^Sidequest\\.[A-Za-z]+/', 'noopener noreferrer'],
    ignoreByFile: {
      // The relayer's D1 store and the index's pages: SQL.
      'packages/server/src/Settlement/D1RelayerIntents.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/Pages.ts': ['/[\\s\\S]*/'],
      // The index's D1 tables: SQL, and the relay errors an outbox row records for operators.
      'packages/server/src/Index/EventStore.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/Outbox.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/Poller.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/RateLimiter.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/Listings.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/ChainFacts.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/JobEvents.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/Jobs.ts': ['/[\\s\\S]*/'],
      // The escrow's SQL, and the reasons it gives operators and API clients in the protocol's English.
      'packages/server/src/Escrow/**/*.ts': ['/[\\s\\S]*/'],
      // The EIP-712 type strings the operator and the escrow hash: part of the signed protocol, not text.
      'packages/settlement/src/Payment.ts': ['/^(JobParams|PaymentInfo)\\(/'],
      // The EIP-712 type strings of a wallet's link to a Nostr key, likewise signed protocol.
      'packages/nostr/src/WalletLinkTypedData.ts': ['/^(EIP712Domain|LinkNostrKey)\\(/'],
      // The EIP-712 type strings of the operator's `Delivery`, which an agent's key signs as a delivery's delegate.
      'packages/nostr/src/EvmKey.ts': ['/^(EIP712Domain|Delivery)\\(/'],
      // Contract ABIs generated from the Foundry build: Solidity type names, not text.
      'packages/settlement/src/abi/*.ts': ['/[\\s\\S]*/'],
      // What MCP tools share speaks to agents, in English like the protocol itself: their hints' descriptions.
      'packages/protocol/src/Tools.ts': ['/[\\s\\S]*/'],
      // The OAuth, MCP and D1 pieces the agent gateway serves with: OAuth's English, MCP's JSON-RPC errors and SQL.
      'packages/serving/src/**/*.ts': ['/[\\s\\S]*/'],
      // The agent gateway speaks to agents and MCP clients in English (tool descriptions, refusals, OAuth errors, SQL),
      // and its one page, the operator's OAuth consent, is English too; the website's agents page is translated.
      'apps/gateway/src/**/*.ts': ['/[\\s\\S]*/'],
      'apps/web/src/**/*.styles.ts': ['/[\\s\\S]*/'],
      'apps/web/src/GlobalStyles.ts': ['/[\\s\\S]*/'],
      'apps/web/src/zyzz.config.ts': ['/[\\s\\S]*/'],
    },
  },
  checks: { 'placeholder-mismatch': 'off', 'unused-key': 'info', 'hard-string': 'warning' },
})
