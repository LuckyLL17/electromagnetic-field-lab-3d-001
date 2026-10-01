/**
 * 验证 2：控制区与相机的原子同步（成功同帧、失败不污染、回滚一致）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCheckpoint, AtomicApplier, LiveSnapshot } from '../src/session/applyAtomic';
import { ExperimentCheckpoint } from '../src/session/types';

function cp(over: Partial<ExperimentCheckpoint['controls']> = {}): ExperimentCheckpoint {
  return {
    id: 'x',
    t: 0,
    label: 'x',
    controls: { mode: 'coil', strength: 2.4, showVectors: false, ...over },
    camera: { position: [1, 2, 3], target: [4, 5, 6] },
  };
}

/** 记录调用序列的假 applier。 */
function fakeApplier(opts: { failApplyCamera?: boolean; failSetControls?: boolean } = {}) {
  const events: string[] = [];
  const live: LiveSnapshot = {
    controls: { mode: 'dipole', strength: 1.1, showVectors: true },
    camera: { position: [6, 4.5, 8], target: [0, 0, 0] },
  };
  const applier: AtomicApplier = {
    readLive: () => {
      events.push('read');
      return {
        controls: { ...live.controls },
        camera: { position: [...live.camera.position] as [number, number, number], target: [...live.camera.target] as [number, number, number] },
      };
    },
    applyCamera: (frame) => {
      events.push('camera');
      if (opts.failApplyCamera) throw new Error('相机爆炸');
      live.camera = { position: [...frame.position], target: [...frame.target] };
    },
    setControls: (next) => {
      events.push('controls');
      if (opts.failSetControls) throw new Error('控件爆炸');
      live.controls = { ...next };
    },
  };
  return { applier, events, live };
}

test('成功路径：先读后相机再控件，同一次同步任务完成', () => {
  const { applier, events, live } = fakeApplier();
  applyCheckpoint(applier, cp());
  assert.deepEqual(events, ['read', 'camera', 'controls']);
  assert.deepEqual(live.controls, { mode: 'coil', strength: 2.4, showVectors: false });
  assert.deepEqual(live.camera, { position: [1, 2, 3], target: [4, 5, 6] });
});

test('相机失败：控制区完全不动', () => {
  const { applier, live } = fakeApplier({ failApplyCamera: true });
  assert.throws(() => applyCheckpoint(applier, cp()), /相机爆炸/);
  assert.deepEqual(live.controls, { mode: 'dipole', strength: 1.1, showVectors: true });
  assert.deepEqual(live.camera, { position: [6, 4.5, 8], target: [0, 0, 0] });
});

test('控件失败：相机回滚到调用前帧，两侧保持一致', () => {
  const { applier, events, live } = fakeApplier({ failSetControls: true });
  assert.throws(() => applyCheckpoint(applier, cp()), /控件爆炸/);
  // read → camera(新值) → controls(失败) → camera(回滚)
  assert.deepEqual(events, ['read', 'camera', 'controls', 'camera']);
  assert.deepEqual(live.controls, { mode: 'dipole', strength: 1.1, showVectors: true });
  assert.deepEqual(live.camera, { position: [6, 4.5, 8], target: [0, 0, 0] });
});

test('检查点快照不受后续实时状态突变影响', () => {
  const { applier, live } = fakeApplier();
  const checkpoint = cp();
  applyCheckpoint(applier, checkpoint);
  // 实时对象后续被用户改回去
  live.controls = { mode: 'capacitor', strength: 3, showVectors: true };
  // 再次应用同一检查点，数据仍是原值
  applyCheckpoint(applier, checkpoint);
  assert.equal(live.controls.mode, 'coil');
  assert.equal(live.controls.strength, 2.4);
});
