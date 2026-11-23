/**
 * Geometry for dragging an element among its siblings on the canvas. Siblings can sit in a column, a row, or
 * a wrapping grid of rows, so the drop position is read row by row: whole rows above the pointer come before
 * it, and within the pointer's row the items left of it do.
 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Group boxes (in list order) into visual rows: an item joins the current row when it sits to the right of
 *  the previous item and overlaps the row's height at all (items of different heights, top or bottom aligned,
 *  still share a row); a wrap back to the left, or a box below the row, starts a new one. */
export function rowsOf(boxes: Box[]): number[][] {
  const rows: number[][] = [];
  boxes.forEach((b, i) => {
    const row = rows[rows.length - 1];
    const prev = row ? boxes[row[row.length - 1]] : null;
    const top = row ? Math.min(...row.map((k) => boxes[k].y)) : 0;
    const bottom = row ? Math.max(...row.map((k) => boxes[k].y + boxes[k].height)) : 0;
    if (row && prev && b.x >= prev.x + prev.width / 2 && b.y < bottom && b.y + b.height > top) row.push(i);
    else rows.push([i]);
  });
  return rows;
}

/** The insertion index (0..boxes.length) for a pointer at (x, y), and the line that shows it. */
export function dropAt(boxes: Box[], x: number, y: number): { to: number; line: Box } {
  const rows = rowsOf(boxes);
  let to = boxes.length;
  let row = rows[rows.length - 1] ?? [];
  for (const r of rows) {
    const bottom = Math.max(...r.map((i) => boxes[i].y + boxes[i].height));
    row = r;
    if (y > bottom) {
      if (r !== rows[rows.length - 1]) continue;
      // Below the last row: after everything.
      to = boxes.length;
    } else if (r.length === 1) {
      const b = boxes[r[0]];
      to = y > b.y + b.height / 2 ? r[0] + 1 : r[0];
    } else to = r[0] + r.filter((i) => x > boxes[i].x + boxes[i].width / 2).length;
    break;
  }
  return { to, line: lineFor(boxes, row, to) };
}

function lineFor(boxes: Box[], row: number[], to: number): Box {
  if (!boxes.length) return { x: 0, y: 0, width: 0, height: 0 };
  if (row.length > 1) {
    // Within a row: a vertical bar before the item it lands in front of, or after the row's last item.
    const before = row.includes(to) ? boxes[to] : null;
    const last = boxes[row[row.length - 1]];
    return before ? { x: before.x - 2, y: before.y, width: 3, height: before.height } : { x: last.x + last.width - 1, y: last.y, width: 3, height: last.height };
  }
  // A column: a horizontal bar on the top edge of the item it lands in front of, or under the last one.
  const at = boxes[Math.min(to, boxes.length - 1)];
  return { x: at.x, y: to >= boxes.length ? at.y + at.height - 1 : at.y - 1, width: at.width, height: 3 };
}

/**
 * Map a drop among the visible siblings to a move in the full list (hidden siblings take no space on the
 * canvas but keep their place in the document). `visible` holds each visible sibling's index in the full
 * list, in order; `from` is the dragged item's full index. Returns the node.move index, or null when the
 * visible order would not change.
 */
export function moveIndex(visible: number[], from: number, to: number): number | null {
  const fromVisible = visible.indexOf(from);
  if (fromVisible < 0 || to === fromVisible || to === fromVisible + 1) return null;
  const target = to < visible.length ? visible[to] : visible[visible.length - 1] + 1;
  return target > from ? target - 1 : target;
}
