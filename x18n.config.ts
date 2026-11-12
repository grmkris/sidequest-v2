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
    ],
  },
  extract: {
    autoDetect: true,
    // Log events (`Sidequest.<Area> …`) are read by operators in Workers Logs, never shown to people.
    ignore: ['Sidequest', 'English', 'Slovenščina', '/^Sidequest\\.[A-Za-z]+/'],
    ignoreByFile: {
      // The D1 stores' and reads' text is SQL.
      'packages/server/src/Projections/**/*.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Reads/**/*.ts': ['/[\\s\\S]*/'],
      'packages/server/src/Settlement/D1SettlementStores.ts': ['/[\\s\\S]*/'],
      // The EIP-712 type strings the operator and the escrow hash: part of the signed protocol, not text.
      'packages/settlement/src/Payment.ts': ['/^(JobParams|PaymentInfo)\\(/'],
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
