import { describe, expect, it } from 'vitest'
import { placePopover, SHEET_WIDTH } from '../client/comments/popover.ts'

const size = { width: 380, height: 500 }
const desktop = { width: 1440, height: 900 }
const bottomOf = (placed: ReturnType<typeof placePopover>): number =>
  placed.mode === 'float' ? placed.top + Math.min(size.height, placed.maxHeight) : Number.NaN

describe('placePopover', () => {
  it('is a bottom sheet on a narrow screen, capped to part of the screen', () => {
    expect(placePopover({ top: 400, left: 20, width: 300, height: 40 }, size, { width: 390, height: 844 })).toEqual({
      mode: 'sheet',
      maxHeight: 591,
    })
    expect(
      placePopover({ top: 0, left: 0, width: 10, height: 10 }, size, { width: SHEET_WIDTH, height: 800 }).mode,
    ).toBe('sheet')
  })

  it('sits beside the anchor when there is room, leaving it uncovered', () => {
    const anchor = { top: 496, left: 170, width: 700, height: 60 }
    const placed = placePopover(anchor, size, desktop)
    expect(placed).toMatchObject({ mode: 'float', left: 878 })
    expect(bottomOf(placed)).toBeLessThanOrEqual(desktop.height - 8)
  })

  it('goes to the left when only that side has room', () => {
    const placed = placePopover({ top: 100, left: 600, width: 800, height: 40 }, size, desktop)
    expect(placed).toMatchObject({ mode: 'float', left: 212, top: 100 })
  })

  it('goes below a full-width anchor near the top, and stays on screen', () => {
    const placed = placePopover({ top: 80, left: 20, width: 1400, height: 40 }, size, desktop)
    expect(placed).toMatchObject({ mode: 'float', top: 128 })
    expect(bottomOf(placed)).toBeLessThanOrEqual(desktop.height - 8)
  })

  it('flips above a full-width anchor near the bottom', () => {
    const anchor = { top: 700, left: 20, width: 1400, height: 40 }
    const placed = placePopover(anchor, size, desktop)
    expect(placed.mode).toBe('float')
    expect(bottomOf(placed)).toBeLessThanOrEqual(anchor.top)
    expect(placed.mode === 'float' ? placed.top : -1).toBeGreaterThanOrEqual(8)
  })

  it('caps the height to the room there is, never off screen', () => {
    const short = { width: 1000, height: 420 }
    const placed = placePopover({ top: 200, left: 10, width: 980, height: 40 }, size, short)
    expect(placed.mode === 'float' ? placed.top : -1).toBeGreaterThanOrEqual(8)
    expect(bottomOf(placed)).toBeLessThanOrEqual(short.height - 8)
  })
})
