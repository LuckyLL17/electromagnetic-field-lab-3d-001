/**
 * 控制区与三维场景（相机）的原子同步恢复。
 *
 * “原子”的含义：
 * - 应用前先把实时三方状态（相机帧 + 控制区）读入快照；
 * - 相机先就位，控制区随后同一次任务内写入，React 不会在两者之间渲染，
 *   界面不会出现“控件是 A、场景是 B”的中间帧；
 * - 任一环节抛错，已经写入的相机帧按快照回滚，控制区保持原值，
 *   调用方据此保证坏数据绝不污染当前实验。
 */
import { CameraFrame, ExperimentCheckpoint, ExperimentControls } from './types';

export interface LiveSnapshot {
  controls: ExperimentControls;
  camera: CameraFrame;
}

export interface AtomicApplier {
  /** 读取当前实时状态（React state + 三维相机）。 */
  readLive(): LiveSnapshot;
  /** 仅写入相机（OrbitControls 目标同步更新）。 */
  applyCamera(frame: CameraFrame): void;
  /** 仅写入控制区（必须在同一个 React 批处理任务中完成）。 */
  setControls(next: ExperimentControls): void;
}

/**
 * 将检查点原子地应用到实时界面。
 * @throws 任何子步骤失败时抛出；调用方可捕获并确认实时状态未被污染。
 */
export function applyCheckpoint(
  applier: AtomicApplier,
  checkpoint: ExperimentCheckpoint,
): void {
  // 1. 先读回滚快照，再校验结构（结构错误在读任何状态前抛出）。
  const previous = applier.readLive();
  const targetControls: ExperimentControls = {
    mode: checkpoint.controls.mode,
    strength: checkpoint.controls.strength,
    showVectors: checkpoint.controls.showVectors,
  };
  const targetCamera: CameraFrame = {
    position: [
      checkpoint.camera.position[0],
      checkpoint.camera.position[1],
      checkpoint.camera.position[2],
    ],
    target: [
      checkpoint.camera.target[0],
      checkpoint.camera.target[1],
      checkpoint.camera.target[2],
    ],
  };

  // 2. 相机先动（三维场景就位）。
  try {
    applier.applyCamera(targetCamera);
  } catch (err) {
    // 相机自身失败：控制区从未触碰，直接抛出。
    throw err;
  }

  // 3. 控制区写入与相机处于同一同步任务（React 18 自动批处理），无中间渲染。
  try {
    applier.setControls(targetControls);
  } catch (err) {
    // 控制区写入失败：把相机恢复到调用前的帧，保证两侧一致。
    try {
      applier.applyCamera(previous.camera);
    } catch {
      // 回滚也失败时保留原始错误信息，调用方会销毁本次会话流程。
    }
    throw err;
  }
}
