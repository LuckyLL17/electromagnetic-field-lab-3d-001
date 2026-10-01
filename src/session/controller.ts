/**
 * 实验会话编排器（框架无关，React 层只做薄绑定）。
 *
 * 关键取舍：
 * - 快照 vs 实时引用：每个检查点在 capture 瞬间深拷贝控制区与相机数据并冻结，
 *   之后回放/导出读取的都是不可变快照，绝不受实时 state 或 THREE 对象后续变化影响。
 * - 严格拒绝 / 兼容读取：parseSessionText 先全量解析+校验，通过后才触碰引擎；
 *   坏文件、未知版本在解析阶段就抛出，当前实验与定时器完全不动。
 * - 导入原子替换：解析通过 → 尝试应用目标检查点 → 成功才替换时间轴；
 *   应用失败则时间轴保持旧数据，当前画面零污染。
 * - 资源卫生：导出走 UrlRegistry（延迟吊销 + 卸载兜底）；导入用 FileReader
 *   读文本，全程不创建对象 URL。
 */
import {
  applyCheckpoint,
  AtomicApplier,
  LiveSnapshot,
} from './applyAtomic';
import {
  encodeSession,
  makeCheckpoint,
  makeSession,
  newSessionId,
  parseSessionText,
} from './encoding';
import {
  PlaybackSequencer,
  SequencerState,
} from './sequencer';
import {
  CHECKPOINT_T_STEP_MS,
  ExperimentCheckpoint,
  ExperimentSessionV1,
} from './types';
import { UrlRegistry } from './urlRegistry';

export interface ControllerState {
  name: string;
  createdAt: string;
  sessionId: string;
  sequencer: SequencerState;
  /** 最近一次面向用户的通知/错误；成功动作后清空。 */
  notice: string | null;
}

export interface SessionControllerEnv {
  applier: AtomicApplier;
  urlRegistry: UrlRegistry;
  /** 读取文件为文本（浏览器 FileReader；测试可注入）。 */
  readFileText(file: Blob): Promise<string>;
  /** 触发下载（浏览器注入 a.click；测试可注入捕获）。 */
  download(url: string, filename: string): void;
  sequencer?: PlaybackSequencer;
  intervalMs?: number;
}

function snapshotToCheckpoint(snapshot: LiveSnapshot): ExperimentCheckpoint {
  // 回放前的实时画面也走同一套不可变构造，capture 后与 THREE 对象脱钩。
  return makeCheckpoint({
    t: 0,
    label: '__baseline__',
    controls: snapshot.controls,
    camera: snapshot.camera,
  });
}

export class SessionController {
  private readonly env: SessionControllerEnv;
  private readonly sequencer: PlaybackSequencer;
  private readonly urlRegistry: UrlRegistry;
  private name = '未命名会话';
  private createdAt = new Date().toISOString();
  private sessionId = newSessionId();
  private notice: string | null = null;
  private readonly listeners = new Set<() => void>();
  private unsubscribeSequencer: () => void;

  constructor(env: SessionControllerEnv) {
    this.env = env;
    this.urlRegistry = env.urlRegistry;
    this.sequencer =
      env.sequencer ??
      new PlaybackSequencer({
        intervalMs: env.intervalMs,
        apply: (cp) => applyCheckpoint(env.applier, cp),
        captureBaseline: () => snapshotToCheckpoint(env.applier.readLive()),
      });
    this.unsubscribeSequencer = this.sequencer.subscribe(() => this.emit());
  }

