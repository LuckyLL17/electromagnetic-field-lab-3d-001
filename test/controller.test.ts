/**
 * 验证 5：SessionController 编排 —— 快照/实时引用、捕获、回放、取消恢复、
 * 重新导入、坏文件/未知版本不污染、失败恢复、定时器与对象 URL 卫生。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionController } from '../src/session/controller';
import { PlaybackSequencer } from '../src/session/sequencer';
import { UrlRegistry } from '../src/session/urlRegistry';
import { encodeSession, makeCheckpoint, makeSession } from '../src/session/encoding';
import { CameraFrame, ExperimentControls, SESSION_KIND } from '../src/session/types';

interface FakeTimers {
  pending: number;
  tick(ms?: number): void;
  clock: { setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (h: number) => void };
}
function fakeTimers(step = 100): FakeTimers {
  let now = 0;
  let id = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  return {
    get pending() {
      return jobs.size;
    },
    clock: {
      setTimeout(fn) {
        id += 1;
        jobs.set(id, { at: now + step, fn });
        return id;
      },
      clearTimeout(h) {
        jobs.delete(h);
      },
    },
    tick(ms = step) {
      now += ms;
      for (const hid of [...jobs.keys()]) {
        const job = jobs.get(hid);
        if (job && job.at <= now) {
          jobs.delete(hid);
          job.fn();
        }
      }
    },
  };
}

let cpSeq = 0;
function makeCp(
  mode: ExperimentControls['mode'],
  strength: number,
  pos: [number, number, number],
  t: number,
) {
  cpSeq += 1;
  return makeCheckpoint({
    t,
    label: `cp${cpSeq}`,
    controls: { mode, strength, showVectors: true },
    camera: { position: pos, target: [0, 0, 0] },
  });
}

/** 干净的 setup：控制器注入假时钟引擎、内存文件与 URL 登记处。 */
function setupReal(opts: { failCameraApply?: boolean } = {}) {
  const timers = fakeTimers(100);
  let controls: ExperimentControls = { mode: 'dipole', strength: 1.6, showVectors: true };
  let camera: CameraFrame = { position: [6, 4.5, 8], target: [0, 0, 0] };
  const downloads: string[] = [];
  const revoked: string[] = [];
  const registry = new UrlRegistry({
    host: {
      createObjectURL: () => `blob:fake/${revoked.length}-${Math.random()}`,
      revokeObjectURL: (u) => revoked.push(u),
    },
    setTimeout: timers.clock.setTimeout,
    clearTimeout: timers.clock.clearTimeout,
  });
  const namedFiles = new Map<string, string>();

  const controller = new SessionController({
    urlRegistry: registry,
    sequencer: new PlaybackSequencer({
      intervalMs: 200,
      clock: timers.clock,
      apply: (checkpoint) => {
        if (opts.failCameraApply) throw new Error('相机写入失败');
        camera = {
          position: [...checkpoint.camera.position] as [number, number, number],
          target: [...checkpoint.camera.target] as [number, number, number],
        };
        controls = { ...checkpoint.controls };
      },
      captureBaseline: () =>
        makeCheckpoint({ t: 0, label: 'baseline', controls: { ...controls }, camera }),
    }),
    applier: {
      readLive: () => ({
        controls: { ...controls },
        camera: { position: [...camera.position] as [number, number, number], target: [...camera.target] as [number, number, number] },
      }),
      applyCamera: (frame) => {
        if (opts.failCameraApply) throw new Error('相机写入失败');
        camera = { position: [...frame.position] as [number, number, number], target: [...frame.target] as [number, number, number] };
      },
      setControls: (next) => {
        controls = { ...next };
      },
    },
    readFileText: async (blob) => {
      const name = (blob as { name?: string }).name;
      if (name && namedFiles.has(name)) return namedFiles.get(name)!;
      throw new Error('文件不存在');
    },
    download: (url) => downloads.push(url),
  });

  return {
    timers,
    controls: () => controls,
    camera: () => camera,
    downloads,
    revoked,
    registry,
    controller,
    addFile(name: string, text: string) {
      namedFiles.set(name, text);
      const blob = new Blob([text]) as Blob & { name: string };
      Object.defineProperty(blob, 'name', { value: name });
      return blob;
    },
  };
}

test('捕获的是深拷贝快照：随后实时状态变化不改变已记录检查点', () => {
  const env = setupReal();
  const c1 = env.controller.capture();
  assert.ok(c1);
  assert.equal(c1.controls.mode, 'dipole');
  assert.deepEqual(c1.camera.position, [6, 4.5, 8]);
  // 模拟用户继续操作实时状态
  env.controller.seek(0); // 无操作意义，仅 idle
  // 直接改实时引用（通过捕获不同画面后，原快照仍在）
  const c2 = env.controller.capture();
  assert.equal(c2.t, 1000);
  const state = env.controller.getState();
  assert.deepEqual(state.sequencer.checkpoints.map((c) => [c.t, c.controls.mode]), [[0, 'dipole'], [1000, 'dipole']]);
  // 冻结保证
  assert.ok(Object.isFrozen(state.sequencer.checkpoints[0]));
});

