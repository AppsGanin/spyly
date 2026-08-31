/**
 * Where the floating panel actually draws something.
 *
 * The window is a constant size, wider and taller than what is on it, and the
 * empty part of it is transparent. Clicks pass through that part, so the main
 * process has to know which points belong to the panel and which to whatever is
 * underneath. It lives apart from the window itself so the arithmetic can be
 * tested: a mistake here leaves the stop button dead, and that is not something
 * to find out during a call.
 */

/** The pill's own size, pressed to the right edge of the window. */
export const PILL_WIDTH = 236
export const PILL_HEIGHT = 44

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Whether the point falls on something drawn rather than on empty window.
 *
 * The pill sits in the top right corner at its own size; the draft, when it is
 * there, takes the whole width under it. The gap between them counts as the
 * panel too — it is a few pixels between two of our own boxes, and dropping the
 * mouse while crossing it would only make the panel flicker.
 */
export function pointIsOnPanel(bounds: Rect, point: { x: number; y: number }): boolean {
  const onPill =
    point.x >= bounds.x + bounds.width - PILL_WIDTH &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + PILL_HEIGHT

  // A window no taller than the pill has no draft under it.
  const onDraft =
    bounds.height > PILL_HEIGHT &&
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y > bounds.y + PILL_HEIGHT &&
    point.y <= bounds.y + bounds.height

  return onPill || onDraft
}
