/** A tile on the map. */
export interface Tile {
  x: number;
  y: number;
}

/**
 * The tiles a path runs over from `from` to `to`, `to` included and `from` not, each next to the
 * one before it along an edge, never across a corner: a path is only joined edge to edge, so a
 * pointer that skips over tiles in one frame, or moves on a slant, still lays a path that is all of
 * one piece. It steps along whichever axis is further behind the straight line, so the run hugs
 * the line between the two. Nothing for the same tile.
 */
export function tilesBetween(from: Tile, to: Tile): Tile[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.abs(dx) + Math.abs(dy);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const out: Tile[] = [];
  let x = from.x;
  let y = from.y;
  let doneX = 0;
  let doneY = 0;
  for (let i = 0; i < steps; i++) {
    // Which of the two is less far along its share of the way: step that one.
    const shareX = dx === 0 ? 1 : (doneX + 0.5) / Math.abs(dx);
    const shareY = dy === 0 ? 1 : (doneY + 0.5) / Math.abs(dy);
    if (shareX < shareY || (shareX === shareY && Math.abs(dx) >= Math.abs(dy))) {
      x += sx;
      doneX++;
    } else {
      y += sy;
      doneY++;
    }
    out.push({ x, y });
  }
  return out;
}

/**
 * One drag of the path tool: the tiles it has covered, in the order it came over them, each once.
 * `start` begins it on the tile pressed; `extend` takes the tile the pointer is over now and gives
 * back the tiles that are new to the stroke, the ones in between included.
 */
export class PathStroke {
  private last: Tile | null;
  private readonly seen = new Set<string>();

  constructor(start: Tile) {
    this.last = { ...start };
    this.seen.add(key(start));
  }

  /**
   * Lifts the stroke: the pointer left the map, so the next tile is a fresh start, not joined to
   * the last by the tiles between (which the pointer never crossed).
   */
  lift(): void {
    this.last = null;
  }

  extend(to: Tile): Tile[] {
    const last = this.last;
    if (last === null) {
      this.last = { ...to };
      const k = key(to);
      if (this.seen.has(k)) return [];
      this.seen.add(k);
      return [{ ...to }];
    }
    if (to.x === last.x && to.y === last.y) return [];
    const fresh: Tile[] = [];
    for (const tile of tilesBetween(last, to)) {
      const k = key(tile);
      if (this.seen.has(k)) continue;
      this.seen.add(k);
      fresh.push(tile);
    }
    this.last = { ...to };
    return fresh;
  }
}

const key = (tile: Tile) => `${tile.x},${tile.y}`;

/**
 * What to tell the player about the tiles of one stroke that the sim refused, given the reason of
 * each: one message, the count of tiles first, a reason given once however many tiles it stopped,
 * most common reason first (`3 tiles skipped: Cannot build on water`). Null when none was refused.
 */
export function skippedMessage(reasons: readonly string[]): string | null {
  if (reasons.length === 0) return null;
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([reason]) => reason);
  const tiles = reasons.length === 1 ? "1 tile" : `${reasons.length} tiles`;
  return `${tiles} skipped: ${ordered.join("; ")}`;
}
