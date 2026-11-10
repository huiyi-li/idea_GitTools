import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserWorker } from './browser-worker';
import { MergeAnalysis } from '../src/merge/analysis-client';
import { initialProgress } from '../src/merge/progress';
import { MergeModel, splitText } from '../src/shared/mergeModel';
import { innerDifferences } from '../src/shared/mergeResolve';
import type { MergeDocument } from '../src/merge/protocol';
import { buildChanges } from '../src/shared/intellijDiff';

Object.defineProperty(globalThis, 'Worker', { configurable: true, value: BrowserWorker });

function document(base = 'start\nbase\nend\n'): MergeDocument {
  return {
    id: 'worker-test',
    path: 'example.txt',
    base,
    left: base.replaceAll('base', 'local'),
    right: base.replaceAll('base', 'incoming'),
    working: base,
    leftTitle: 'local',
    rightTitle: 'incoming',
    leftStage: 2,
    leftPresent: true,
    rightPresent: true,
    editable: true,
    reason: '',
    markerSize: 7,
    progress: null,
  };
}

test('real background worker prepares the same model, saved progress and word differences', async () => {
  const worker = new MergeAnalysis();
  try {
    const data = document();
    data.working = 'start\n<<<<<<< HEAD\nlocal\n=======\nincoming\n>>>>>>> feature\nend\n';
    const result = await worker.prepare(data);
    const model = MergeModel.create(
      splitText(data.base).lines,
      splitText(data.left).lines,
      splitText(data.right).lines,
    );
    assert.deepEqual(result.changes, model.changes);
    assert.deepEqual(result.progress, initialProgress(data));
    const input = {
      index: 0,
      left: 'value = 2;',
      base: 'value = 1;',
      right: 'value = 3;',
      policy: 'default' as const,
    };
    assert.deepEqual(await worker.highlight([input]), [
      { index: 0, inner: innerDifferences(input.left, input.base, input.right) },
    ]);
    data.progress = { lines: ['saved'], states: result.progress!.states, contentModified: true };
    assert.deepEqual((await worker.prepare(data)).progress, data.progress);
  } finally {
    worker.close();
  }
});

test('large merge preparation leaves the main event loop responsive', async (context) => {
  const worker = new MergeAnalysis();
  const data = document(
    Array.from({ length: 4000 }, (_, index) => `context ${index}\nbase ${index}\nend ${index}\n`).join(''),
  );
  let ticks = 0;
  const timer = setInterval(() => ticks++, 2);
  const start = performance.now();
  try {
    const result = await worker.prepare(data);
    assert.equal(result.changes.length, 4000);
    assert.ok(ticks > 1, `main event loop responded ${ticks} times during background analysis`);
    context.diagnostic(
      `12,001 lines, 4,000 conflicts: ${Math.round(performance.now() - start)} ms in a worker; main event loop responded ${ticks} times`,
    );
  } finally {
    clearInterval(timer);
    worker.close();
  }
});

test('closing a worker cancels pending calculations and errors do not hang later requests', async () => {
  const worker = new MergeAnalysis();
  const pending = worker.prepare(document());
  const rejected = assert.rejects(pending, /取消/);
  worker.close();
  await rejected;
  await assert.rejects(worker.prepare(document()), /关闭/);
  const other = new MergeAnalysis();
  try {
    await assert.rejects(other.prepare({} as MergeDocument));
    assert.equal((await other.prepare(document())).changes.length, 1);
  } finally {
    other.close();
  }
});

test('two-pane file diffs run in the real worker and preserve CRLF and final newline semantics', async () => {
  const worker = new MergeAnalysis();
  try {
    for (const [before, after] of [['a\r\nb\r\n', 'a\r\nchanged\r\n'], ['', 'new\n'], ['deleted\n', ''], ['a\n', 'a']]) {
      const result = await worker.diff(before, after);
      assert.equal(result.before, before.replace(/\r\n/g, '\n'));
      assert.equal(result.after, after.replace(/\r\n/g, '\n'));
      assert.deepEqual(result.changes, buildChanges(result.before.split('\n'), result.after.split('\n')));
    }
  } finally { worker.close(); }
});
