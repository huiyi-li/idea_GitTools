import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundHistoryCapture } from '../src/ui/history-capture';

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await tick(5); }
  assert.fail('background queue did not settle');
}
function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('large refreshes never enqueue a snapshot flood and respect the pending budget', async () => {
  const pending = deferred();
  const calls: string[] = [];
  let running = 0;
  let peak = 0;
  const queue = new BackgroundHistoryCapture(async (_root, path) => {
    calls.push(path); running++; peak = Math.max(peak, running);
    if (calls.length === 1) await pending.promise;
    running--; return true;
  }, () => true, 1, 3);
  try {
    queue.setRoot('A');
    queue.enqueue('A', Array.from({ length: 10000 }, (_, index) => `file-${index}`));
    await until(() => calls.length === 1);
    await tick(30);
    assert.equal(calls.length, 1);
    pending.resolve(true);
    await until(() => calls.length === 3);
    await tick(20);
    assert.equal(calls.length, 3);
    assert.equal(peak, 1);
  } finally { queue.dispose(); pending.resolve(true); }
});

test('user operations take priority and busy backend responses are retried without piling up', async () => {
  let allowed = false;
  let calls = 0;
  const queue = new BackgroundHistoryCapture(async () => ++calls > 1, () => allowed, 2);
  try {
    queue.setRoot('A'); queue.enqueue('A', ['file']);
    await tick(25); assert.equal(calls, 0);
    allowed = true;
    await until(() => calls === 2);
    await tick(15); assert.equal(calls, 2);
  } finally { queue.dispose(); }
});

test('switching repositories cancels queued work and late completion cannot remove a new request', async () => {
  const pending = deferred();
  const calls: string[] = [];
  const queue = new BackgroundHistoryCapture(async (root, path) => {
    calls.push(`${root}/${path}`);
    return calls.length === 1 ? pending.promise : true;
  }, () => true, 2);
  try {
    queue.setRoot('A'); queue.enqueue('A', ['same', 'old']);
    await until(() => calls.length === 1);
    queue.setRoot('B'); queue.enqueue('B', ['same']);
    queue.setRoot('A'); queue.enqueue('A', ['same']);
    pending.resolve(true);
    await until(() => calls.length === 2);
    assert.deepEqual(calls, ['A/same', 'A/same']);
    queue.dispose(); queue.enqueue('A', ['never']);
    await tick(15); assert.equal(calls.length, 2);
  } finally { queue.dispose(); pending.resolve(true); }
});

test('a new change during capture is not lost and automatic errors do not retry forever', async () => {
  const pending = deferred();
  let calls = 0;
  const queue = new BackgroundHistoryCapture(async () => {
    calls++;
    if (calls === 1) return pending.promise;
    throw Error('unsupported large file');
  }, () => true, 2);
  try {
    queue.setRoot('A'); queue.enqueue('A', ['file']);
    await until(() => calls === 1);
    queue.enqueue('A', ['file']);
    pending.resolve(true);
    await until(() => calls === 2);
    await tick(20); assert.equal(calls, 2);
  } finally { queue.dispose(); pending.resolve(true); }
});
