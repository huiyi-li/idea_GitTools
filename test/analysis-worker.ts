import { parentPort } from 'node:worker_threads';

if (!parentPort) throw new Error('A worker thread is required');
globalThis.self = {
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    if (type === 'message') parentPort!.on('message', (data) => listener({ data }));
  },
  postMessage(data: unknown) {
    parentPort!.postMessage(data);
  },
} as typeof self;
await import('../src/merge/analysis.worker');
