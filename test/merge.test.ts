import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialProgress } from '../src/merge/progress';
import { MergeModel, splitText } from '../src/shared/mergeModel';
import type { MergeDocument } from '../src/merge/protocol';

function document(patch: Partial<MergeDocument> = {}): MergeDocument {
  return {
    id: 'test',
    path: 'example.txt',
    base: 'start\nbase\nend\n',
    left: 'start\nlocal\nend\n',
    right: 'start\nincoming\nend\n',
    working: 'start\n<<<<<<< HEAD\nlocal\n=======\nincoming\n>>>>>>> feature\nend\n',
    leftTitle: 'local',
    rightTitle: 'incoming',
    leftStage: 2,
    leftPresent: true,
    rightPresent: true,
    editable: true,
    reason: '',
    markerSize: 7,
    progress: null,
    ...patch,
  };
}

function modelFor(value: MergeDocument) {
  const progress = initialProgress(value)!;
  const model = MergeModel.create(
    splitText(value.base).lines,
    splitText(value.left).lines,
    splitText(value.right).lines,
  );
  return new MergeModel(model.changes, model.sides, progress.lines, progress.states);
}

test('recognizes Git markers and applies a side to the exact result range', () => {
  const model = modelFor(document());
  assert.equal(model.lines.join('\n'), 'start\nbase\nend\n');
  assert.equal(model.stats().conflicts, 1);
  model.replaceChange(0, 'left', true);
  assert.equal(model.lines.join('\n'), 'start\nlocal\nend\n');
  assert.equal(model.stats().conflicts, 0);
});

test('preserves manual worktree edits outside a conflict', () => {
  const model = modelFor(
    document({
      working: 'manually edited prefix\n<<<<<<< HEAD\nlocal\n=======\nincoming\n>>>>>>> feature\nend\n',
    }),
  );
  model.replaceChange(0, 'right', true);
  assert.equal(model.lines.join('\n'), 'manually edited prefix\nincoming\nend\n');
});

test('rebase maps the marker ours section to the displayed right side', () => {
  const model = modelFor(
    document({ leftStage: 3, left: 'start\nincoming\nend\n', right: 'start\nlocal\nend\n' }),
  );
  model.replaceChange(0, 'left', true);
  assert.equal(model.lines.join('\n'), 'start\nincoming\nend\n');
});

test('supports diff3 markers and a custom marker size', () => {
  const model = modelFor(
    document({
      markerSize: 9,
      working:
        'start\n<<<<<<<<< HEAD\nlocal\n||||||||| base\nbase\n=========\nincoming\n>>>>>>>>> feature\nend\n',
    }),
  );
  assert.equal(model.lines.join('\n'), 'start\nbase\nend\n');
  model.replaceChange(0, 'right', true);
  assert.equal(model.lines.join('\n'), 'start\nincoming\nend\n');
});

test('restores the saved result and resolution flags', () => {
  const progress = {
    lines: ['saved result'],
    states: [{ start: 0, end: 1, resolvedLeft: true, resolvedRight: true, oneside: false }],
    contentModified: true,
  };
  assert.deepEqual(initialProgress(document({ progress })), progress);
});

test('preserves externally edited content that has no marker blocks', () => {
  const value = document({ working: 'external resolution\n' });
  assert.equal(initialProgress(value)!.lines.join('\n'), value.working);
});

test('a marker-free side result recovers resolved flags when saved block metadata is missing', () => {
  const value = document({ working: 'start\nincoming\nend\n', progress: { lines: ['start', 'incoming', 'end', ''], states: [], contentModified: true } });
  const restored = initialProgress(value)!;
  assert.equal(restored.lines.join('\n'), value.working);
  assert.equal(restored.states.length, 1);
  assert.ok(restored.states[0].resolvedLeft && restored.states[0].resolvedRight);
});

test('keeps unrelated marker-like content that does not match the index versions', () => {
  const value = document({
    working: 'start\n<<<<<<< unrelated\ndifferent\n=======\nother\n>>>>>>> example\nend\n',
  });
  assert.equal(initialProgress(value)!.lines.join('\n'), value.working);
});

test('marks Git-merged ordinary changes as resolved', () => {
  const model = modelFor(
    document({
      base: 'first\nmiddle\nlast\n',
      left: 'local first\nmiddle\nlast\n',
      right: 'first\nmiddle\nincoming last\n',
      working: 'local first\nmiddle\nincoming last\n',
    }),
  );
  assert.equal(model.unresolved.length, 0);
  assert.equal(model.lines.join('\n'), 'local first\nmiddle\nincoming last\n');
});

test('accepting both sides appends content and resolves the block', () => {
  const model = modelFor(document());
  model.replaceChange(0, 'left', false);
  model.replaceChange(0, 'right', false);
  assert.equal(model.lines.join('\n'), 'start\nlocal\nincoming\nend\n');
  assert.equal(model.unresolved.length, 0);
});
