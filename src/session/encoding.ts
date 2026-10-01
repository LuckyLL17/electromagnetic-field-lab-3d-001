/**
 * 会话 JSON 的严格解码与兼容读取（strict reject / tolerant read）。
 *
 * 拒绝策略（任一不满足，整体抛出 SessionFormatError，调用方绝不可部分采用）：
 * - JSON 解析失败、根不是对象
 * - kind 不匹配 / version 不是 1（未知版本不猜测、不迁移）
 * - 必填字段类型/枚举错误，数值为 NaN/Infinity，strength 越界，布尔不是 boolean
 * - checkpoints 为空、id 重复、t 为负或非有限值
 *
 * 兼容策略（缺失时按规则合成，不拒绝旧版本 v1 写出的精简文件）：
 * - 根级 name/createdAt/exportedAt、检查点 label/id/t 缺失时合成
 * - 任何层级出现的多余未知字段一律忽略（向前兼容，v1 读到 v1+ 的附加数据）
 */
import {
  CHECKPOINT_T_STEP_MS,
  ExperimentCheckpoint,
  ExperimentSessionV1,
  FieldMode,
  MAX_STRENGTH,
  MIN_STRENGTH,
  SESSION_KIND,
} from './types';

export class SessionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionFormatError';
  }
}

const MODES: ReadonlySet<unknown> = new Set(['dipole', 'coil', 'capacitor']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function asVec3(v: unknown, path: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3) {
    throw new SessionFormatError(`${path} 必须是长度为 3 的数组`);
  }
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    if (!isFiniteNumber(v[i])) {
      throw new SessionFormatError(`${path}[${i}] 必须是有限数值`);
    }
    out.push(v[i]);
  }
  return out as [number, number, number];
}

function asOptionalString(v: unknown, fallback: string, path: string): string {
  if (v === undefined) return fallback;
  if (typeof v !== 'string') {
    throw new SessionFormatError(`${path} 必须是字符串`);
  }
  return v;
}

/** 解析单个检查点；多余字段忽略，缺失的可选字段合成。 */
function decodeCheckpoint(raw: unknown, index: number): ExperimentCheckpoint {
  if (!isRecord(raw)) {
    throw new SessionFormatError(`checkpoints[${index}] 必须是对象`);
  }
  const mode = raw.controls === undefined ? raw.mode : undefined;
  const controlsSrc = isRecord(raw.controls) ? raw.controls : undefined;

  let fieldMode: unknown;
  if (controlsSrc) fieldMode = controlsSrc.mode;
  else fieldMode = mode;
  if (!MODES.has(fieldMode)) {
    throw new SessionFormatError(
      `checkpoints[${index}].controls.mode 必须是 dipole/coil/capacitor 之一`,
    );
  }

  const strengthSource: unknown = controlsSrc
    ? controlsSrc.strength
    : raw.strength;
  if (!isFiniteNumber(strengthSource)) {
    throw new SessionFormatError(
      `checkpoints[${index}].controls.strength 必须是有限数值`,
    );
  }
  if (strengthSource < MIN_STRENGTH || strengthSource > MAX_STRENGTH) {
    throw new SessionFormatError(
      `checkpoints[${index}].controls.strength=${strengthSource} 超出允许区间 [${MIN_STRENGTH}, ${MAX_STRENGTH}]`,
    );
  }

  const showVectorsSource: unknown = controlsSrc
    ? controlsSrc.showVectors
    : raw.showVectors;
  if (typeof showVectorsSource !== 'boolean') {
    throw new SessionFormatError(
      `checkpoints[${index}].controls.showVectors 必须是布尔值`,
    );
  }

  if (!isRecord(raw.camera)) {
    throw new SessionFormatError(`checkpoints[${index}].camera 必须是对象`);
  }
  const camera = {
    position: asVec3(raw.camera.position, `checkpoints[${index}].camera.position`),
    target: asVec3(raw.camera.target, `checkpoints[${index}].camera.target`),
  };

  let t: number;
  if (raw.t === undefined) {
    // 兼容缺失 t 的文件：按顺序合成等间隔时间轴。
    t = index * CHECKPOINT_T_STEP_MS;
  } else {
    if (!isFiniteNumber(raw.t) || raw.t < 0) {
      throw new SessionFormatError(
        `checkpoints[${index}].t 必须是非负有限数值`,
      );
    }
    t = raw.t;
  }

  return {
    id: asOptionalString(raw.id, `cp-${index + 1}`, `checkpoints[${index}].id`),
    t,
    label: asOptionalString(raw.label, `检查点 ${index + 1}`, `checkpoints[${index}].label`),
    controls: {
      mode: fieldMode as FieldMode,
      strength: strengthSource,
      showVectors: showVectorsSource,
    },
    camera,
  };
}

/** 深拷贝 + 递归冻结，保证检查点不可变。 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const child = (value as Record<string, unknown>)[key];
      if (child && typeof child === 'object') deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * 解析 JSON 文本为合法的 v1 会话。
 * @throws SessionFormatError 文件损坏或版本/结构不被接受时抛出；调用前不得改动任何现有状态。
 */
