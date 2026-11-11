import { MergeModel, splitText, type MergeChange } from '../shared/mergeModel';
import type { MergeProgress } from '../shared/mergeProtocol';
import { innerDifferences, type ComparisonPolicy } from '../shared/mergeResolve';
import type { MergeDocument } from './protocol';
import { initialProgress } from './progress';
import { buildChanges } from '../shared/intellijDiff';

export interface PreparedDiff {
  before: string;
  after: string;
  changes: ReturnType<typeof buildChanges>;
  simplified?: boolean;
  large?: boolean;
}

export interface PreparedMerge {
  changes: MergeChange[];
  progress: MergeProgress | undefined;
}

export interface HighlightInput {
  index: number;
  left: string;
  base: string;
  right: string;
  policy: ComparisonPolicy;
}

export interface HighlightResult {
  index: number;
  inner: ReturnType<typeof innerDifferences>;
}

export type AnalysisTask =
  | { kind: 'prepare'; document: MergeDocument }
  | { kind: 'highlight'; inputs: HighlightInput[] }
  | { kind: 'diff'; before: string; after: string };
export type AnalysisRequest = AnalysisTask & { id: number };
export type AnalysisResponse =
  { id: number; result: PreparedMerge | HighlightResult[] | PreparedDiff } | { id: number; error: string };

export function analyze(task: AnalysisTask): PreparedMerge | HighlightResult[] | PreparedDiff {
  if (task.kind === 'diff') {
    const before = task.before.replace(/\r\n/g, '\n');
    const after = task.after.replace(/\r\n/g, '\n');
    return { before, after, changes: buildChanges(before.split('\n'), after.split('\n')) };
  }
  if (task.kind === 'highlight') {
    return task.inputs.map((input) => ({
      index: input.index,
      inner: innerDifferences(input.left, input.base, input.right, input.policy),
    }));
  }
  const data = task.document;
  const model = MergeModel.create(
    splitText(data.base).lines,
    splitText(data.left).lines,
    splitText(data.right).lines,
  );
  return { changes: model.changes, progress: initialProgress(data, model) };
}
