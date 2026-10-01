/**
 * 验证 1：严格拒绝 / 兼容读取。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeSession,
  makeCheckpoint,
  makeSession,
  parseSessionText,
  SessionFormatError,
} from '../src/session/encoding';
import { SESSION_KIND } from '../src/session/types';

function cpJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a',
    t: 0,
    label: '第一帧',
    controls: { mode: 'dipole', strength: 1.6, showVectors: true },
    camera: { position: [6, 4.5, 8], target: [0, 0, 0] },
    ...over,
  };
}

function sessionJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: SESSION_KIND,
    version: 1,
    name: 's',
    createdAt: '2026-01-01T00:00:00.000Z',
    exportedAt: '2026-01-02T00:00:00.000Z',
    checkpoints: [cpJson()],
    ...over,
  });
}

function reject(label: string, text: string, fragment?: string) {
  test(`拒绝：${label}`, () => {
    assert.throws(
      () => parseSessionText(text),
      (err: unknown) => {
        assert.ok(err instanceof SessionFormatError, '必须是 SessionFormatError');
        if (fragment) assert.match((err as Error).message, new RegExp(fragment));
        return true;
      },
    );
  });
}

test('合法 v1 会话可解析且结果被冻结', () => {
  const s = parseSessionText(sessionJson());
  assert.equal(s.version, 1);
  assert.equal(s.checkpoints.length, 1);
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.isFrozen(s.checkpoints[0]));
  assert.ok(Object.isFrozen(s.checkpoints[0].controls));
  assert.ok(Object.isFrozen(s.checkpoints[0].camera.position));
});

test('往返：编码后再解析，字段完全一致', () => {
  const session = makeSession({
    name: '往返',
    createdAt: '2026-01-01T00:00:00.000Z',
    checkpoints: [
      makeCheckpoint({ t: 1000, label: 'b', controls: { mode: 'coil', strength: 2.2, showVectors: false }, camera: { position: [1, 2, 3], target: [0, 0, 0] } }),
      makeCheckpoint({ t: 0, label: 'a', controls: { mode: 'capacitor', strength: 0.5, showVectors: true }, camera: { position: [-1, -2, -3], target: [0, 1, 0] } }),
    ],
  });
  const text = encodeSession(session);
  const reparsed = parseSessionText(text);
  assert.deepEqual(reparsed, JSON.parse(text));
  // 导出/解析后按 t 有序
  assert.deepEqual(reparsed.checkpoints.map((c) => c.t), [0, 1000]);
});

reject('损坏 JSON', '{not json', 'JSON');
reject('根是数组', '[]', '对象');
reject('kind 不匹配', sessionJson({ kind: 'other' }), '标识');
reject('未知版本 version=2', sessionJson({ version: 2 }), '未知');
reject('版本是字符串', sessionJson({ version: '1' }), '未知');
reject('checkpoints 为空', sessionJson({ checkpoints: [] }), '非空');
reject('checkpoints 缺失', sessionJson({ checkpoints: undefined }), '非空');
reject('非法场型', sessionJson({ checkpoints: [cpJson({ controls: { mode: 'plasma', strength: 1, showVectors: true } })] }), 'mode');
reject('强度是字符串', sessionJson({ checkpoints: [cpJson({ controls: { mode: 'dipole', strength: 'x', showVectors: true } })] }), 'strength');
reject('强度 NaN', sessionJson({ checkpoints: [cpJson({ controls: { mode: 'dipole', strength: Number.NaN, showVectors: true } })] }), '有限');
reject('强度越界', sessionJson({ checkpoints: [cpJson({ controls: { mode: 'dipole', strength: 5, showVectors: true } })] }), '超出');
reject('矢量开关非布尔', sessionJson({ checkpoints: [cpJson({ controls: { mode: 'dipole', strength: 1, showVectors: 1 } })] }), '布尔');
reject('相机位置长度不对', sessionJson({ checkpoints: [cpJson({ camera: { position: [1, 2], target: [0, 0, 0] } })] }), '长度');
reject('相机含 Infinity', sessionJson({ checkpoints: [cpJson({ camera: { position: [1, 2, 1e999], target: [0, 0, 0] } })] }), '有限');
reject('负时间戳', sessionJson({ checkpoints: [cpJson({ t: -1 })] }), '非负');
reject('重复 id', sessionJson({ checkpoints: [cpJson({ id: 'x' }), cpJson({ id: 'x', t: 1000 })] }), '重复');

test('兼容：缺省 id/label/t/name/时间字段时合成，不拒绝', () => {
  const minimal = JSON.stringify({
    kind: SESSION_KIND,
    version: 1,
    checkpoints: [
      { controls: { mode: 'dipole', strength: 1, showVectors: true }, camera: { position: [0, 0, 0], target: [0, 0, 0] } },
      { controls: { mode: 'coil', strength: 1, showVectors: false }, camera: { position: [0, 0, 0], target: [0, 0, 0] } },
    ],
  });
  const s = parseSessionText(minimal);
  assert.equal(s.name, '未命名会话');
  assert.equal(s.checkpoints[0].id, 'cp-1');
  assert.equal(s.checkpoints[1].id, 'cp-2');
  assert.deepEqual(s.checkpoints.map((c) => c.t), [0, 1000]);
  assert.ok(typeof s.createdAt === 'string' && s.createdAt.length > 0);
});

test('兼容：未知额外字段被忽略', () => {
  const withExtra = sessionJson({ extra: 42, futureThing: { nested: true } });
  const s = parseSessionText(withExtra);
  assert.equal(s.checkpoints.length, 1);
  assert.equal((s as Record<string, unknown>).extra, undefined);
});

test('兼容：乱序检查点按 t 稳定排序', () => {
  const text = JSON.stringify({
    kind: SESSION_KIND,
    version: 1,
    checkpoints: [
      cpJson({ id: 'late', t: 3000 }),
      cpJson({ id: 'early', t: 1000 }),
      cpJson({ id: 'mid', t: 2000 }),
    ],
  });
  const s = parseSessionText(text);
  assert.deepEqual(s.checkpoints.map((c) => c.id), ['early', 'mid', 'late']);
});

test('解析结果不受输入对象后续突变影响（快照语义）', () => {
  const data = JSON.parse(sessionJson());
  const s = parseSessionText(JSON.stringify(data));
  data.checkpoints[0].controls.strength = 9;
  assert.equal(s.checkpoints[0].controls.strength, 1.6);
  // 冻结：严格模式下赋值抛错；非严格模式（测试 bundle）下静默失败但值不变。
  assert.ok(Object.isFrozen(s.checkpoints[0].controls));
  (s.checkpoints[0].controls as { strength: number }).strength = 3;
  assert.equal(s.checkpoints[0].controls.strength, 1.6);
});
