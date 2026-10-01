/**
 * 验证 4：对象 URL 生命周期 —— 立即吊销、延迟吊销、卸载兜底、不残留。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { UrlRegistry } from '../src/session/urlRegistry';

function fakeHost() {
  const created: string[] = [];
  const revoked: string[] = [];
  return {
    created,
    revoked,
    host: {
      createObjectURL: () => {
        const u = `blob:fake/${created.length}`;
        created.push(u);
        return u;
      },
      revokeObjectURL: (u: string) => {
        revoked.push(u);
      },
    },
  };
}

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let id = 0;
  return {
    pending,
    timers: {
      setTimeout: (fn: () => void) => {
        id += 1;
        pending.set(id, fn);
        return id;
      },
      clearTimeout: (h: number) => {
        pending.delete(h);
      },
    },
    runAll() {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((f) => f());
    },
  };
}

test('立即吊销：URL 被回收，重复吊销不重复通知', () => {
  const { host, revoked } = fakeHost();
  const reg = new UrlRegistry({ host });
  const u1 = reg.create(new Blob(['x']));
  reg.revokeNow(u1);
  reg.revokeNow(u1);
  assert.deepEqual(revoked, [u1]);
});

test('延迟吊销：tick 前仍 live，执行后回收', () => {
  const { host, revoked } = fakeHost();
  const timers = fakeTimers();
  const reg = new UrlRegistry({ host, setTimeout: timers.timers.setTimeout, clearTimeout: timers.timers.clearTimeout });
  const u1 = reg.create(new Blob(['x']));
  reg.revokeDeferred(u1);
  assert.equal(reg.liveCount, 1);
  assert.equal(revoked.length, 0);
  timers.runAll();
  assert.deepEqual(revoked, [u1]);
  assert.equal(reg.liveCount, 0);
});

test('卸载兜底：延迟吊销尚未触发时 revokeAll 立即回收全部 URL', () => {
  const { host, revoked } = fakeHost();
  const timers = fakeTimers();
  const reg = new UrlRegistry({ host, setTimeout: timers.timers.setTimeout, clearTimeout: timers.timers.clearTimeout });
  const urls = [reg.create(new Blob(['a'])), reg.create(new Blob(['b'])), reg.create(new Blob(['c']))];
  reg.revokeDeferred(urls[0]);
  reg.revokeDeferred(urls[1]);
  // 第3个连延迟都还没排
  reg.revokeAll();
  assert.equal(reg.liveCount, 0);
  assert.deepEqual([...revoked].sort(), [...urls].sort());
  // 挂起的延迟任务即便之后被误触发，也不会再回收（已清空）
  timers.runAll();
  assert.equal(revoked.length, 3);
});
