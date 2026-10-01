/**
 * 验证 3：时间轴回放引擎 —— 播放/暂停/继续/取消/中断/跳转/失败恢复/定时器卫生。
 * 使用手动假时钟，不依赖任何真实定时器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackSequencer } from '../src/session/sequencer';
import { ExperimentCheckpoint } from '../src/session/types';

let counter = 0;
function cp(t: number, mode: ExperimentCheckpoint['controls']['mode'] = 'dipole'): ExperimentCheckpoint {
  counter += 1;
  return {
    id: `cp-${counter}`,
    t,
    label: `帧${counter}`,
    controls: { mode, strength: 1, showVectors: true },
    camera: { position: [t, 0, 0], target: [0, 0, 0] },
  };
}

interface FakeClock {
  clock: { setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (h: number) => void };
  tick: (ms?: number) => void;
  pending: () => number;
}

function fakeClock(stepMs = 100): FakeClock {
  let now = 0;
  let id = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  return {
    clock: {
      setTimeout(fn) {
        id += 1;
        jobs.set(id, { at: now + stepMs, fn });
        return id;
      },
      clearTimeout(h) {
        jobs.delete(h);
      },
    },
    tick(ms = stepMs) {
      now += ms;
      // 复制后执行，执行中可能调度/取消任务。
      const due = [...jobs.entries()].filter(([, j]) => j.at <= now).map(([hid]) => hid);
      for (const hid of due) {
        const job = jobs.get(hid);
        if (job) {
          jobs.delete(hid);
          job.fn();
        }
      }
    },
    pending: () => jobs.size,
  };
}

function makeSequencer(opts: { failAt?: (index: number) => boolean; captureBaseline?: boolean } = {}) {
  const fc = fakeClock(100);
  const applied: number[] = [];
  const failAt = opts.failAt;
  const sequencer = new PlaybackSequencer({
    intervalMs: 200,
    clock: fc.clock,
    apply: (checkpoint) => {
      const idx = Number(checkpoint.t / 1000);
      applied.push(idx);
      if (failAt?.(idx)) throw new Error(`帧 ${idx} 应用失败`);
    },
    captureBaseline: opts.captureBaseline === false
      ? undefined
      : () => ({
          id: 'baseline',
          t: -1000,
          label: 'baseline',
          controls: { mode: 'capacitor', strength: 0.5, showVectors: false },
          camera: { position: [99, 99, 99], target: [0, 0, 0] },
        }),
  });
  const cps = [cp(0), cp(1000, 'coil'), cp(2000, 'capacitor')];
  cps.forEach((c) => sequencer.addCheckpoint(c));
  return { fc, sequencer, applied, cps };
}

test('播放逐帧推进，到末帧后自然停止且无残留定时器', () => {
  const { fc, sequencer, applied } = makeSequencer();
  sequencer.play();
  assert.equal(sequencer.getState().status, 'playing');
  assert.deepEqual(applied, [0]);
  fc.tick();
  assert.deepEqual(applied, [0, 1]);
  fc.tick();
  assert.deepEqual(applied, [0, 1, 2]);
  // 末帧不再调度
  assert.equal(fc.pending(), 0);
  assert.equal(sequencer.getState().status, 'idle');
  assert.equal(sequencer.getState().index, 2);
});

test('暂停后不再推进，继续后从下一帧继续', () => {
  const { fc, sequencer, applied } = makeSequencer();
  sequencer.play();
  fc.tick(); // 到帧1
  sequencer.pause();
  assert.equal(sequencer.getState().status, 'paused');
  fc.tick(1000); // 时间流逝也不触发
  assert.deepEqual(applied, [0, 1]);
  assert.equal(fc.pending(), 0);
  sequencer.resume();
  fc.tick();
  assert.deepEqual(applied, [0, 1, 2]);
  assert.equal(sequencer.getState().status, 'idle');
});

test('取消：停机、清定时器、原子恢复播放前的 baseline 画面', () => {
  const { fc, sequencer, applied } = makeSequencer();
  sequencer.play();
  fc.tick(); // 帧1
  sequencer.pause();
  const canceled = sequencer.cancel();
  assert.equal(canceled, true);
  assert.equal(sequencer.getState().status, 'idle');
  assert.equal(sequencer.getState().index, -1);
  // baseline 被应用（其 t=-1000，反映为 -1）
  assert.deepEqual(applied, [0, 1, -1]);
  assert.equal(fc.pending(), 0);
  fc.tick(5000);
  // 取消后绝无迟到推进
  assert.deepEqual(applied, [0, 1, -1]);
});

test('idle 状态 cancel 是安全空操作', () => {
  const { sequencer } = makeSequencer();
  assert.equal(sequencer.cancel(), false);
});

test('中断：保留当前帧、不回滚 baseline、清定时器', () => {
  const { fc, sequencer, applied } = makeSequencer();
  sequencer.play();
  fc.tick(); // 帧1
  sequencer.interrupt();
  assert.deepEqual(applied, [0, 1]); // 没有 -1 恢复
  assert.equal(sequencer.getState().status, 'idle');
  assert.equal(sequencer.getState().index, 1);
  fc.tick(5000);
  assert.deepEqual(applied, [0, 1]);
});

test('迟到回调保护：手动触发旧定时器不会推进状态', () => {
  const { fc, sequencer } = makeSequencer();
  let stale: (() => void) | null = null;
  const spy = {
    setTimeout: (fn: () => void, ms: number) => {
      const h = fc.clock.setTimeout(fn, ms);
      stale = fn;
      return h;
    },
    clearTimeout: (h: number) => fc.clock.clearTimeout(h),
  };
  // 用 spy 重建引擎以抓取首个推进回调
  counter = 0;
  const seq2 = new PlaybackSequencer({
    intervalMs: 200,
    clock: spy,
    apply: () => undefined,
  });
  [cp(0), cp(1000)].forEach((c) => seq2.addCheckpoint(c));
  seq2.play();
  seq2.interrupt(); // algebra 推进
  // 旧回调即便被外部误触发，也不得推进
  assert.doesNotThrow(() => stale?.());
  assert.equal(seq2.getState().index, 0);
  assert.equal(seq2.getState().status, 'idle');
});

test('应用中途失败：立即停机、停在原帧、暴露错误、无定时器残留', () => {
  const { fc, sequencer } = makeSequencer({ failAt: (i) => i === 1 });
  sequencer.play();
  fc.tick(); // 帧1 应用失败
  const s = sequencer.getState();
  assert.equal(s.status, 'idle');
  assert.equal(s.index, 0); // 停在原帧
  assert.match(s.error ?? '', /失败/);
  assert.equal(fc.pending(), 0);
});

test('首帧失败：状态机不启动', () => {
  const { sequencer } = makeSequencer({ failAt: (i) => i === 0 });
  sequencer.play();
  const s = sequencer.getState();
  assert.equal(s.status, 'idle');
  assert.equal(s.baseline, null);
  assert.match(s.error ?? '', /无法开始/);
});

test('seek：idle 下直接跳帧；播放中跳转到中间帧保持播放并重新调度', () => {
  const { fc, sequencer, applied } = makeSequencer();
  sequencer.seek(2);
  assert.deepEqual(applied, [2]);
  assert.equal(sequencer.getState().status, 'idle');

  sequencer.play(); // 从帧2（末帧）起播会自动回到帧0
  assert.deepEqual(applied, [2, 0]);
  sequencer.seek(1); // 播放中跳转：保持播放并基于新代数重新调度
  assert.equal(sequencer.getState().status, 'playing');
  assert.deepEqual(applied, [2, 0, 1]);
  fc.tick(); // 调度出的下一帧 2 正常到达
  assert.deepEqual(applied, [2, 0, 1, 2]);
  assert.equal(sequencer.getState().status, 'idle');
});

test('播放中 seek 到末帧：应用后立即收尾为 idle，无残留定时器', () => {
  const { fc, sequencer, applied } = makeSequencer();
  sequencer.play();
  sequencer.seek(2);
  assert.deepEqual(applied, [0, 2]);
  assert.equal(sequencer.getState().status, 'idle');
  assert.equal(fc.pending(), 0);
});

test('播放中 seek 到当前帧：不重复 apply，调度仍继续', () => {
  const { fc, sequencer, applied } = makeSequencer();
  sequencer.play();
  sequencer.seek(0);
  assert.deepEqual(applied, [0]);
  assert.equal(sequencer.getState().status, 'playing');
  fc.tick();
  assert.deepEqual(applied, [0, 1]);
});

test('空时间轴播放被拒绝且给出错误', () => {
  const fc = fakeClock();
  const seq = new PlaybackSequencer({ clock: fc.clock, apply: () => undefined });
  seq.play();
  assert.equal(seq.getState().status, 'idle');
  assert.match(seq.getState().error ?? '', /为空/);
});

test('destroy 清理定时器与订阅；销毁后通知不再触达', () => {
  const { fc, sequencer } = makeSequencer();
  let notified = 0;
  const unsub = sequencer.subscribe(() => {
    notified += 1;
  });
  sequencer.play();
  const before = notified;
  sequencer.destroy();
  assert.equal(fc.pending(), 0);
  fc.tick(5000);
  assert.equal(notified, before);
  // 订阅函数已注销
  assert.equal(unsub(), false);
});

test('订阅在每次状态变化时触发', () => {
  const { sequencer } = makeSequencer();
  let n = 0;
  sequencer.subscribe(() => {
    n += 1;
  });
  sequencer.play();
  sequencer.pause();
  sequencer.resume();
  sequencer.cancel();
  assert.ok(n >= 4);
});
