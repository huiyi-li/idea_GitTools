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

export class MergeAnalysis {
  private readonly worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<AnalysisResponse>) => {
      const response = event.data;
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      if ('error' in response) request.reject(new Error(response.error));
      else request.resolve(response.result);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.close(new Error(event.message || '后台合并计算失败，请重新打开文件'));
    };
    this.worker.onmessageerror = () => this.close(new Error('无法读取后台合并计算结果，请重新打开文件'));
  }

  private run<T>(task: AnalysisTask): Promise<T> {
    if (this.closed) return Promise.reject(new Error('后台合并计算已关闭'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.worker.postMessage({ ...task, id } satisfies AnalysisRequest);
      } catch (error) {
        this.pending.delete(id);
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

  diff(before: string, after: string) {
    return this.run<PreparedDiff>({ kind: 'diff', before, after });
  }

  close(error = new Error('后台合并计算已取消')) {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