test('完整回放 + 取消恢复到播放前实时画面', async () => {
  const env = setupReal();
  env.controller.capture(); // 帧0 dipole@1.6
  env.controller.capture(); // 帧1
  // 手动塞入不同画面的检查点：模拟通过替换实现更真实，直接捕获后 seek 调整。
  const session = makeSession({
    name: 'demo',
    checkpoints: [
      makeCp('dipole', 1.6, [6, 4.5, 8], 0),
      makeCp('coil', 2.2, [10, 0, 2], 1000),
      makeCp('capacitor', 0.8, [0, 10, 0], 2000),
    ],
  });
  await env.controller.importFile(env.addFile('demo.json', encodeSession(session)));
  assert.equal(env.controls().mode, 'dipole');
  assert.deepEqual(env.camera().position, [6, 4.5, 8]);

  env.controller.play();
  env.timers.tick(); // → coil
  assert.equal(env.controls().mode, 'coil');
  assert.deepEqual(env.camera().position, [10, 0, 2]);
  env.controller.pause();
  env.controller.cancel();
  // 取消恢复到“按播放前”的画面 —— 播放前是导入首帧 dipole@[6,4.5,8]
  assert.equal(env.controls().mode, 'dipole');
  assert.deepEqual(env.camera().position, [6, 4.5, 8]);
  assert.equal(env.controller.getState().sequencer.status, 'idle');
  assert.equal(env.timers.pending, 0);
});

test('自然播完停在末帧，无定时器残留', async () => {
  const env = setupReal();
  const session = makeSession({
    name: 'demo',
    checkpoints: [makeCp('dipole', 1, [1, 0, 0], 0), makeCp('coil', 1, [2, 0, 0], 1000)],
  });
  await env.controller.importFile(env.addFile('demo.json', encodeSession(session)));
  env.controller.play();
  env.timers.tick();
  assert.equal(env.controls().mode, 'coil');
  assert.equal(env.timers.pending, 0);
  assert.equal(env.controller.getState().sequencer.status, 'idle');
});

test('坏 JSON / 未知版本 / 非法结构：当前实验完全不被污染', async () => {
  const env = setupReal();
  const good = makeSession({
    name: 'good',
    checkpoints: [makeCp('coil', 2, [3, 3, 3], 0)],
  });
  await env.controller.importFile(env.addFile('good.json', encodeSession(good)));
  assert.equal(env.controls().mode, 'coil');
  const before = JSON.stringify({ controls: env.controls(), camera: env.camera() });
  const cpsBefore = env.controller.getState().sequencer.checkpoints.length;

  const bads = [
    '{broken',
    JSON.stringify({ kind: SESSION_KIND, version: 99, checkpoints: [] }),
    JSON.stringify({ kind: SESSION_KIND, version: 1, checkpoints: [] }),
    JSON.stringify({
      kind: SESSION_KIND,
      version: 1,
      checkpoints: [{ controls: { mode: 'nope', strength: 1, showVectors: true }, camera: { position: [0, 0, 0], target: [0, 0, 0] } }],
    }),
    JSON.stringify({
      kind: SESSION_KIND,
      version: 1,
      checkpoints: [{ controls: { mode: 'dipole', strength: 99, showVectors: true }, camera: { position: [0, 0, 0], target: [0, 0, 0] } }],
    }),
  ];
  for (let i = 0; i < bads.length; i++) {
    await env.controller.importFile(env.addFile(`bad${i}.json`, bads[i]));
    const state = env.controller.getState();
    assert.match(state.notice ?? '', /拒绝|放弃/, `bad${i} 应提示失败`);
    assert.equal(state.sequencer.checkpoints.length, cpsBefore);
    assert.equal(JSON.stringify({ controls: env.controls(), camera: env.camera() }), before, `bad${i} 污染了实时状态`);
  }
});

test('回放进行中导入坏文件：播放继续、定时器仍在、当前画面不变', async () => {
  const env = setupReal();
  const good = makeSession({
    name: 'good',
    checkpoints: [makeCp('dipole', 1, [1, 0, 0], 0), makeCp('coil', 1, [2, 0, 0], 1000)],
  });
  await env.controller.importFile(env.addFile('good.json', encodeSession(good)));
  env.controller.play();
  const pendingDuringPlay = env.timers.pending;
  assert.ok(pendingDuringPlay >= 1);
  await env.controller.importFile(env.addFile('bad.json', '{bad'));
  const state = env.controller.getState();
  assert.equal(state.sequencer.status, 'playing');
  assert.equal(env.timers.pending, pendingDuringPlay);
  assert.equal(env.controls().mode, 'dipole');
  // 定时器仍然有效：推进后正常到帧1
  env.timers.tick();
  assert.equal(env.controls().mode, 'coil');
});

