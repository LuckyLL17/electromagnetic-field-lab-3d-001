/**
 * 时间轴回放引擎（框架无关，可独立测试）。
 *
 * 状态机：idle ──play──▶ playing ──pause──▶ paused ──resume──▶ playing
 *         playing/paused ──cancel──▶ idle（恢复到播放前的 baseline）
 *         任意状态 ──interrupt──▶ idle（保留当前画面，不回滚）
 *         播完最后一帧 ──▶ idle（停在末帧）
 *
 * 不残留定时器的保证：
 * - 每次调度都给 timer 句柄配对 clearTimeout；
 * - generation 代数标记让“取消后才触发的迟到回调”直接失效；
 * - destroy() 清理一切待触发任务；引擎不会持有任何 DOM/URL 资源。
 */
import {
  DEFAULT_INTERVAL_MS,
  ExperimentCheckpoint,
  MIN_INTERVAL_MS,
} from './types';

export type PlaybackStatus = 'idle' | 'playing' | 'paused';

/** 可注入时钟，便于测试用假时钟推进而不等待真实定时器。 */
export interface ClockLike {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: ClockLike = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SequencerState {
  status: PlaybackStatus;
  /** 当前停留的检查点下标；-1 表示画面来自时间轴之外（如 cancel 后恢复实时态）。 */
  index: number;
  checkpoints: readonly ExperimentCheckpoint[];
  /** 播放发起时的实时画面快照，cancel 时原子恢复。 */
  baseline: ExperimentCheckpoint | null;
  /** 最近一次错误；下一次成功动作时清空。 */
  error: string | null;
}

export interface SequencerOptions {
  apply(checkpoint: ExperimentCheckpoint): void;
  /**
   * 播放发起时捕获“当时实时画面”作为 baseline，cancel 时原子恢复。
   * 不提供则 cancel 仅停机（由上层自行处理恢复）。
   */
  captureBaseline?: () => ExperimentCheckpoint;
  intervalMs?: number;
  clock?: ClockLike;
}

export class PlaybackSequencer {
  private checkpoints: readonly ExperimentCheckpoint[] = [];
  private index = 0;
  private status: PlaybackStatus = 'idle';
  private baseline: SequencerState['baseline'] = null;
  private error: string | null = null;

  private timer: unknown = null;
  private generation = 0;
  private readonly apply: (cp: ExperimentCheckpoint) => void;
  private readonly captureBaseline: (() => ExperimentCheckpoint) | undefined;
  private readonly intervalMs: number;
  private readonly clock: ClockLike;
  private readonly listeners = new Set<() => void>();

  constructor(opts: SequencerOptions) {
    this.apply = opts.apply;
    this.captureBaseline = opts.captureBaseline;
    this.intervalMs = Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.clock = opts.clock ?? realClock;
  }

