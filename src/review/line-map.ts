import type { Change } from '../shared/intellijDiff';

export type LineAnchors = readonly [number, number][];

export function lineAnchors(
  changes: Change[],
  beforeLines: number,
  afterLines: number,
): LineAnchors {
  return [
    [0, 0],
    ...changes.flatMap((change) => [
      [change.line0, change.line1] as [number, number],
      [change.line0 + change.deleted, change.line1 + change.inserted] as [number, number],
    ]),
    [beforeLines, afterLines],
  ];
}

export function mapLine(anchors: LineAnchors, line: number, reverse = false): number {
  if (!anchors.length) return line;
  const source = reverse ? 1 : 0;
  const target = reverse ? 0 : 1;
  let start = 0;
  let end = anchors.length - 1;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (anchors[middle][source] < line) start = middle + 1;
    else end = middle;
  }
  const next = anchors[start];
  const previous = anchors[Math.max(0, start - 1)];
  if (next[source] === previous[source]) return next[target];
  return (
    previous[target] +
    ((line - previous[source]) * (next[target] - previous[target])) /
      (next[source] - previous[source])
  );
}
