/**
 * 实验会话（Experiment Session）领域模型。
 *
 * 所有会话数据都是【可 JSON 序列化的纯数据】：
 * - 不允许持有 THREE.Vector3 等运行时对象的引用；
 * - 检查点一经创建即被深冻结（deepFreeze），是不可变快照；
 * - 时间轴回放只能读取检查点，不能原地改写。
 */

/** 场型：电偶极子 / 通电螺线管 / 平行板电容器 */
export type FieldMode = 'dipole' | 'coil' | 'capacitor';

/** 相机不可变状态：观测点位置 + OrbitControls 朝向目标点 */
export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
}

/** 三维实验台的完整受控状态：控制区与三维场景共享同一份数据 */
export interface LabState {
  mode: FieldMode;
  strength: number;
  showVectors: boolean;
  camera: CameraState;
}

/**
 * 时间轴上的不可变检查点。
 * at 为相对会话录制起点的毫秒数（非递减）。
 */
export interface SessionCheckpoint extends LabState {
  id: string;
  /** 相对录制开始的毫秒时间戳，非递减 */
  at: number;
  label: string;
}

/** JSON 导入导出的顶层信封格式 */
export interface ExperimentSession {
  format: typeof SESSION_FORMAT;
  version: 1;
  id: string;
  name: string;
  /** ISO-8601 创建时间，仅用于展示 */
  createdAt: string;
  checkpoints: SessionCheckpoint[];
}

export const SESSION_FORMAT = 'electromag-lab-session' as const;
export type SessionFormat = typeof SESSION_FORMAT;

/** 回放状态机：空闲 → 播放 ⇄ 暂停 → 结束；取消回到空闲 */
export type PlaybackStatus = 'idle' | 'playing' | 'paused' | 'ended';
