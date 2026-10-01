/**
 * React 绑定：相机桥、原子 applier 与 SessionController 的薄封装。
 *
 * 相机桥解决“控制区 state 在 React 树里、相机在 R3F Canvas 里”的跨边界同步：
 * Canvas 内部的 <CameraRig> 注册实时读写句柄，App 层通过同一引用完成
 * “相机先就位、控制区同批写入”的原子恢复。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { MutableRefObject } from 'react';
import { AtomicApplier, LiveSnapshot } from './applyAtomic';
import { CameraFrame, ExperimentControls } from './types';
import { SessionController } from './controller';
import { UrlRegistry } from './urlRegistry';

/** Canvas 内侧注册的实时相机读写句柄。 */
export interface CameraBridgeHandle {
  read(): CameraFrame;
  apply(frame: CameraFrame): void;
}

export type CameraBridgeRef = MutableRefObject<CameraBridgeHandle | null>;

function readFileTextWithFileReader(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // 全程不创建对象 URL，失败也无需回收任何资源。
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader 错误'));
    reader.readAsText(file);
  });
}

function browserDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export interface ExperimentSessionApi {
  state: ReturnType<SessionController['getState']>;
  capture: (label?: string) => void;
  play: () => void;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  interrupt: () => void;
  seek: (index: number) => void;
  importFile: (file: Blob) => Promise<void>;
  exportToFile: () => void;
  clear: () => void;
  setName: (name: string) => void;
  cameraBridge: CameraBridgeRef;
  /** 由 App 绑定真实的控制区 setState（保证原子写入走最新引用）。 */
  bindSetControls(fn: (next: ExperimentControls) => void): void;
}

/**
 * @param controlsRef 始终指向最新控制区 state 的 ref（供原子读取，不触发渲染）。
 */
export function useExperimentSession(
  controlsRef: MutableRefObject<ExperimentControls>,
): ExperimentSessionApi {
  const cameraBridge = useRef<CameraBridgeHandle | null>(null);
  // Registry / controller 在 StrictMode 双挂载期间持久存活；dispose 幂等。
  const [urlRegistry] = useState(() => new UrlRegistry({ delayMs: 0 }));
  const setControlsRef = useRef<(next: ExperimentControls) => void>(() => {});

  const [controller] = useState(() => {
    const applier: AtomicApplier = {
      readLive: (): LiveSnapshot => {
        const handle = cameraBridge.current;
        if (!handle) throw new Error('三维视口尚未就绪，无法读取相机');
        const controls = controlsRef.current;
        return {
          controls: {
            mode: controls.mode,
            strength: controls.strength,
            showVectors: controls.showVectors,
          },
          camera: handle.read(),
        };
      },
      applyCamera: (frame) => {
        const handle = cameraBridge.current;
        if (!handle) throw new Error('三维视口尚未就绪，无法写入相机');
        handle.apply(frame);
      },
      setControls: (next) => setControlsRef.current(next),
    };
    return new SessionController({
      applier,
      urlRegistry,
      readFileText: readFileTextWithFileReader,
      download: browserDownload,
    });
  });

  const state = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getState(),
  );

  // 卸载时销毁：作废在途定时器、断开订阅、吊销全部对象 URL。
  useEffect(() => {
    return () => controller.dispose();
  }, [controller]);

  return useMemo<ExperimentSessionApi>(
    () => ({
      state,
      capture: (label) => controller.capture(label),
      play: () => controller.play(),
      pause: () => controller.pause(),
      resume: () => controller.resume(),
      cancel: () => controller.cancel(),
      interrupt: () => controller.interrupt(),
      seek: (index) => controller.seek(index),
      importFile: (file) => controller.importFile(file),
      exportToFile: () => controller.exportToFile(),
      clear: () => controller.clear(),
      setName: (name) => controller.setName(name),
      cameraBridge,
      bindSetControls: (fn) => {
        setControlsRef.current = fn;
      },
    }),
    [controller, state],
  );
}
