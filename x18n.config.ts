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
    ignore: ['Sidequest', 'English', 'Slovenščina'],
    ignoreByFile: {
      'apps/web/src/**/*.styles.ts': ['/[\\s\\S]*/'],
      'apps/web/src/GlobalStyles.ts': ['/[\\s\\S]*/'],
      'apps/web/src/zyzz.config.ts': ['/[\\s\\S]*/'],
    },
  },
  checks: { 'placeholder-mismatch': 'off', 'unused-key': 'info', 'hard-string': 'warning' },
})