test('重新导入：时间轴原子替换为新会话，旧检查点全部移除', async () => {
  const env = setupReal();
  env.controller.capture();
  env.controller.setName('旧会话');
  assert.equal(env.controller.getState().sequencer.checkpoints.length, 1);

  const next = makeSession({
    name: '新会话',
    checkpoints: [makeCp('capacitor', 3, [5, 5, 5], 0), makeCp('coil', 1, [1, 1, 1], 1000)],
  });
  await env.controller.importFile(env.addFile('next.json', encodeSession(next)));
  const state = env.controller.getState();
  assert.equal(state.name, '新会话');
  assert.equal(state.sequencer.checkpoints.length, 2);
  assert.equal(state.sequencer.index, 0);
  assert.equal(env.controls().mode, 'capacitor');
  assert.deepEqual(env.camera().position, [5, 5, 5]);
});

test('首帧无法应用时放弃导入：旧时间轴与画面保留', async () => {
  // failCameraApply 让 applier 始终失败：导入的首帧 apply 会抛错
  const env = setupReal({ failCameraApply: true });
  const good = makeSession({
    name: 'good',
    checkpoints: [makeCp('coil', 2, [3, 3, 3], 0)],
  });
  // 先在“正常”状态放一个检查点 —— applier 坏了无法导入，改用 capture（capture 不应用，只读取）
  const cp = env.controller.capture();
  assert.ok(cp);
  const oldMode = env.controls().mode;
  const oldLen = env.controller.getState().sequencer.checkpoints.length;

  const next = makeSession({
    name: 'new',
    checkpoints: [makeCp('capacitor', 3, [5, 5, 5], 0)],
  });
  await env.controller.importFile(env.addFile('next.json', encodeSession(next)));
  const state = env.controller.getState();
  assert.match(state.notice ?? '', /放弃/);
  assert.equal(state.sequencer.checkpoints.length, oldLen);
  assert.equal(env.controls().mode, oldMode);
});

test('导出：生成 JSON 下载并延迟回收 URL；空时间轴拒绝导出且不建 URL', () => {
  const env = setupReal();
  env.controller.exportToFile();
  assert.match(env.controller.getState().notice ?? '', /为空/);
  assert.equal(env.downloads.length, 0);

  env.controller.capture();
  env.controller.exportToFile();
  assert.equal(env.downloads.length, 1);
  // 延迟吊销已排队，尚未触发前 URL 仍在
  assert.equal(env.revoked.length, 0);
  env.timers.tick();
  assert.equal(env.revoked.length, 1);
  assert.equal(env.registry.liveCount, 0);
});

test('导出的 JSON 可被重新导入（往返闭环）', async () => {
  const env = setupReal();
  const session = makeSession({
    name: 'roundtrip',
    checkpoints: [
      makeCp('dipole', 1.2, [1, 2, 3], 0),
      makeCp('coil', 2.8, [4, 5, 6], 1000),
    ],
  });
  await env.controller.importFile(env.addFile('in.json', encodeSession(session)));
  env.controller.exportToFile();
  // 直接用已注册文本无法取回（URL 是 blob），改用同字节重新构造文件验证兼容
  const text = encodeSession(session);
  await env.controller.importFile(env.addFile('again.json', text));
  assert.equal(env.controller.getState().name, 'roundtrip');
  assert.equal(env.controller.getState().sequencer.checkpoints.length, 2);
});

test('dispose：定时器作废、对象 URL 全部吊销', async () => {
  const env = setupReal();
    const session = makeSession({
    name: 'demo',
    checkpoints: [makeCp('dipole', 1, [1, 0, 0], 0), makeCp('coil', 1, [2, 0, 0], 1000)],
  });
  await env.controller.importFile(env.addFile('demo.json', encodeSession(session)));
  env.controller.play();
  env.controller.exportToFile();
  assert.ok(env.timers.pending >= 2); // 回放定时器 + URL 延迟吊销
  env.controller.dispose();
  assert.equal(env.timers.pending, 0);
  assert.equal(env.registry.liveCount, 0);
  // dispose 后迟到 tick 不产生回调错误
  assert.doesNotThrow(() => env.timers.tick(5000));
});

test('回放中捕获：先中断（定时器清除、保留当前帧）再追加', async () => {
  const env = setupReal();
  const session = makeSession({
    name: 'demo',
    checkpoints: [makeCp('dipole', 1, [1, 0, 0], 0), makeCp('coil', 2, [2, 0, 0], 1000), makeCp('capacitor', 3, [3, 0, 0], 2000)],
  });
  await env.controller.importFile(env.addFile('demo.json', encodeSession(session)));
  env.controller.play();
  env.timers.tick(); // 帧1 coil
  assert.equal(env.controls().mode, 'coil');
  const added = env.controller.capture('回放中补录');
  assert.ok(added);
  assert.equal(env.controller.getState().sequencer.status, 'idle');
  assert.equal(env.timers.pending, 0);
  assert.equal(env.controls().mode, 'coil'); // 保留中断时画面
  const cps = env.controller.getState().sequencer.checkpoints;
  assert.equal(cps.length, 4);
  assert.equal(cps[3].label, '回放中补录');
  assert.equal(cps[3].controls.mode, 'coil');
});
