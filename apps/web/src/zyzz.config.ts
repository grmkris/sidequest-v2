import { defineConfig } from 'zyzz'

/** Sidequest's tokens, light and dark. A cool mineral paper and a deep green-black ink keep every page quiet; the one
 * warm colour, the seal, is spent only on what a person is about to sign. Every colour is a `light-dark()` pair, so the
 * document's `color-scheme: light dark` (GlobalStyles.ts) picks one from the device without a script. Contrast is
 * checked against paper and stock in both schemes: text roles at least 4.5:1, edges at least 3:1. */
export const { style, vars } = defineConfig({
  id: 'sidequest',
  output: 'html',
  vars: {
    color: {
      // The page. Dark: a green-black night, never pure black.
      paper: { light: '#f2f4f1', dark: '#0f1513' },
      // Raised surfaces: fields, the request, a proposal. Dark: a step above the paper.
      stock: { light: '#ffffff', dark: '#18201d' },
      // Quiet fills: a hovered row, a chip, the room's own messages.
      wash: { light: '#e6ebe7', dark: '#222c28' },
      // Text and the primary fill. 15:1 on paper in both schemes.
      ink: { light: '#13201b', dark: '#e4ebe7' },
      // A hovered ink fill: ink mixed towards paper; repeats both literals, so change them together.
      inkHover: {
        light: 'color-mix(in oklab, #13201b 84%, #f2f4f1)',
        dark: 'color-mix(in oklab, #e4ebe7 84%, #0f1513)',
      },
      // Secondary text and meta: 6.9:1 on paper (light), 8.1:1 (dark).
      ink2: { light: '#47554f', dark: '#a8b5af' },
      // Hairlines and field edges: 3:1 against stock for fields (WCAG 1.4.11).
      rule: { light: '#8c9a94', dark: '#5b6a64' },
      // Dividers between rows, where an edge carries no meaning.
      hairline: { light: '#d6ddd9', dark: '#2a3531' },
      // Links and the selected state: a deep teal. 7.4:1 on paper (light), 8.9:1 (dark).
      signal: { light: '#0d5a49', dark: '#78d1b8' },
      // The seal: only the signing slip and its button. 5.2:1 on stock (light), 9.6:1 (dark).
      seal: { light: '#8a4f00', dark: '#f2b866' },
      sealWash: { light: '#fbf3e6', dark: '#2a2115' },
      // Text on an ink or seal fill.
      onInk: { light: '#ffffff', dark: '#0f1513' },
      // Refusals, rejection and withdrawal. 6.4:1 on stock (light), 7.5:1 (dark).
      danger: { light: '#a3261f', dark: '#ff9d92' },
      dangerWash: { light: '#fbecea', dark: '#2e1a18' },
      // Money that arrived: funded, paid.
      done: { light: '#1f6a3a', dark: '#86d6a0' },
      doneWash: { light: '#e9f4ec', dark: '#16261b' },
      // The keyboard focus ring: 5.8:1 on paper (light), 8.4:1 (dark).
      focus: { light: '#1f52d6', dark: '#8fb0ff' },
    },
    fontFamily: {
      // The system's own sans: no font file to wait for, and no layout shift when it would arrive.
      body: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', sans-serif",
      // Hashes, addresses and tokens: data people compare character by character.
      data: "ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', Menlo, monospace",
    },
    // The type scale, by role.
    fontSize: {
      display: 'clamp(30px, 22px + 2.6vw, 44px)',
      title: 'clamp(26px, 21px + 1.4vw, 32px)',
      heading: '20px',
      subheading: '17px',
      body: '16px',
      label: '14px',
      small: '13px',
      // The amount on a signing slip: the one large figure on a page.
      figure: 'clamp(32px, 24px + 2.4vw, 44px)',
      root: '1rem',
    },
    radius: { field: '10px', panel: '14px', pill: '999px', chip: '6px' },
    shadow: {
      // A panel resting just above the paper.
      lift: '0 1px 2px light-dark(oklch(0 0 0 / 0.06), oklch(0 0 0 / 0.4)), 0 6px 20px light-dark(oklch(0 0 0 / 0.04), oklch(0 0 0 / 0.3))',
    },
    ease: { standard: 'cubic-bezier(0.2, 0, 0, 1)' },
    transitionDuration: { press: '120ms', hover: '160ms' },
  },
})
