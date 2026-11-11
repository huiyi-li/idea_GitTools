import type {
  AnalysisRequest,
  AnalysisResponse,
  AnalysisTask,
  HighlightInput,
  HighlightResult,
  PreparedMerge,
  PreparedDiff,
} from './analysis';
import type { MergeDocument } from './protocol';

class AnalysisTimeout extends Error {}

export class MergeAnalysis {
  private readonly worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), {
    type: 'module',
  });
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly timeoutMs = 5000) {
    this.worker.onmessage = (event: MessageEvent<AnalysisResponse>) => {
      const response = event.data;
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      clearTimeout(request.timer);
      if ('error' in response) request.reject(new Error(response.error));
      else request.resolve(response.result);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.close(new Error(event.message || '后台合并计算失败，请重新打开文件'));
    };
    this.worker.onmessageerror = () =>
      this.close(new Error('无法读取后台合并计算结果，请重新打开文件'));
  }

  private run<T>(task: AnalysisTask): Promise<T> {
    if (this.closed) return Promise.reject(new Error('后台合并计算已关闭'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => this.close(new AnalysisTimeout('差异计算超过时间预算，可重新读取或选择保留一侧')),
        this.timeoutMs,
      );
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.worker.postMessage({ ...task, id } satisfies AnalysisRequest);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  prepare(document: MergeDocument) {
    return this.run<PreparedMerge>({ kind: 'prepare', document });
  }
  highlight(inputs: HighlightInput[]) {
    return this.run<HighlightResult[]>({ kind: 'highlight', inputs });
  }

  get isClosed() {
    return this.closed;
  }

  async diff(before: string, after: string): Promise<PreparedDiff> {
    try {
      return await this.run<PreparedDiff>({ kind: 'diff', before, after });
    } catch (error) {
      if (!(error instanceof AnalysisTimeout)) throw error;
      const a = before.replace(/\r\n/g, '\n');
      const b = after.replace(/\r\n/g, '\n');
      return {
        before: a,
        after: b,
        simplified: true,
        changes:
          a === b
            ? []
            : [
                {
                  line0: 0,
                  line1: 0,
                  deleted: a.split('\n').length,
                  inserted: b.split('\n').length,
                },
              ],
      };
    }
  }

  close(error = new Error('后台合并计算已取消')) {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
