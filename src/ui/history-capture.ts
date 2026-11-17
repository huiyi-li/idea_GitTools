export class BackgroundHistoryCapture {
  private root = '';
  private pending = new Map<string, number>();
  private ticket = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight = false;
  private disposed = false;

  constructor(
    private capture: (root: string, path: string) => Promise<boolean>,
    private canRun: () => boolean,
    private delay = 500,
    private limit = 256,
  ) {}

  setRoot(root: string) {
    if (root === this.root) return;
    this.root = root;
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  enqueue(root: string, paths: string[]) {
    if (this.disposed || root !== this.root) return;
    for (const path of paths) {
      if (this.pending.size >= this.limit && !this.pending.has(path)) break;
      this.pending.set(path, ++this.ticket);
    }
    this.schedule();
  }

  dispose() {
    this.disposed = true;
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule() {
    if (this.disposed || this.inFlight || this.timer || !this.pending.size) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, this.delay);
  }

  private async drain() {
    if (this.disposed || this.inFlight || !this.pending.size) return;
    if (!this.canRun()) { this.schedule(); return; }
    const root = this.root;
    const [path, ticket] = this.pending.entries().next().value!;
    this.inFlight = true;
    try {
      const captured = await this.capture(root, path);
      if (root === this.root && this.pending.get(path) === ticket && captured) this.pending.delete(path);
    } catch {
      // Automatic snapshots are best effort. Manual capture reports its errors.
      if (root === this.root && this.pending.get(path) === ticket) this.pending.delete(path);
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }
}
