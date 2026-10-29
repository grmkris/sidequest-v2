import foldkitRecommended from '@foldkit/oxlint-plugin/recommended.json' with { type: 'json' }
import { defineConfig } from 'oxlint'

const foldkitRules = (rules: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(rules).map(([rule, severity]) => {
      if (severity !== 'error' && severity !== 'off') throw new Error('Unrecognized Foldkit rule severity: ' + severity)
      return [rule, severity] as const
    }),
  )

export default defineConfig({
  ignorePatterns: [
    '**/dist/**',
    '**/.alchemy/**',
    '**/.wrangler/**',
    '.agents/**',
    '.claude/**',
    'repos/**',
    // The Gallery design prototype: reference HTML and its generator scripts (docs/design/gallery/README.md).
    'docs/design/**',
    'tools/oxlint/anti-slop/**',
  ],
  options: { typeAware: true, reportUnusedDisableDirectives: 'error' },
  categories: { correctness: 'error', suspicious: 'error' },
  plugins: ['typescript', 'unicorn', 'oxc', 'import', 'promise', 'vitest'],
  jsPlugins: [
    { name: 'foldkit', specifier: '@foldkit/oxlint-plugin' },
    './tools/oxlint/anti-slop/index.ts',
    './tools/oxlint/anti-slop/effect/index.ts',
    'oxlint-plugin-complexity',
    { name: 'zyzz', specifier: 'zyzz/oxlint' },
  ],
  env: { es2024: true },
  rules: {
    // zyzz's no-conflicting-props checks JSX and no-unused checks namespaces, neither of which Sidequest
    // uses; typecheck rejects unknown properties and tokens, and Knip reports unused styles.
    'zyzz/valid-styles': 'error',
    // @effect/vitest's it.effect is a test block too.
    'vitest/no-standalone-expect': ['error', { additionalTestBlockFunctions: ['it.effect', 'it.live', 'it.scoped'] }],
    'typescript/no-explicit-any': 'error',
    'typescript/no-floating-promises': ['error', { ignoreVoid: false }],
    'typescript/no-misused-promises': 'error',
    'typescript/switch-exhaustiveness-check': 'error',
    'typescript/only-throw-error': 'error',
    'typescript/no-unsafe-type-assertion': 'off',
    'typescript/consistent-return': 'off',
    'typescript/no-unsafe-argument': 'error',
    'typescript/no-unsafe-assignment': 'error',
    'typescript/no-unsafe-call': 'error',
    'typescript/no-unsafe-member-access': 'error',
    'typescript/no-unsafe-return': 'error',
    // Stylesheets are imported for their effect: the client entry imports the self-hosted font's CSS.
    'import/no-unassigned-import': ['error', { allow: ['**/*.css'] }],
    'no-console': 'error',
    'no-empty': 'error',
    'no-unused-vars': [
      'error',
      { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop-effect/no-manual-tag-comparison': 'error',
    'anti-slop-effect/no-manual-effect-error-tag': 'error',
    'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
    'max-depth': ['error', 4],
    'complexity/complexity': ['error', { cyclomatic: 1000, cognitive: 15 }],
  },
  overrides: [
    { files: ['apps/web/src/**/*.ts'], rules: foldkitRules(foldkitRecommended.rules) },
    ...foldkitRecommended.overrides.map(({ excludeFiles, files, rules }) => ({
      files: files.map((path) => 'apps/web/src/' + path),
      ...(excludeFiles === undefined ? {} : { excludeFiles: excludeFiles.map((path) => 'apps/web/src/' + path) }),
      rules: foldkitRules(rules),
    })),
    // Catalog data and types are regenerated and compared byte-for-byte by i18n:check.
    { files: ['packages/i18n/src/generated.ts', 'packages/i18n/src/catalog-*.ts'], rules: { 'max-lines': 'off' } },
    { files: ['tools/**'], rules: { 'no-console': 'off' } },
    { files: ['**/*.test.ts'], rules: { 'max-lines-per-function': 'off' } },
  ],
})
