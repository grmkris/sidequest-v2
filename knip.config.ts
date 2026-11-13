import type { KnipConfig } from 'knip'

export default {
  workspaces: {
    '.': {
      entry: ['alchemy.run.ts!', 'tools/*.ts', 'tools/**/*.test.ts', '*.config.ts'],
      project: ['tools/**/*.ts', '*.ts'],
      ignoreDependencies: ['@effect/language-service'],
    },
    'apps/web': {
      entry: ['src/entry.ts!', 'src/entry.server.ts!', 'test/**/*.test.ts'],
      project: ['src/**/*.ts!', 'test/**/*.ts'],
      // A Foldkit page's Commands, Messages and union constructors are used by its own update and are the surface its
      // Story and Scene tests drive (FOLDKIT.md › Testing), so an export the module itself uses is not reported as
      // test-only; one nothing uses still is. The website only: the packages keep full unused-export detection.
      ignoreExportsUsedInFile: true,
      // `cloudflare:workers` is workerd's built-in module, which the server entry reads the Worker's bindings from;
      // it is no package to list.
      ignoreDependencies: ['cloudflare'],
    },
    ...Object.fromEntries(
      ['domain', 'observability', 'server', 'settlement'].map((name) => [
        `packages/${name}`,
        { project: ['src/**/*.ts!'] },
      ]),
    ),
    'packages/i18n': { project: ['src/**/*.ts!'] },
    'packages/protocol': { project: ['src/**/*.ts!'] },
    'packages/nostr': { project: ['src/**/*.ts!'] },
    'packages/fold': { project: ['src/**/*.ts!'] },
  },
  // Agents' git worktrees (`.claude/worktrees`) are other checkouts, not this one's sources.
  ignore: ['tools/oxlint/anti-slop/**', 'repos/**', '.claude/**'],
} satisfies KnipConfig
