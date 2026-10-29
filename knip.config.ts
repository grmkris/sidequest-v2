import type { KnipConfig } from 'knip'

export default {
  workspaces: {
    '.': {
      entry: ['alchemy.run.ts!', 'tools/*.ts', 'tools/**/*.test.ts', '*.config.ts'],
      project: ['tools/**/*.ts', '*.ts'],
      ignoreDependencies: ['@effect/language-service'],
    },
    'apps/web': { entry: ['src/entry.ts!', 'src/entry.server.ts!'], project: ['src/**/*.ts!'] },
    ...Object.fromEntries(
      ['auth', 'domain', 'observability', 'server'].map((name) => [`packages/${name}`, { project: ['src/**/*.ts!'] }]),
    ),
    'packages/db': { project: ['src/**/*.ts!'] },
    'packages/i18n': { project: ['src/**/*.ts!'] },
    'packages/protocol': { project: ['src/**/*.ts!'] },
  },
  ignore: ['tools/oxlint/anti-slop/**', 'repos/**'],
} satisfies KnipConfig