  getState(): SequencerState {
    return {
      status: this.status,
      index: this.index,
      checkpoints: this.checkpoints,
      baseline: this.baseline,
      error: this.error,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    // 使任何在途回调作废（迟到保护）。
    this.generation++;
  }

  private setError(message: string): void {
    this.error = message;
  }

  /** 调度下一帧；已到末帧则收尾。 */
  private scheduleNext(fromGeneration: number): void {
    if (this.status !== 'playing') return;
    if (this.index >= this.checkpoints.length - 1) {
      this.finish(fromGeneration);
      return;
    }
    const nextIndex = this.index + 1;
    this.timer = this.clock.setTimeout(() => {
      // 取消/销毁/重新调度都会推进 algebra，旧回调不得再生效。
      if (fromGeneration !== this.generation || this.status !== 'playing') return;
      this.timer = null;
      this.advance(nextIndex, fromGeneration);
    }, this.intervalMs);
  }

  private advance(nextIndex: number, fromGeneration: number): void {
    try {
      this.apply(this.checkpoints[nextIndex]);
    } catch (err) {
      // 应用失败：立即停机，保留在原帧，绝不带着坏状态继续播放。
      this.clearTimer();
      this.status = 'idle';
      this.baseline = null;
      this.setError(`回放第 ${nextIndex + 1} 个检查点失败：${(err as Error).message}`);
      this.emit();
      return;
    }
    this.index = nextIndex;
    this.error = null;
    this.emit();
    this.scheduleNext(fromGeneration);
  }

  private finish(fromGeneration: number): void {
    if (fromGeneration !== this.generation) return;
    this.timer = null;
    this.status = 'idle';
    this.baseline = null;
    this.emit();
  }

  /**
   * 开始播放。空时间轴拒绝；若已停在末帧则自动回到首帧。
   * 调用时会同步应用首帧（失败则状态机不启动）。
   */
  play(startIndex?: number): void {
    if (this.checkpoints.length === 0) {
      this.setError('时间轴为空，无法播放');
      this.emit();
      return;
    }
    if (this.status === 'playing') return;
    if (this.status === 'paused') {
      this.resume();
      return;
    }
    const first = Math.max(0, Math.min(this.checkpoints.length - 1, startIndex ?? 0));
    const startAt = first >= this.checkpoints.length - 1 ? 0 : first;
    const gen = this.generation;
    // 先捕获实时 baseline；捕获失败则播放完全不启动，当前画面零改动。
    let baseline: ExperimentCheckpoint | null = null;
    if (this.captureBaseline) {
      try {
        baseline = this.captureBaseline();
      } catch (err) {
        this.setError(`无法开始回放：${(err as Error).message}`);
        this.emit();
        return;
      }
    }
    try {
      this.apply(this.checkpoints[startAt]);
    } catch (err) {
      // 首帧就失败：baseline 仅为只读快照未被使用，状态机不启动、index 不变。
      this.setError(`无法开始回放：${(err as Error).message}`);
      this.emit();
      return;
    }
    this.index = startAt;
    this.baseline = baseline;
    this.status = 'playing';
    this.error = null;
    this.emit();
    this.scheduleNext(gen);
  }

  pause(): void {
    if (this.status !== 'playing') return;
    this.clearTimer();
    this.status = 'paused';
    this.emit();
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.status = 'playing';
    const gen = this.generation;
    this.emit();
    this.scheduleNext(gen);
  }

  /**
   * 取消：停机并原子恢复到播放发起时的实时 baseline。
   * baseline 恢复失败时不改变状态机结论（仍停机），错误显式暴露。
   * @returns 是否实际执行了取消。
   */
  cancel(): boolean {
    if (this.status === 'idle' || !this.baseline) return false;
    const baseline = this.baseline;
    this.clearTimer();
    this.status = 'idle';
    this.baseline = null;
    this.index = -1;
    try {
      this.apply(baseline);
    } catch (err) {
      this.setError(`取消后恢复原画面失败：${(err as Error).message}`);
    }
    this.emit();
    return true;
  }

  /** 中断：停机但保留当前画面（不回滚 baseline）。 */
  interrupt(): boolean {
    if (this.status === 'idle' && this.timer === null) return false;
    this.clearTimer();
    this.status = 'idle';
    this.baseline = null;
    this.emit();
    return true;
  }

  /** 跳转到指定检查点（任意状态可用；播放中会先中断定时推进再应用）。 */
  seek(targetIndex: number): void {
    if (this.checkpoints.length === 0) {
      this.setError('时间轴为空');
      this.emit();
      return;
    }
    const clamped = Math.max(0, Math.min(this.checkpoints.length - 1, targetIndex));
    const wasPlaying = this.status === 'playing';
    const sameIndex = clamped === this.index;
    if (wasPlaying || this.status === 'paused') this.clearTimer();
    if (!sameIndex) {
      // 目标就是当前帧：不重复 apply（避免播放起点被二次写入）。
      try {
        this.apply(this.checkpoints[clamped]);
      } catch (err) {
        this.status = 'idle';
        this.baseline = null;
        this.setError(`跳转失败：${(err as Error).message}`);
        this.emit();
        return;
      }
      this.index = clamped;
    }
    this.status = wasPlaying ? 'playing' : 'idle';
    if (!wasPlaying) this.baseline = null;
    this.error = null;
    this.emit();
    if (wasPlaying) {
      // clearTimer 已推进代数，基于新代数重新调度后续帧。
      this.scheduleNext(this.generation);
    }
  }

  /** 仅在 idle 状态允许追加新检查点（保证不会与回放竞争）。 */
  addCheckpoint(checkpoint: ExperimentCheckpoint): void {
    if (this.status !== 'idle') {
      throw new Error('回放进行中，不能追加检查点（请先中断）');
    }
    if (this.checkpoints.some((cp) => cp.id === checkpoint.id)) {
      throw new Error(`检查点 id 已存在：${checkpoint.id}`);
    }
    this.checkpoints = [...this.checkpoints, checkpoint];
    this.error = null;
    this.emit();
  }

  /**
   * 原子替换整条时间轴：先停机清定时器，再切换引用。
   * 新数据由调用方保证已通过严格解码；首帧的实时应用由调用方在替换前完成，
   * 这样“应用失败”时旧时间轴仍然保留（见 SessionController.importFile）。
   */
  load(checkpoints: readonly ExperimentCheckpoint[]): void {
    this.clearTimer();
    this.status = 'idle';
    this.baseline = null;
    this.checkpoints = checkpoints;
    this.index = 0;
    this.error = null;
    this.emit();
  }

  reset(): void {
    this.clearTimer();
    this.status = 'idle';
    this.baseline = null;
    this.checkpoints = [];
    this.index = 0;
    this.error = null;
    this.emit();
  }

  /** 销毁：作废在途定时器、断开订阅。之后实例不应再使用。 */
  destroy(): void {
    this.clearTimer();
    this.status = 'idle';
    this.baseline = null;
    this.timer = null;
    this.listeners.clear();
  }
}
