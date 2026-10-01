/* eslint-disable no-console */
/**
 * 实验会话核心逻辑验证（不依赖 React/DOM）：
 *   node 运行 tsc 编译后的产物：
 *   npx tsc -p scripts/tsconfig.test.json && node .tmp-test/verify-session.js
 */
import {
  appendCheckpoint,
  cloneLab,
  createSession,
  deepFreeze,
  parseSessionText,
  serializeSession,
  sessionDuration,
} from '../src/session/checkpoints.js';
import { TimelinePlayer, type TimelineClock } from '../src/session/player.js';
import { downloadJson, MAX_IMPORT_BYTES, readJsonFile, revokeAllObjectUrls } from '../src/session/io.js';
import type { LabState, PlaybackStatus, SessionCheckpoint } from '../src/session/types';

declare const process: { exit(code?: number): void };
declare const globalThis: {
  Blob: typeof Blob;
  URL: typeof URL;
  document: Document;
  setTimeout: typeof setTimeout;
  FileReader: typeof FileReader;
  crypto?: Crypto;
};

let passed = 0;
let failed = 0;

// ---- 最小 DOM 桩：让 io.ts 的下载/读取逻辑可在纯 Node 下验证 ----
function installDomStubs(
  created: string[],
  revoked: string[],
  clicks: string[],
): void {
  const anchors: { href: string; download: string; remove(): void; click(): void }[] = [];
  const fakeDocument = {
    createElement(tag: string) {
      if (tag === 'a') {
        const a = {
          href: '',
          download: '',
          rel: '',
          click() {
            clicks.push(a.href);
          },
          remove() {},
        };
        anchors.push(a);
        return a;
      }
      throw new Error(`unexpected tag ${tag}`);
    },
    body: { appendChild() {}, removeChild() {} },
  };
  (globalThis as { document?: unknown }).document = fakeDocument;
  const realUrl = globalThis.URL;
  (globalThis as { URL?: unknown }).URL = {
    createObjectURL(blob: Blob) {
      const url = `blob:stub/${created.length}`;
      created.push(url);
      void blob;
      return url;
    },
    revokeObjectURL(url: string) {
      revoked.push(url);
    },
  };
  (globalThis as { URL?: unknown; __realUrl?: unknown }).URL = Object.assign(
    (globalThis as { URL?: unknown }).URL as object,
    { __realUrl: realUrl },
  );

  // 最小 FileReader 桩：支持 readAsText 成功/失败路径
  class FakeFileReader {
    result: string | ArrayBuffer | null = null;
    error: { toString(): string } | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsText(file: File): void {
      if (file.size === 0 || file.size > MAX_IMPORT_BYTES) {
        this.error = { toString: () => 'stub error' };
        this.onerror?.();
        return;
      }
      file.text().then((t) => {
        this.result = t;
        this.onload?.();
      });
    }
  }
  (globalThis as { FileReader?: unknown }).FileReader = FakeFileReader;
}

