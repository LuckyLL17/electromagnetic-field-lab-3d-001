/**
 * 对象 URL（Blob URL）登记处。
 *
 * 保证“不残留对象 URL”：
 * - 每次 createObjectURL 都登记；revokeNow 立即吊销并取消挂起的延迟吊销；
 * - revokeDeferred 给浏览器一个 tick 发起下载后再吊销（同步吊销在部分浏览器
 *   会中断下载），即便卸载发生在 tick 之前，revokeAll 也会兜底立即吊销；
 * - 全部资源可注入（便于 Node 下测试），默认取浏览器 URL/setTimeout。
 */
export interface UrlHost {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface UrlRegistryOptions {
  host?: UrlHost;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** 延迟吊销的等待毫秒数。 */
  delayMs?: number;
}

export class UrlRegistry {
  private readonly live = new Set<string>();
  private readonly pending = new Map<string, unknown>();
  private readonly host: UrlHost;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly delayMs: number;
  private disposed = false;

  constructor(opts: UrlRegistryOptions = {}) {
    const g = globalThis as {
      URL?: UrlHost;
      setTimeout?: (fn: () => void, ms: number) => unknown;
      clearTimeout?: (handle: unknown) => void;
    };
    this.host = opts.host ?? (g.URL as UrlHost);
    this.setTimer = opts.setTimeout ?? g.setTimeout ?? ((fn) => { fn(); return null; });
    this.clearTimer = opts.clearTimeout ?? g.clearTimeout ?? (() => undefined);
    this.delayMs = opts.delayMs ?? 0;
  }

  create(blob: Blob): string {
    if (this.disposed) throw new Error('UrlRegistry 已销毁');
    const url = this.host.createObjectURL(blob);
    this.live.add(url);
    return url;
  }

  /** 立即吊销。 */
  revokeNow(url: string): void {
    const handle = this.pending.get(url);
    if (handle !== undefined) {
      this.clearTimer(handle);
      this.pending.delete(url);
    }
    if (this.live.has(url)) {
      this.host.revokeObjectURL(url);
      this.live.delete(url);
    }
  }

  /** 延迟吊销（下载场景）；卸载前会被 revokeAll 兜底。 */
  revokeDeferred(url: string): void {
    if (!this.live.has(url) || this.pending.has(url)) return;
    const handle = this.setTimer(() => {
      this.pending.delete(url);
      if (this.live.has(url)) {
        this.host.revokeObjectURL(url);
        this.live.delete(url);
      }
    }, this.delayMs);
    this.pending.set(url, handle);
  }

  /** 吊销全部 live URL 并取消所有挂起任务（组件卸载时调用）。 */
  revokeAll(): void {
    for (const handle of this.pending.values()) this.clearTimer(handle);
    this.pending.clear();
    for (const url of this.live) this.host.revokeObjectURL(url);
    this.live.clear();
  }

  /** 测试辅助：当前仍未吊销的 URL 数量。 */
  get liveCount(): number {
    return this.live.size;
  }
}
