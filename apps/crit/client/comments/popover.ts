/**
 * Where the comment popover goes, as pure arithmetic over viewport coordinates. On a narrow screen it is a sheet along
 * the bottom edge. Otherwise it floats: beside what it comments on when there is room, so that stays readable, else
 * below it, else above it. A float is always inside the viewport, with its height capped to the room it has.
 */

export interface Box {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

export interface Size {
  readonly width: number
  readonly height: number
}

export type Placement =
  | { readonly mode: 'sheet'; readonly maxHeight: number }
  | { readonly mode: 'float'; readonly top: number; readonly left: number; readonly maxHeight: number }

/** At or under this width the popover is a bottom sheet. */
export const SHEET_WIDTH = 480
const MARGIN = 8
const GAP = 8
/** A float is never capped below this, so the composer always shows. */
const MIN_HEIGHT = 220

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, high))

const beside = (anchor: Box, size: Size, viewport: Size): Placement | undefined => {
  const right = anchor.left + anchor.width + GAP
  const left = anchor.left - GAP - size.width
  const fitsRight = right + size.width <= viewport.width - MARGIN
  if (!fitsRight && left < MARGIN) return undefined
  const maxHeight = viewport.height - 2 * MARGIN
  const height = Math.min(size.height, maxHeight)
  return {
    mode: 'float',
    top: clamp(anchor.top, MARGIN, Math.max(MARGIN, viewport.height - MARGIN - height)),
    left: fitsRight ? right : left,
    maxHeight,
  }
}

/** `anchor` and the result are in viewport coordinates; `size` is the popover's natural size. */
export const placePopover = (anchor: Box, size: Size, viewport: Size): Placement => {
  if (viewport.width <= SHEET_WIDTH) return { mode: 'sheet', maxHeight: Math.round(viewport.height * 0.7) }
  const side = beside(anchor, size, viewport)
  if (side !== undefined) return side
  const left = clamp(
    anchor.left + anchor.width - size.width,
    MARGIN,
    Math.max(MARGIN, viewport.width - MARGIN - size.width),
  )
  const bottom = anchor.top + anchor.height + GAP
  const below = viewport.height - MARGIN - bottom
  const above = anchor.top - GAP - MARGIN
  const under = below >= size.height || below >= above
  const maxHeight = Math.min(Math.max(under ? below : above, MIN_HEIGHT), viewport.height - 2 * MARGIN)
  const height = Math.min(size.height, maxHeight)
  const top = under ? Math.min(bottom, viewport.height - MARGIN - height) : anchor.top - GAP - height
  return { mode: 'float', top: Math.max(MARGIN, top), left, maxHeight }
}