  getState(): ControllerState {
    return {
      name: this.name,
      createdAt: this.createdAt,
      sessionId: this.sessionId,
      sequencer: this.sequencer.getState(),
      notice: this.notice,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private setNotice(message: string | null): void {
    this.notice = message;
  }

  // ---------------------------------------------------------------- 捕获

  /**
   * 捕获当前实时画面为不可变检查点。
   * 回放进行中：先中断（停机、清定时器，保留当前画面）再追加。
   * 读取/构造失败时只发通知，不动引擎（播放中也不会被误中断）。
   */
  capture(label?: string): ExperimentCheckpoint | null {
    let live: LiveSnapshot;
    try {
      live = this.env.applier.readLive();
    } catch (err) {
      this.fail(`捕获失败：${(err as Error).message}`);
      return null;
    }
    let cp: ExperimentCheckpoint;
    try {
      cp = makeCheckpoint({
        t: this.nextTimestamp(),
        label:
          label ?? `检查点 ${this.sequencer.getState().checkpoints.length + 1}`,
        controls: live.controls,
        camera: live.camera,
      });
    } catch (err) {
      this.fail(`捕获失败：${(err as Error).message}`);
      return null;
    }
    // 快照构造成功后才中断播放并追加，保证“坏捕获”不打断时间轴。
    this.sequencer.interrupt();
    this.sequencer.addCheckpoint(cp);
    this.setNotice(null);
    this.emit();
    return cp;
  }

  private nextTimestamp(): number {
    const cps = this.sequencer.getState().checkpoints;
    if (cps.length === 0) return 0;
    return cps[cps.length - 1].t + CHECKPOINT_T_STEP_MS;
  }

  // ----------------------------------------------------------- 回放控制

  play(): void {
    this.sequencer.play();
    this.setNotice(this.sequencer.getState().error ?? null);
    this.emit();
  }

  pause(): void {
    this.sequencer.pause();
    this.emit();
  }

  resume(): void {
    this.sequencer.resume();
    this.emit();
  }

  cancel(): void {
    this.sequencer.cancel();
    this.setNotice(this.sequencer.getState().error ?? null);
    this.emit();
  }

  interrupt(): void {
    this.sequencer.interrupt();
    this.emit();
  }

  seek(index: number): void {
    this.sequencer.seek(index);
    this.setNotice(this.sequencer.getState().error ?? null);
    this.emit();
  }

  setName(name: string): void {
    this.name = name;
    this.emit();
  }

  // ----------------------------------------------------------- 导入导出

  /**
   * 从文件导入。全流程保证：任何失败都不污染当前实验。
   * 1. FileReader 读文本（失败仅返回错误，引擎未被触碰）；
   * 2. parseSessionText 严格解析（坏 JSON/未知版本在此拒绝）；
   * 3. 原子应用首帧：失败则保留旧时间轴与当前画面；
   * 4. 全部成功才替换元数据与时间轴。
   */
  async importFile(file: Blob): Promise<void> {
    let text: string;
    try {
      text = await this.env.readFileText(file);
    } catch (err) {
      this.fail(`读取文件失败：${(err as Error).message}`);
      return;
    }

    let session: ExperimentSessionV1;
    try {
      session = parseSessionText(text);
    } catch (err) {
      this.fail(`导入被拒绝：${(err as Error).message}（当前实验未改动）`);
      return;
    }

    // 解析通过后，先尝试把首帧原子应用到实时界面（相机 + 控制区同帧）。
    try {
      applyCheckpoint(this.env.applier, session.checkpoints[0]);
    } catch (err) {
      this.fail(`首帧无法应用，已放弃导入：${(err as Error).message}（当前实验未改动）`);
      return;
    }

    // 应用成功：中断可能存在的播放（清定时器），原子替换时间轴并对齐到首帧。
    this.sequencer.interrupt();
    this.sequencer.load(session.checkpoints);
    this.name = session.name;
    this.createdAt = session.createdAt;
    this.sessionId = newSessionId();
    this.setNotice(`已导入会话「${session.name}」，共 ${session.checkpoints.length} 个检查点`);
    this.emit();
  }

  /** 导出当前会话为 JSON 下载；空时间轴拒绝（不创建任何 URL）。 */
  exportToFile(): void {
    const { checkpoints } = this.sequencer.getState();
    if (checkpoints.length === 0) {
      this.fail('时间轴为空，没有可导出的检查点');
      return;
    }
    const session = makeSession({
      name: this.name,
      createdAt: this.createdAt,
      checkpoints,
    });
    const blob = new Blob([encodeSession(session)], {
      type: 'application/json',
    });
    let url: string;
    try {
      url = this.urlRegistry.create(blob);
    } catch (err) {
      this.fail(`导出失败：${(err as Error).message}`);
      return;
    }
    try {
      const safeName = this.name.replace(/[\\/:*?"<>|\s]+/g, '_') || 'session';
      this.env.download(url, `${safeName}.json`);
      this.setNotice(`已导出 ${checkpoints.length} 个检查点`);
      this.emit();
    } finally {
      // 下载已同步触发；延迟一个 tick 吊销，卸载时 registry 兜底。
      this.urlRegistry.revokeDeferred(url);
    }
  }

  clear(): void {
    this.sequencer.reset();
    this.setNotice(null);
    this.emit();
  }

  private fail(message: string): void {
    this.setNotice(message);
    this.emit();
  }

  /** 销毁：停定时器、断订阅、吊销全部对象 URL。 */
  dispose(): void {
    this.sequencer.destroy();
    this.unsubscribeSequencer();
    this.urlRegistry.revokeAll();
    this.listeners.clear();
  }
}
