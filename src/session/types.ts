/**
 * 实验会话（Experiment Session）不可变数据契约。
 *
 * 设计原则：
 * - 检查点捕获时即对“实时状态”做深拷贝快照，此后与会话生命周期中的任何
 *   实时引用（React state / THREE.Camera / OrbitControls）完全脱钩。
 * - 所有经解码/构造产生的对象都会被递归冻结，只能整体替换，不能就地修改。
 * - 版本号写入文件头，未知版本一律拒绝读取（strict reject），不做猜测式迁移。
 */

export type FieldMode = 'dipole' | 'coil' | 'capacitor';

/** 相机的可序列化检查点：观察点位置 + OrbitControls 注视目标。 */
export interface CameraFrame {
  position: [number, number, number];
  target: [number, number, number];
}

/** 控制区状态：场型、激励强度、矢量采样开关。 */
export interface ExperimentControls {
  mode: FieldMode;
  strength: number;
  showVectors: boolean;
}

/** 时间轴上的一个不可变检查点。 */
export interface ExperimentCheckpoint {
  /** 会话内唯一 ID；导入时缺失会兼容合成，重复则拒绝。 */
  id: string;
  /** 时间轴位置（毫秒，非负）。 */
  t: number;
  label: string;
  controls: ExperimentControls;
  camera: CameraFrame;
}

/** v1 会话文件头 + 载荷。 */
export interface ExperimentSessionV1 {
  kind: typeof SESSION_KIND;
  version: 1;
  name: string;
  createdAt: string;
  exportedAt: string;
  checkpoints: ExperimentCheckpoint[];
}

/** 数据类型标识，防止把别的 JSON 误当会话导入。 */
export const SESSION_KIND = 'em-lab.experiment-session';

/** 强度合法区间（与界面滑块一致），越界文件整体拒绝。 */
export const MIN_STRENGTH = 0.5;
export const MAX_STRENGTH = 3;

/** 回放步进间隔：默认 1.4s，注入更小值时强制下限，防止定时器风暴。 */
export const MIN_INTERVAL_MS = 200;
export const DEFAULT_INTERVAL_MS = 1400;

/** 相邻检查点在时间轴上的逻辑间隔（仅用于新记录的 t 赋值）。 */
export const CHECKPOINT_T_STEP_MS = 1000;