function ok(cond: boolean, message: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}
function eq<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${message}（期望 ${e}，实际 ${a}）`);
}
function throws(fn: () => void, fragment: string, message: string): void {
  try {
    fn();
    ok(false, `${message}（应当抛出包含「${fragment}」的错误）`);
  } catch (err) {
    ok((err as Error).message.includes(fragment), `${message}（错误信息应包含「${fragment}」，实际：${(err as Error).message}）`);
  }
}

/** 同步假时钟：手动 step(ms) 推进，每个 step 只派发一帧 */
class FakeClock implements TimelineClock {
  private t = 0;
  private seq = 1;
  pending = new Map<number, (time: number) => void>();
  now(): number {
    return this.t;
  }
  requestFrame(cb: (time: number) => void): number {
    const h = this.seq++;
    this.pending.set(h, cb);
    return h;
  }
  cancelFrame(h: number): void {
    this.pending.delete(h);
  }
  step(ms: number): void {
    this.t += ms;
    const cbs = [...this.pending.values()];
    this.pending.clear();
    for (const cb of cbs) cb(this.t);
  }
  pendingCount(): number {
    return this.pending.size;
  }
}

const baseLab: LabState = {
  mode: 'dipole',
  strength: 1.6,
  showVectors: true,
  camera: { position: [6, 4.5, 8], target: [0, 0, 0] },
};

function cp(partial: Partial<SessionCheckpoint> & { at: number }, i = 0): SessionCheckpoint {
  return deepFreeze({
    id: `cp-${i}`,
    label: `检查点 ${i + 1}`,
    ...cloneLab(baseLab),
    ...partial,
  }) as SessionCheckpoint;
}

console.log('— 不可变检查点与快照隔离 —');
{
  let session = createSession();
  const lab = cloneLab(baseLab);
  session = appendCheckpoint(session, lab, 0);
  // 录制后再改外部对象，快照不得受影响（快照/实时引用隔离）
  lab.mode = 'coil';
  lab.camera.position[0] = 999;
  eq(session.checkpoints[0].mode, 'dipole', '快照不受外部场型变更影响');
  eq(session.checkpoints[0].camera.position[0], 6, '快照相机不受外部相机变更影响');
  ok(Object.isFrozen(session) && Object.isFrozen(session.checkpoints[0]), '会话与检查点被深冻结');
  throws(() => {
    (session.checkpoints[0] as unknown as { mode: string }).mode = 'coil';
  }, '', '严格模式下修改冻结检查点应抛错');

  const s2 = appendCheckpoint(session, { ...baseLab, mode: 'coil' }, 1000);
  ok(s2 !== session && session.checkpoints.length === 1, '追加返回新会话，原会话不变');
  eq(s2.checkpoints[1].mode, 'coil', '新检查点内容正确');

  const s3 = appendCheckpoint(session, baseLab, -50);
  eq(s3.checkpoints[0].at, 0, '负时间戳被钳为 0');
  const s4 = appendCheckpoint(s2, baseLab, 500); // 比上一检查点 1000 早
  eq(s4.checkpoints[2].at, 1000, '递减时间戳被钳为非递减');
}

console.log('— 序列化往返 —');
{
  let session = createSession('演示会话');
  session = appendCheckpoint(session, baseLab, 0);
  session = appendCheckpoint(session, { ...baseLab, mode: 'coil', strength: 2.2 }, 1500);
  const restored = parseSessionText(serializeSession(session));
  eq(restored.name, '演示会话', '往返后名称一致');
  eq(restored.checkpoints.length, 2, '往返后检查点数量一致');
  eq(restored.checkpoints[1].mode, 'coil', '往返后场型一致');
  eq(restored.checkpoints[1].strength, 2.2, '往返后强度一致');
  eq(sessionDuration(restored), 1500, '总时长为最后检查点时间');
}

console.log('— 严格拒绝 vs 兼容读取 —');
{
  let good = createSession();
  good = appendCheckpoint(good, baseLab, 0);
  const goodJson = JSON.parse(serializeSession(good));

  throws(() => parseSessionText('{not json'), '不是合法的 JSON', '坏 JSON 被拒绝');
  throws(() => parseSessionText('[1,2]'), '顶层结构', '非对象顶层被拒绝');
  throws(() => parseSessionText(JSON.stringify({ ...goodJson, format: 'nope' })), 'format', '未知 format 被拒绝');
  throws(() => parseSessionText(JSON.stringify({ ...goodJson, version: 2 })), '版本', '未知版本 v2 严格拒绝');
  throws(() => parseSessionText(JSON.stringify({ ...goodJson, version: '1' })), '版本', '字符串版本号被拒绝');
  const noCps = { ...goodJson };
  delete (noCps as { checkpoints?: unknown }).checkpoints;
  throws(() => parseSessionText(JSON.stringify(noCps)), 'checkpoints', '缺少 checkpoints 被拒绝');
  const empty = { ...goodJson, checkpoints: [] };
  throws(() => parseSessionText(JSON.stringify(empty)), '至少需要', '空检查点列表被拒绝');

  const badField = JSON.parse(JSON.stringify(goodJson));
  badField.checkpoints[0].mode = 'wormhole';
  throws(() => parseSessionText(JSON.stringify(badField)), '场型', '未知场型被拒绝');
  const badStrength = JSON.parse(JSON.stringify(goodJson));
  badStrength.checkpoints[0].strength = 99;
  throws(() => parseSessionText(JSON.stringify(badStrength)), '超出范围', '越界强度被拒绝');
  const nanStrength = JSON.parse(JSON.stringify(goodJson));
  nanStrength.checkpoints[0].strength = NaN;
  throws(() => parseSessionText(JSON.stringify(nanStrength)), 'strength', 'NaN 经 JSON 变为 null，按缺失字段拒绝');
  const missingCam = JSON.parse(JSON.stringify(goodJson));
  delete (missingCam.checkpoints[0] as { camera?: unknown }).camera;
  throws(() => parseSessionText(JSON.stringify(missingCam)), 'camera', '检查点缺相机被拒绝');
  const decreasing = JSON.parse(JSON.stringify(goodJson));
  decreasing.checkpoints.unshift(JSON.parse(JSON.stringify(decreasing.checkpoints[0])));
  decreasing.checkpoints[0].at = 100;
  decreasing.checkpoints[1].at = 0;
  throws(() => parseSessionText(JSON.stringify(decreasing)), '非递减', '时间戳递减被拒绝');

  // 兼容读取：多余字段 + 元数据缺失仍可打开
  const tolerant = JSON.parse(JSON.stringify(goodJson));
  tolerant.futureFeature = { nested: true };
  tolerant.checkpoints[0].experimental = 42;
  delete tolerant.name;
  delete tolerant.id;
  delete tolerant.createdAt;
  const parsed = parseSessionText(JSON.stringify(tolerant));
  eq(parsed.checkpoints.length, 1, '含多余字段的文件仍可读取');
  ok(parsed.name.length > 0 && parsed.id.length > 0, '缺失元数据自动补全');
  ok(!('futureFeature' in parsed), '顶层多余字段被丢弃');
}

console.log('— 时间轴回放：播放 / 暂停 / 继续 / 取消 / 重播 / seek —');
{
  const clock = new FakeClock();
  const applied: string[] = [];
  let cancelled = 0;
  let finished = 0;
  const statuses: PlaybackStatus[] = [];
  const checkpoints = [
    cp({ at: 0, mode: 'dipole' }, 0),
    cp({ at: 1000, mode: 'coil' }, 1),
    cp({ at: 2000, mode: 'capacitor' }, 2),
  ];
  const player = new TimelinePlayer(
    checkpoints,
    {
      onApply: (c) => applied.push(c.mode),
      onCancel: () => cancelled++,
      onFinish: () => finished++,
      onStatusChange: (s) => statuses.push(s),
    },
    clock,
  );

  /** 按 <=100ms 的小步推进（播放器对单帧 delta 有 100ms 钳制，防止后台标签页跳变） */
  function advance(ms: number): void {
    let remaining = ms;
    while (remaining > 0) {
      const s = Math.min(50, remaining);
      remaining -= s;
      clock.step(s);
    }
  }

  player.start();
  eq(player.getStatus(), 'playing', '启动后状态为 playing');
  eq(applied, ['dipole'], '第 0 个检查点立即应用');
  eq(clock.pendingCount(), 1, '只有单个 rAF 在运行');

  advance(500);
  eq(applied, ['dipole'], '未到下一个检查点时不重复应用');
  advance(500); // t=1000
  eq(applied, ['dipole', 'coil'], '到达 1000ms 应用第二个检查点');
  eq(player.getIndex(), 1, '激活下标为 1');

  player.pause();
  eq(player.getStatus(), 'paused', '暂停');
  eq(clock.pendingCount(), 0, '暂停后无残留 rAF');
  clock.step(5000);
  eq(applied.length, 2, '暂停期间时间轴不推进');
  player.resume();
  eq(clock.pendingCount(), 1, '继续后重新调度单个 rAF');
  advance(400);
  eq(applied.length, 2, '继续后只累计暂停后的时间');
  advance(600); // t=2000
  eq(applied, ['dipole', 'coil', 'capacitor'], '最后检查点被应用');
  eq(player.getStatus(), 'ended', '自然结束为 ended');
  eq(finished, 1, 'onFinish 触发一次');
  eq(clock.pendingCount(), 0, '结束后无残留 rAF');
  ok(statuses.includes('playing') && statuses.includes('paused') && statuses.includes('ended'), '状态回调序列完整');

  // 取消（结束态）→ 恢复基线
  player.cancel();
  eq(player.getStatus(), 'idle', '取消后回到 idle');
  eq(cancelled, 1, 'onCancel 恰好触发一次');

  // 重播
  applied.length = 0;
  player.start();
  eq(applied, ['dipole'], '重播重新从首个检查点开始');
  player.cancel();
  eq(cancelled, 2, '播放途中取消同样触发 onCancel');
  eq(clock.pendingCount(), 0, '取消后 rAF 已清空');

  // 暂停态 seek
  player.start();
  player.pause();
  player.seek(1000);
  eq(player.getIndex(), 1, 'seek 到中间位置激活对应检查点');
  player.seek(0);
  eq(player.getIndex(), 0, 'seek 回头也能激活较早检查点');
  player.cancel();

  // dispose 不触发 onCancel（前面 seek 测试已 cancel 一次，故计数停在 3），且无定时器残留
  player.start();
  player.dispose();
  eq(cancelled, 3, 'dispose 不触发 onCancel（卸载语义）');
  eq(clock.pendingCount(), 0, 'dispose 后无残留 rAF');
}

console.log('— 播放中断恢复：当前实验不被半程状态污染 —');
{
  const clock = new FakeClock();
  const baseline = cloneLab(baseLab);
  const restored: LabState[] = [];
  const checkpoints = [
    cp({ at: 0, mode: 'dipole', camera: { position: [1, 1, 1], target: [0, 0, 0] } }, 0),
    cp({ at: 1000, mode: 'coil', camera: { position: [2, 2, 2], target: [1, 0, 0] } }, 1),
    cp({ at: 2000, mode: 'capacitor', camera: { position: [3, 3, 3], target: [0, 1, 0] } }, 2),
  ];
  // 模拟宿主：onApply 原子切换当前实验，onCancel 原子恢复基线
  let current = cloneLab(baseline);
  const player = new TimelinePlayer(
    checkpoints,
    {
      onApply: (c) => {
        current = cloneLab(cpToLab(c));
      },
      onCancel: () => {
        current = cloneLab(baseline);
        restored.push(cloneLab(current));
      },
      onFinish: () => {},
    },
    clock,
  );
  player.start();
  for (let i = 0; i < 12; i++) clock.step(100); // 推进到 1200ms（单帧受 100ms 钳制）
  eq(current.mode, 'coil', '播放途中已切到中间检查点');
  player.cancel();
  eq(current.mode, baseline.mode, '取消后场型恢复基线');
  eq(current.camera.position, baseline.camera.position, '取消后相机恢复基线');
  eq(restored.length, 1, '恢复动作恰好一次（原子）');
  eq(clock.pendingCount(), 0, '中断后无残留定时器');
}

function cpToLab(c: SessionCheckpoint): LabState {
  return { mode: c.mode, strength: c.strength, showVectors: c.showVectors, camera: c.camera };
}

console.log('— 零时长 / 单检查点会话 —');
{
  const clock = new FakeClock();
  const applied: number[] = [];
  let finished = 0;
  const player = new TimelinePlayer(
    [cp({ at: 0 }, 0)],
    { onApply: (_c, i) => applied.push(i), onCancel: () => {}, onFinish: () => finished++ },
    clock,
  );
  player.start();
  eq(player.getStatus(), 'ended', '零时长会话立即结束');
  eq(applied, [0], '唯一检查点应用一次');
  eq(finished, 1, 'onFinish 触发');
  eq(clock.pendingCount(), 0, '无 rAF 调度');
}

console.log('— 重新导入：成功才替换，坏文件不得污染当前会话 —');
{
  // 模拟 SessionPanel 的提交契约：先 parse 成功再 onSessionChange
  let current = createSession();
  current = appendCheckpoint(current, baseLab, 0);
  const beforeId = current.id;
  const beforeCount = current.checkpoints.length;

  function importText(text: string): boolean {
    try {
      const parsed = parseSessionText(text); // 任何失败在此抛出
      current = parsed; // 只有完全成功才替换
      return true;
    } catch {
      return false;
    }
  }

  ok(importText('{ broken') === false, '坏 JSON 导入失败');
  eq(current.id, beforeId, '坏文件后当前会话未被替换');
  eq(current.checkpoints.length, beforeCount, '坏文件后检查点数量不变');

  let incoming = createSession('外部会话');
  incoming = appendCheckpoint(incoming, { ...baseLab, mode: 'capacitor' }, 0);
  incoming = appendCheckpoint(incoming, { ...baseLab, mode: 'coil' }, 800);
  const incomingText = serializeSession(incoming);

  ok(importText(incomingText), '合法文件导入成功');
  eq(current.name, '外部会话', '导入后切换为新会话');
  ok(importText(incomingText), '同一文件可再次导入（重新导入场景）');
  eq(current.checkpoints.length, 2, '重新导入后内容正确');

  const tampered = JSON.parse(incomingText);
  tampered.version = 99;
  ok(importText(JSON.stringify(tampered)) === false, '未知版本导入失败');
  eq(current.name, '外部会话', '未知版本未污染已导入的会话');
}

console.log('— 资源纪律：Object URL 不残留 / 坏文件拒绝 —');
{
  const created: string[] = [];
  const revoked: string[] = [];
  const clicks: string[] = [];
  installDomStubs(created, revoked, clicks);

  downloadJson('session.json', '{"hello":"world"}');
  eq(clicks, ['blob:stub/0'], '下载被调度（锚点 click）');
  eq(created.length, 1, '创建了一个 Object URL');
  // downloadJson 用 setTimeout(0) 回收
  await new Promise((r) => setTimeout(r, 5));
  eq(revoked, ['blob:stub/0'], 'Object URL 在下载调度后立即回收，不残留');

  downloadJson('a.json', '{}');
  const flushed = revokeAllObjectUrls();
  ok(flushed >= 1, '卸载兜底 revokeAllObjectUrls 回收了残留 URL');

  // 空文件 / 超限文件在读之前就拒绝
  await readJsonFile(new File([''], 'empty.json')).then(
    () => ok(false, '空文件应被拒绝'),
    (err: Error) => ok(err.message.includes('为空'), `空文件被拒绝：${err.message}`),
  );
  const big = new File([new Uint8Array(MAX_IMPORT_BYTES + 1)], 'big.json');
  await readJsonFile(big).then(
    () => ok(false, '超限文件应被拒绝'),
    (err: Error) => ok(err.message.includes('过大'), `超限文件被拒绝：${err.message}`),
  );
  const good = new File([new TextEncoder().encode('{"a":1}')], 'ok.json');
  const text = await readJsonFile(good);
  eq(text, '{"a":1}', '正常文件内容被读出');
}

console.log('');
if (failed > 0) {
  console.error(`验证失败：${passed} 通过，${failed} 失败`);
  process.exit(1);
}
console.log(`全部通过：${passed} 项断言 ✓`);
