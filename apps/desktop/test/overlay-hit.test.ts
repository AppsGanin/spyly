import { describe, expect, it } from 'vitest'
import { PILL_HEIGHT, PILL_WIDTH, pointIsOnPanel } from '../src/main/overlay-hit'

/**
 * The window is wider than the pill drawn in it, and the empty part lets clicks
 * through. Getting this arithmetic wrong makes the stop button unpressable, so
 * it is pinned down here rather than checked by hand during a call.
 */
describe('what the floating panel counts as its own', () => {
  const WIDTH = 460
  const collapsed = { x: 1000, y: 40, width: WIDTH, height: PILL_HEIGHT }
  const expanded = { ...collapsed, height: 168 }

  it('the stop button, at the right edge of the pill, belongs to the panel', () => {
    const stop = { x: collapsed.x + WIDTH - 20, y: collapsed.y + PILL_HEIGHT / 2 }
    expect(pointIsOnPanel(collapsed, stop)).toBe(true)
    expect(pointIsOnPanel(expanded, stop)).toBe(true)
  })

  it('the empty space left of the pill is let through', () => {
    const empty = { x: collapsed.x + 10, y: collapsed.y + 10 }
    expect(pointIsOnPanel(collapsed, empty)).toBe(false)
    // With the draft open that row is still empty: the text is below the pill.
    expect(pointIsOnPanel(expanded, empty)).toBe(false)
  })

  it('the draft takes the whole width, but only while it is there', () => {
    const underPill = { x: expanded.x + 10, y: expanded.y + PILL_HEIGHT + 40 }
    expect(pointIsOnPanel(expanded, underPill)).toBe(true)
    expect(pointIsOnPanel(collapsed, underPill)).toBe(false)
  })

  it('below and beside the window nothing belongs to the panel', () => {
    expect(pointIsOnPanel(expanded, { x: expanded.x + 10, y: expanded.y + 200 })).toBe(false)
    expect(pointIsOnPanel(expanded, { x: expanded.x - 5, y: expanded.y + 60 })).toBe(false)
  })

  /** The pill is pressed to the right edge whatever the window's width. */
  it('the pill is measured from the right edge, not the left', () => {
    const wider = { ...collapsed, width: 900 }
    const justInside = { x: wider.x + 900 - PILL_WIDTH + 2, y: wider.y + 10 }
    const justOutside = { x: wider.x + 900 - PILL_WIDTH - 2, y: wider.y + 10 }
    expect(pointIsOnPanel(wider, justInside)).toBe(true)
    expect(pointIsOnPanel(wider, justOutside)).toBe(false)
  })
})
