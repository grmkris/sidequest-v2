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
      // The D1 stores' and reads' text is SQL.
      'packages/server/src/Projections/**/*.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Reads/**/*.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Settlement/D1SettlementStores.ts': ['/[\\s\\S]*/'],
      // The index's D1 tables: SQL, and the relay errors an outbox row records for operators.
      'packages/server/src/Index/EventStore.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/Outbox.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/Poller.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/RateLimiter.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/Listings.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/ChainFacts.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/JobEvents.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Index/Jobs.ts': ['/[\\s\\S]*/'],
      // The EIP-712 type strings the operator and the escrow hash: part of the signed protocol, not text.
      'packages/settlement/src/Payment.ts': ['/^(JobParams|PaymentInfo)\\(/'],
      // The EIP-712 type strings of a wallet's link to a Nostr key, likewise signed protocol.
      'packages/nostr/src/WalletLinkTypedData.ts': ['/^(EIP712Domain|LinkNostrKey)\\(/'],
      // Contract ABIs generated from the Foundry build: Solidity type names, not text.
      'packages/settlement/src/abi/*.ts': ['/[\\s\\S]*/'],
      'packages/server/src/SignIn/Nonces.ts': ['/[\\s\\S]*/'],
      'packages/server/src/SignIn/Sessions.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Agents/AgentTokens.ts': ['/[\\s\\S]*/'],
      // The MCP contract and endpoint speak to agents, in English like the protocol itself: tool and parameter
      // descriptions, the server's instructions, next-action descriptions, and RFC 6750 bearer challenges. None of it
      // is shown to people by the website.
      'packages/protocol/src/Tools/*.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Mcp/**/*.ts': ['/[\\s\\S]*/'],
      // OAuth's endpoints answer MCP clients' developers in OAuth's English (RFC 6749 error descriptions) and their
      // SQL. The one text a person may see, a request so malformed it cannot be sent back to its client, is English too.
      'packages/server/src/OAuth/**/*.ts': ['/[\\s\\S]*/'],
      // The statement of the SIWE message a wallet signs: part of the signed protocol text, one English line for
      // everyone, like the rest of the EIP-4361 message around it.
      'packages/server/src/SignIn/Siwe.ts': ['/^Sign in to Sidequest\\.$/'],
      'apps/web/src/**/*.styles.ts': ['/[\\s\\S]*/'],
      'apps/web/src/GlobalStyles.ts': ['/[\\s\\S]*/'],
      'apps/web/src/zyzz.config.ts': ['/[\\s\\S]*/'],
    },
  },
  checks: { 'placeholder-mismatch': 'off', 'unused-key': 'info', 'hard-string': 'warning' },
})
