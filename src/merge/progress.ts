import { buildChanges } from '../shared/intellijDiff';
import { MergeModel, linesContent, splitText } from '../shared/mergeModel';
import type { MergeProgress } from '../shared/mergeProtocol';
import type { MergeDocument } from './protocol';

/** Preserve existing edits around Git markers, while restoring recognized
 * conflict blocks to their base so that the block operations can resolve them. */
export function initialProgress(document: MergeDocument, prepared?: MergeModel): MergeProgress | undefined {
  if (document.working === null && !document.progress) return undefined;
  const base = splitText(document.base).lines;
  const left = splitText(document.left).lines;
  const right = splitText(document.right).lines;
  const model = prepared ?? MergeModel.create(base, left, right);
  if (document.progress?.states.length === model.changes.length) return document.progress;
  const result = splitText(document.progress?.lines.join('\n') ?? document.working!).lines;
  const marker = (symbol: string) => symbol.repeat(document.markerSize);
  const replacements: { start: number; end: number; lines: string[] }[] = [];
  const used = new Set<number>();
  for (let start = 0; start < result.length; start++) {
    if (!result[start].startsWith(marker('<'))) continue;
    let separator = start + 1;
    while (separator < result.length && result[separator] !== marker('=')) separator++;
    let end = separator + 1;
    while (end < result.length && !result[end].startsWith(marker('>'))) end++;
    if (end >= result.length) continue;
    const ancestor = result.findIndex(
      (line, index) => index > start && index < separator && line.startsWith(marker('|')),
    );
    const ours = result.slice(start + 1, ancestor < 0 ? separator : ancestor).join('\n');
    const theirs = result.slice(separator + 1, end).join('\n');
    const change = model.changes.find((change) => {
      if (used.has(change.index)) return false;
      const a = linesContent(left, change.left);
      const b = linesContent(right, change.right);
      return document.leftStage === 2 ? a === ours && b === theirs : a === theirs && b === ours;
    });
    if (change) {
      replacements.push({ start, end: end + 1, lines: base.slice(...change.base) });
      used.add(change.index);
    }
    start = end;
  }
  for (const replacement of replacements.reverse()) {
    result.splice(replacement.start, replacement.end - replacement.start, ...replacement.lines);
  }
  if (!result.length) result.push('');
  for (const change of buildChanges(base, result).reverse()) {
    model.onUserEdit(change.line0, change.line0 + change.deleted, change.inserted - change.deleted);
  }
  model.lines = result;
  // Git has already merged these ordinary changes in the worktree.
  for (const change of model.changes) {
    const state = model.states[change.index];
    const content = linesContent(result, [state.start, state.end]);
    if (
      !used.has(change.index) &&
      ((change.leftChange && content === linesContent(left, change.left)) ||
        (change.rightChange && content === linesContent(right, change.right)))
    ) {
      model.markResolved(change.index);
    }
  }
  return { lines: result, states: model.states, contentModified: document.progress?.contentModified ?? false };
}
