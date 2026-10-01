/**
 * 检查点 / 会话的创建、追加、序列化与严格解析。
 *
 * 取舍说明（严格拒绝 vs 兼容读取）：
 *  - 【严格拒绝】语义错误：未知 format、未知 version、字段缺失或类型错误、
 *    数值为 NaN/越界、时间戳递减、空检查点列表 —— 一律整文件拒绝，
 *    调用方保证在解析成功前不得触碰当前实验。
 *  - 【兼容读取】结构正确但有多余/可选字段：顶层与检查点的额外字段忽略；
 *    顶层 id/name/createdAt 缺失时自动补全（旧版/人工编辑仍可打开）。
 *    但 v1 的检查点字段一个都不能少 —— 检查点是回放正确性的核心。
 */
import {
  SESSION_FORMAT,
  type CameraState,
  type ExperimentSession,
  type FieldMode,
  type LabState,
  type SessionCheckpoint,
} from './types.js';

export const STRENGTH_MIN = 0.5;
export const STRENGTH_MAX = 3;
const MODES: readonly FieldMode[] = ['dipole', 'coil', 'capacitor'];

export const DEFAULT_CAMERA: CameraState = {
  position: [6, 4.5, 8],
  target: [0, 0, 0],
};

/** 深冻结：运行期捕获任何对不可变检查点的意外修改 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** 优先使用加密级随机 ID；非安全上下文（http、旧浏览器）退化为时间戳随机串 */
export function makeId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 从活动的 Three.js 相机值里【复制】出一份纯数据，不保留任何实时引用 */
export function cloneCamera(camera: CameraState): CameraState {
  return {
    position: [...camera.position] as [number, number, number],
    target: [...camera.target] as [number, number, number],
  };
}

/** LabState 深拷贝（快照语义）：外部对象事后变化绝不影响已录制快照 */
export function cloneLab(lab: LabState): LabState {
  return {
    mode: lab.mode,
    strength: lab.strength,
    showVectors: lab.showVectors,
    camera: cloneCamera(lab.camera),
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 会话名时间戳：2026-09-30 14:05 */
export function sessionStamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

export function createSession(name?: string): ExperimentSession {
  return deepFreeze({
    format: SESSION_FORMAT,
    version: 1,
    id: makeId(),
    name: name ?? `实验会话 ${sessionStamp()}`,
    createdAt: new Date().toISOString(),
    checkpoints: [],
  });
}

let checkpointSeq = 0;

/**
 * 以快照方式追加检查点：入参的 lab/camera 会被复制，
 * 返回一个【全新的、已冻结的】会话；原会话保持不变（持久化数据结构风格）。
 */
export function appendCheckpoint(
  session: ExperimentSession,
  lab: LabState,
  at: number,
  label?: string,
): ExperimentSession {
  const prev = session.checkpoints[session.checkpoints.length - 1];
  // 规范化时间：非递减且非负，防止调用方时钟异常污染时间轴
  const safeAt = Math.max(0, Math.round(at));
  const ts = prev ? Math.max(prev.at, safeAt) : safeAt;
  const checkpoint: SessionCheckpoint = deepFreeze({
    id: makeId(),
    at: ts,
    label: label ?? `检查点 ${session.checkpoints.length + 1}`,
    ...cloneLab(lab),
  });
  return deepFreeze({
    ...session,
    checkpoints: [...session.checkpoints, checkpoint],
  });
}

/** 序列化为稳定的 JSON 文本（2 空格缩进，便于人工检查与外部工具处理） */
export function serializeSession(session: ExperimentSession): string {
  return JSON.stringify(session, null, 2);
}

// ---- 严格解析 -------------------------------------------------------------

function fail(message: string): never {
  throw new Error(message);
}

type Shape = 'object' | 'array' | 'string' | 'number' | 'boolean';

function isShape(v: unknown, shape: Shape): boolean {
  if (shape === 'array') return Array.isArray(v);
  if (shape === 'object') return typeof v === 'object' && v !== null && !Array.isArray(v);
  return typeof v === shape;
}

function requireField<T>(
  obj: Record<string, unknown>,
  key: string,
  shape: Shape,
  context: string,
): T {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null)
    fail(`无效会话：${context}缺少字段 "${key}"`);
  const v = obj[key];
  if (!isShape(v, shape)) fail(`无效会话：${context}的 "${key}" 类型错误`);
  return v as T;
}

function readNumber(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`无效会话：${path}必须是有限数值`);
  return v;
}

function readVector3(v: unknown, path: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3) fail(`无效会话：${path}必须是长度为 3 的数组`);
  return [readNumber(v[0], `${path}[0]`), readNumber(v[1], `${path}[1]`), readNumber(v[2], `${path}[2]`)];
}

