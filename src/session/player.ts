/**
 * TimelinePlayer —— 时间轴回放内核（与 React/DOM 解耦，可注入时钟便于测试）。
 *
 * 设计要点：
 *  - 全程只使用【单个】 requestAnimationFrame 句柄；暂停、取消、结束、销毁
 *    都会同步取消并清空句柄，保证“不残留定时器”。
 *  - 每次应用检查点前先比对 index，相同检查点不重复通知，避免多余的
 *    React 状态提交。
 *  - 帧间隔会被 clamp，浏览器切后台再切回不会让时间轴瞬间跳到头。
 *  - 取消（cancel）= 放弃本次回放并由宿主恢复播放前基线；
 *    自然结束（finish）= 停留最后一个检查点并进入 ended。
 */
import { activeCheckpointIndex } from './checkpoints.js';
import type { PlaybackStatus, SessionCheckpoint } from './types';

/** 可替换的时钟，测试时注入同步假时钟，生产环境用 rAF + performance.now */
export interface TimelineClock {
  now(): number;
  requestFrame(cb: (time: number) => void): number;
  cancelFrame(handle: number): void;
}

export const rafClock: TimelineClock = {
  now: () => performance.now(),
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (h) => cancelAnimationFrame(h),
};

export interface PlayerHandlers {
  /** 原子应用某个检查点（宿主负责把控制区与三维场景一次性同步） */
  onApply: (checkpoint: SessionCheckpoint, index: number) => void;
  /** 用户取消：宿主恢复播放开始前捕获的基线快照 */
  onCancel: () => void;
  /** 自然播放完毕：停留在最后一个检查点 */
  onFinish: () => void;
  /** 状态/进度变化（仅在真正变化时触发，供 UI 更新） */
  onStatusChange?: (status: PlaybackStatus, elapsed: number, index: number) => void;
}

const MAX_FRAME_DELTA = 100; // ms，切后台后的单帧上限

export class TimelinePlayer {
  private checkpoints: readonly SessionCheckpoint[];
  private handlers: PlayerHandlers;
  private clock: TimelineClock;
  private duration: number;

  private rafHandle: number | null = null;
  private status: PlaybackStatus = 'idle';
  private elapsed = 0;
  private lastFrameTime = 0;
  private index = 0;

  constructor(
    checkpoints: readonly SessionCheckpoint[],
    handlers: PlayerHandlers,
    clock: TimelineClock = rafClock,
  ) {
    this.checkpoints = checkpoints;
    this.handlers = handlers;
    this.clock = clock;
    this.duration = checkpoints.length ? checkpoints[checkpoints.length - 1].at : 0;
  }

  getStatus(): PlaybackStatus {
    return this.status;
  }
  getElapsed(): number {
    return this.elapsed;
  }
  getIndex(): number {
    return this.index;
  }
  getDuration(): number {
    return this.duration;
  }

  /**
   * 开始（或结束后重新播放）。首个检查点立即原子应用。
   * 零时长会话（所有检查点都在 at=0）直接结束。
   */
  start(): void {
    if (this.status === 'playing' || this.status === 'paused') return;
    this.status = 'playing';
    this.elapsed = 0;
    this.index = -1; // 强制首个检查点必定通知一次
    this.applyCurrent(0);
    if (this.duration <= 0) {
      this.finish();
      return;
    }
    this.lastFrameTime = this.clock.now();
    this.rafHandle = this.clock.requestFrame(this.frame);
    this.emit();
  }

  private frame = (time: number): void => {
    this.rafHandle = null;
    if (this.status !== 'playing') return;
    const delta = Math.min(MAX_FRAME_DELTA, Math.max(0, time - this.lastFrameTime));
    this.lastFrameTime = time;
    const next = Math.min(this.duration, this.elapsed + delta);
    this.elapsed = next;
    this.applyCurrent(activeCheckpointIndex(this.checkpoints, next));
    if (next >= this.duration) {
      this.finish();
      return;
    }
    this.rafHandle = this.clock.requestFrame(this.frame);
    this.emit();
  };

  private finish(): void {
    this.stopFrame();
    this.status = 'ended';
    this.elapsed = this.duration;
    this.applyCurrent(this.checkpoints.length - 1);
    this.handlers.onFinish();
    this.emit();
  }

  /** 仅当下标变化时才原子应用检查点，避免重复提交同一状态 */
  private applyCurrent(index: number): void {
    if (index === this.index) return;
    this.index = index;
    this.handlers.onApply(this.checkpoints[index], index);
  }

  pause(): void {
    if (this.status !== 'playing') return;
    this.status = 'paused';
    this.stopFrame();
    this.emit();
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.status = 'playing';
    this.lastFrameTime = this.clock.now();
    this.rafHandle = this.clock.requestFrame(this.frame);
    this.emit();
  }

  /** 拖动时间轴到指定毫秒。暂停/播放/结束状态都可 seek */
  seek(elapsed: number): void {
    if (this.status === 'idle') return;
    this.elapsed = Math.min(this.duration, Math.max(0, elapsed));
    this.applyCurrent(activeCheckpointIndex(this.checkpoints, this.elapsed));
    if (this.status === 'ended' && this.elapsed < this.duration) this.status = 'paused';
    if (this.status === 'playing') {
      // 重置帧基准，避免下一帧把 seek 前后的时间差补回来
      this.lastFrameTime = this.clock.now();
      if (this.rafHandle === null) this.rafHandle = this.clock.requestFrame(this.frame);
    }
    this.emit();
  }

  /**
   * 取消回放：停帧并通知宿主恢复基线快照。
   * 暂停/播放/结束状态均可取消（结束态取消 = 手动恢复当前实验）。
   */
  cancel(): void {
    if (statusIdle(this.status)) return;
    this.stopFrame();
    this.status = 'idle';
    this.elapsed = 0;
    this.index = 0;
    this.handlers.onCancel();
    this.emit();
  }

  /** 彻底释放：只停帧，不触发 onCancel（组件卸载时调用，避免对已卸载组件 setState） */
  dispose(): void {
    this.stopFrame();
    this.status = 'idle';
  }

  private stopFrame(): void {
    if (this.rafHandle !== null) {
      this.clock.cancelFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private emit(): void {
    this.handlers.onStatusChange?.(this.status, this.elapsed, Math.max(this.index, 0));
  }
}

function statusIdle(status: PlaybackStatus): boolean {
  return status === 'idle';
}