export function parseSessionText(text: string): ExperimentSessionV1 {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SessionFormatError('文件不是合法 JSON');
  }
  if (!isRecord(data)) {
    throw new SessionFormatError('会话根节点必须是 JSON 对象');
  }
  if (data.kind !== SESSION_KIND) {
    throw new SessionFormatError(`文件标识不匹配（期望 ${SESSION_KIND}）`);
  }
  if (data.version !== 1) {
    // 未知版本：严格拒绝，不尝试迁移，避免语义被误解。
    throw new SessionFormatError(
      `未知的会话版本：${String(data.version)}（本应用仅支持 version=1）`,
    );
  }
  if (!Array.isArray(data.checkpoints) || data.checkpoints.length === 0) {
    throw new SessionFormatError('checkpoints 必须是非空数组');
  }

  const seenIds = new Set<string>();
  const decoded = data.checkpoints.map((raw, i) => {
    const cp = deepFreeze(decodeCheckpoint(raw, i)) as ExperimentCheckpoint;
    if (seenIds.has(cp.id)) {
      throw new SessionFormatError(`检查点 id 重复：${cp.id}`);
    }
    seenIds.add(cp.id);
    return cp;
  });
  // 时间轴必须有序；导入外部文件时统一按 t 稳定排序（同 t 保持原序）。
  const checkpoints = decoded
    .map((cp, i) => ({ cp, i }))
    .sort((a, b) => (a.cp.t === b.cp.t ? a.i - b.i : a.cp.t - b.cp.t))
    .map((entry) => entry.cp);

  const now = new Date().toISOString();
  const session: ExperimentSessionV1 = {
    kind: SESSION_KIND,
    version: 1,
    name: asOptionalString(data.name, '未命名会话', 'name'),
    createdAt: asOptionalString(data.createdAt, now, 'createdAt'),
    exportedAt: asOptionalString(data.exportedAt, now, 'exportedAt'),
    checkpoints,
  };
  return deepFreeze(session);
}

let cryptoRef: Crypto | undefined;
function getCrypto(): Crypto | undefined {
  if (cryptoRef !== undefined) return cryptoRef;
  const g = globalThis as { crypto?: Crypto };
  cryptoRef = g.crypto && typeof g.crypto.randomUUID === 'function' ? g.crypto : undefined;
  return cryptoRef;
}

function randomId(prefix: string): string {
  const c = getCrypto();
  if (c) return `${prefix}-${c.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newCheckpointId(): string {
  return randomId('cp');
}

export function newSessionId(): string {
  return randomId('session');
}

/** 构造一个不可变检查点（深拷贝实时引用后冻结）。 */
export function makeCheckpoint(input: {
  id?: string;
  t: number;
  label?: string;
  controls: { mode: FieldMode; strength: number; showVectors: boolean };
  camera: {
    position: readonly [number, number, number];
    target: readonly [number, number, number];
  };
}): ExperimentCheckpoint {
  if (!isFiniteNumber(input.t) || input.t < 0) {
    throw new SessionFormatError('检查点 t 必须是非负有限数值');
  }
  if (!MODES.has(input.controls.mode)) {
    throw new SessionFormatError('非法场型');
  }
  if (
    !isFiniteNumber(input.controls.strength) ||
    input.controls.strength < MIN_STRENGTH ||
    input.controls.strength > MAX_STRENGTH
  ) {
    throw new SessionFormatError('强度越界');
  }
  if (typeof input.controls.showVectors !== 'boolean') {
    throw new SessionFormatError('showVectors 必须是布尔值');
  }
  return deepFreeze({
    id: input.id ?? newCheckpointId(),
    t: input.t,
    label: input.label ?? '',
    controls: {
      mode: input.controls.mode,
      strength: input.controls.strength,
      showVectors: input.controls.showVectors,
    },
    camera: {
      position: [...input.camera.position] as [number, number, number],
      target: [...input.camera.target] as [number, number, number],
    },
  });
}

/** 构造一个不可变 v1 会话。 */
export function makeSession(input: {
  name: string;
  checkpoints: readonly ExperimentCheckpoint[];
  createdAt?: string;
  exportedAt?: string;
}): ExperimentSessionV1 {
  if (input.checkpoints.length === 0) {
    throw new SessionFormatError('会话至少需要一个检查点');
  }
  const now = new Date().toISOString();
  const checkpoints = input.checkpoints
    .map((cp) => deepFreeze({
      id: cp.id,
      t: cp.t,
      label: cp.label,
      controls: {
        mode: cp.controls.mode,
        strength: cp.controls.strength,
        showVectors: cp.controls.showVectors,
      },
      camera: {
        position: [...cp.camera.position] as [number, number, number],
        target: [...cp.camera.target] as [number, number, number],
      },
    }))
    .sort((a, b) => a.t - b.t);
  const ids = new Set(checkpoints.map((cp) => cp.id));
  if (ids.size !== checkpoints.length) {
    throw new SessionFormatError('检查点 id 重复');
  }
  return deepFreeze({
    kind: SESSION_KIND,
    version: 1,
    name: input.name,
    createdAt: input.createdAt ?? now,
    exportedAt: input.exportedAt ?? now,
    checkpoints,
  });
}

/** 导出为缩进 JSON 文本。 */
export function encodeSession(session: ExperimentSessionV1): string {
  return JSON.stringify(session, null, 2);
}