function readCamera(v: unknown): CameraState {
  if (!isShape(v, 'object')) fail('无效会话：检查点缺少相机快照 camera');
  const o = v as Record<string, unknown>;
  return {
    position: readVector3(requireField(o, 'position', 'array', 'camera.'), 'camera.position'),
    target: readVector3(requireField(o, 'target', 'array', 'camera.'), 'camera.target'),
  };
}

/**
 * 解析并完整校验会话 JSON。
 * @throws Error（message 可直接展示给用户）；任何失败都不会产出部分数据。
 */
export function parseSessionText(text: string): ExperimentSession {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('文件不是合法的 JSON');
  }
  if (!isShape(raw, 'object')) fail('无效会话：顶层结构必须是对象');
  const root = raw as Record<string, unknown>;

  // format 必须精确匹配本应用；version 只接受 1。
  // 未来升级到 v2 时在此处做迁移；未知版本一律拒绝而非猜测性兼容。
  if (root.format !== SESSION_FORMAT) fail('无法识别：不是 ElectroMag Lab 会话文件（format 不匹配）');
  if (!('version' in root)) fail('无效会话：缺少版本号 version');
  if (root.version !== 1) fail(`不支持的会话版本：${String(root.version)}（当前仅支持 v1）`);

  const cpsRaw = requireField<unknown[]>(root, 'checkpoints', 'array', '会话');
  if (cpsRaw.length === 0) fail('无效会话：至少需要一个检查点');

  const checkpoints: SessionCheckpoint[] = [];
  let lastAt = -1;
  cpsRaw.forEach((cpRaw, i) => {
    const ctx = `检查点 #${i + 1}`;
    if (!isShape(cpRaw, 'object')) fail(`无效会话：${ctx}必须是对象`);
    const cp = cpRaw as Record<string, unknown>;

    const mode = requireField<string>(cp, 'mode', 'string', ctx);
    if (!MODES.includes(mode as FieldMode)) fail(`无效会话：${ctx}的场型 "${mode}" 未知`);
    const strength = readNumber(requireField<number>(cp, 'strength', 'number', ctx), `${ctx}.strength`);
    if (strength < STRENGTH_MIN || strength > STRENGTH_MAX)
      fail(`无效会话：${ctx}强度 ${strength} 超出范围 [${STRENGTH_MIN}, ${STRENGTH_MAX}]`);
    const showVectors = requireField<boolean>(cp, 'showVectors', 'boolean', ctx);
    const at = readNumber(requireField<number>(cp, 'at', 'number', ctx), `${ctx}.at`);
    if (at < 0) fail(`无效会话：${ctx}时间戳不能为负`);
    if (at < lastAt) fail(`无效会话：${ctx}时间戳必须非递减`);
    lastAt = at;
    const id = requireField<string>(cp, 'id', 'string', ctx);
    if (!id.trim()) fail(`无效会话：${ctx}的 id 为空`);
    const label = requireField<string>(cp, 'label', 'string', ctx);
    const camera = readCamera(cp.camera);

    // 多余字段在此自然被丢弃 —— 这就是“兼容读取”的边界：
    // 前向新增的未知字段不影响 v1 回放，但核心字段缺失/错误仍严格拒绝。
    checkpoints.push(
      deepFreeze({ id, label, at, mode: mode as FieldMode, strength, showVectors, camera }),
    );
  });

  // 元数据宽松处理：缺失即补全（兼容人工编辑/旧工具导出的文件）
  const id = typeof root.id === 'string' && root.id.trim() ? root.id : makeId();
  const name = typeof root.name === 'string' && root.name.trim() ? root.name : '导入的实验会话';
  const createdAt =
    typeof root.createdAt === 'string' && Number.isFinite(Date.parse(root.createdAt))
      ? root.createdAt
      : new Date().toISOString();

  return deepFreeze({ format: SESSION_FORMAT, version: 1, id, name, createdAt, checkpoints });
}

/** 当前时间轴位置应当停留的检查点下标（at <= elapsed 的最后一个） */
export function activeCheckpointIndex(checkpoints: readonly SessionCheckpoint[], elapsed: number): number {
  let idx = 0;
  for (let i = 0; i < checkpoints.length; i++) {
    if (checkpoints[i].at <= elapsed) idx = i;
    else break;
  }
  return idx;
}

/** 时间轴总时长（毫秒） */
export function sessionDuration(session: ExperimentSession): number {
  const cps = session.checkpoints;
  return cps.length ? cps[cps.length - 1].at : 0;
}
