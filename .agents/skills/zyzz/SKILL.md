---
name: zyzz
description: Style Styld v2's Foldkit views with zyzz — Gallery tokens, typed styles, global rules and the Foldkit adapter. Use before adding or changing any visual styling in apps/web, or when a zyzz type, lint or build error appears.
---

# zyzz in Styld v2

Styling is zyzz (`zyzz/vite` in `apps/web/vite.config.ts`). There is no hand-written CSS and no Tailwind. The visual system is Gallery: `DESIGN.md` at the repository root is the rule book for type, colour roles, controls and copy, and `docs/design/gallery/` is the clickable prototype it is written from.

## Where things live

- `apps/web/src/zyzz.config.ts` holds the tokens (`color`, `fontFamily`, `radius`) and the bound `style` helper with `output: 'html'`. It is the only place a literal colour or font family may appear. Add a token there before using a new value.
- `apps/web/src/GlobalStyles.ts` holds document defaults through `global` from `zyzz/web`. The Vite plugin discovers it; nothing imports it.
- Component styles live in a sibling `<View>.styles.ts` (for example `View.styles.ts` beside `View.ts`) as exported module-level `const name = style({...})` calls; shared ones, such as `primaryAction`, live in `Actions.styles.ts`. Keeping CSS values out of view modules lets x18n's hard-string check read views as pure copy.
- `apps/web/src/Styled.ts` turns an applied style into Foldkit attributes: `h.div(styled(h, card()), …)` or `[h.Id('x'), ...styled(h, card())]`. Combine styles with `cx(a(), b())` from `zyzz`; later arguments win.

## Rules

- Use token names for token-mapped properties (`color: 'ink2'`, `borderColor: 'rule'`, `borderRadius: 'pill'`). Write borders and outlines as longhands so the colour takes a token. Do not interpolate `vars.*` into template strings; typed lint rejects it.
- `!custom` marks a deliberate literal on a token-constrained property, such as `'transparent !custom'`. Keep it rare.
- Pass `style()` a literal object at module scope. Spreading imported records into a definition is outside zyzz's verified compiler scope.
- No dynamic inline declarations. The edge CSP is `style-src 'self'`, so an inline `style` attribute is a violation that browser acceptance fails on. Model state with variants or `data-*` selectors instead.
- Tests locate elements by role, text or landmark, never by generated class names.
- `bun run typecheck` rejects unknown properties, token names and value types; `bun run unused:production` reports unused styles; `bun run lint` runs `zyzz/valid-styles` for value markers such as a misplaced `!important`. zyzz's JSX and namespace rules cannot apply to Foldkit views.
- The CSS baseline is Chrome/Edge 123, Firefox 120 and Safari 17.5 (`build.cssTarget`); zyzz emits native nesting that older browsers drop.
- The token custom properties are never applied with `vars()`, so tokens resolve through their compiled fallbacks; the derived `inkHover` repeats its source literals.

## Reference

Read the docs before using an unfamiliar zyzz API: `https://zyzz.style/llms.txt` lists every page; each page has a Markdown URL ending in `.md`. The installed source is under `apps/web/node_modules/zyzz/src`. The relevant pages are Styling, Themes & Tokens, Conditions, Global Styles, `defineConfig`, `cx`, Runtime › Html and Integrations › Vite.
