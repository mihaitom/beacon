// Dragging a row to a new place in a list - the song table, the queue
// drawer and the phone's queue all ask the same two questions.

export type DropHalf = 'before' | 'after'

/** Which half of a row the pointer is over - the upper half drops in front
 * of the row, the lower half behind it. */
export function dropHalf(clientY: number, rect: { top: number; height: number }): DropHalf {
  return clientY > rect.top + rect.height / 2 ? 'after' : 'before'
}

/** Where the row dragged from `from` ends up, dropped on `half` of the row
 * at `over` - as a position in the list once the dragged row has been
 * taken out, which is what a move by (from, to) expects.
 *
 * The drop boundary counts the dragged row still in place, so everything
 * behind it shifts up by one once it is gone. Without that, dragging
 * downwards landed one row too far: a drop just behind the next row moved
 * nothing past it. */
export function reorderTarget(from: number, over: number, half: DropHalf): number {
  const insertBefore = half === 'after' ? over + 1 : over
  return insertBefore > from ? insertBefore - 1 : insertBefore
}

/** dropHalf() for a drag event on the row it is over. */
export function dragEventHalf(event: DragEvent): DropHalf {
  return dropHalf(event.clientY, (event.currentTarget as HTMLElement).getBoundingClientRect())
}
