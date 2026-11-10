import { Worker as NodeWorker } from 'node:worker_threads';

/** Run the browser worker entry in a real thread for component integration tests. */
export class BrowserWorker {
  readonly thread: NodeWorker;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor(url: URL) {
    this.thread = new NodeWorker(url);
    this.thread.on('message', (data) => this.onmessage?.({ data }));
    this.thread.on('error', (error) => this.onerror?.({ message: error.message, preventDefault() {} }));
    this.thread.on('messageerror', () => this.onmessageerror?.());
  }
  postMessage(data: unknown) {
    this.thread.postMessage(data);
  }
  terminate() {
    void this.thread.terminate();
  }
}
