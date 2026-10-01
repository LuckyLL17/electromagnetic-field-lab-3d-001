import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Line, OrbitControls, Text } from '@react-three/drei';
import * as THREE from 'three';
import { DEFAULT_CAMERA, cloneCamera } from './session/checkpoints';
import type { CameraState, FieldMode } from './session/types';

type Mode = FieldMode;

const colors = {
  field: '#68d7f2',
  vector: '#f6c86f',
  positive: '#f27f73',
  negative: '#6a9fff',
  coil: '#d995f2',
};

function fieldAt(x: number, y: number, z: number, mode: Mode, strength: number) {
  if (mode === 'capacitor') return new THREE.Vector3(0, strength * (0.9 + 0.12 * Math.cos(x * 1.7)), 0);
  if (mode === 'coil') return new THREE.Vector3(-z * 0.35 * strength, 0.15 * strength, x * 0.35 * strength);
  const r2 = x * x + y * y + z * z + 0.18;
  const scale = strength / Math.pow(r2, 2.1);
  return new THREE.Vector3(3 * x * z * scale, (3 * y * y - r2) * scale, 3 * z * x * scale);
}

function FieldLines({ mode, strength }: { mode: Mode; strength: number }) {
  const lines = useMemo(() => {
    if (mode === 'capacitor')
      return Array.from({ length: 10 }, (_, i) => {
        const x = -2.6 + i * 0.58;
        return [new THREE.Vector3(x, -2, 0), new THREE.Vector3(x, 2, 0)];
      });
    if (mode === 'coil')
      return Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return Array.from({ length: 32 }, (_, j) => {
          const t = (j / 31) * Math.PI * 2;
          const r = 1.15 + 0.65 * Math.sin(a * 2) ** 2;
          return new THREE.Vector3(Math.cos(t) * r, Math.sin(t) * r * 0.55, Math.sin(a) * 0.3);
        });
      });
    return Array.from({ length: 14 }, (_, i) => {
      const a = (i / 14) * Math.PI * 2;
      return Array.from({ length: 34 }, (_, j) => {
        const t = (j / 33) * Math.PI * 2;
        const r = 1.05 + 0.23 * Math.sin(t * 2 + a);
        return new THREE.Vector3(
          Math.cos(a) * r * Math.cos(t),
          Math.sin(t) * r,
          Math.sin(a) * r * Math.cos(t),
        );
      });
    });
  }, [mode]);
  return (
    <group>
      {lines.map((line, i) => (
        <Line
          key={i}
          points={line}
          color={mode === 'coil' ? colors.coil : colors.field}
          lineWidth={1.6}
          transparent
          opacity={0.78}
        />
      ))}
    </group>
  );
}

function Vectors({ mode, strength, showVectors }: { mode: Mode; strength: number; showVectors: boolean }) {
  const vectors = useMemo(
    () =>
      Array.from({ length: 25 }, (_, i) => {
        const x = -2.4 + (i % 5) * 1.2;
        const y = -2.4 + Math.floor(i / 5) * 1.2;
        const v = fieldAt(x, y, 0, mode, strength);
        const start = new THREE.Vector3(x, y, mode === 'capacitor' ? 0.15 : 0);
        const end = start.clone().add(v.normalize().multiplyScalar(0.35));
        return [start, end] as [THREE.Vector3, THREE.Vector3];
      }),
    [mode, strength],
  );
  return (
    <group>
      {showVectors &&
        vectors.map((v, i) => <Line key={i} points={v} color={colors.vector} lineWidth={1.3} />)}
    </group>
  );
}

function Source({ mode, strength }: { mode: Mode; strength: number }) {
  if (mode === 'capacitor')
    return (
      <group>
        <mesh position={[-3, 0, 0]}>
          <boxGeometry args={[0.16, 5.2, 0.55]} />
          <meshStandardMaterial color={colors.positive} />
        </mesh>
        <mesh position={[3, 0, 0]}>
          <boxGeometry args={[0.16, 5.2, 0.55]} />
          <meshStandardMaterial color={colors.negative} />
        </mesh>
        <Text position={[-2.82, 2.75, 0.2]} fontSize={0.2} color={colors.positive}>
          +Q
        </Text>
        <Text position={[2.82, 2.75, 0.2]} fontSize={0.2} color={colors.negative}>
          −Q
        </Text>
      </group>
    );
  if (mode === 'coil')
    return (
      <group>
        {Array.from({ length: 7 }, (_, i) => (
          <mesh key={i} position={[0, 0, (i - 3) * 0.34]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[1.55, 0.07, 10, 48]} />
            <meshStandardMaterial
              color={colors.coil}
              emissive={colors.coil}
              emissiveIntensity={strength * 0.12}
            />
          </mesh>
        ))}
      </group>
    );
  return (
    <group>
      <mesh position={[-0.8, 0, 0]}>
        <sphereGeometry args={[0.28, 20, 16]} />
        <meshStandardMaterial color={colors.positive} emissive={colors.positive} emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[0.8, 0, 0]}>
        <sphereGeometry args={[0.28, 20, 16]} />
        <meshStandardMaterial color={colors.negative} emissive={colors.negative} emissiveIntensity={0.4} />
      </mesh>
      <Line points={[new THREE.Vector3(-0.8, 0, 0), new THREE.Vector3(0.8, 0, 0)]} color="#d8e4ef" lineWidth={2} />
    </group>
  );
}

/** OrbitControls 实例上我们会用到的最小接口（避免依赖 drei 的完整类型） */
interface ControlsLike {
  target: THREE.Vector3;
  update(): void;
  enabled: boolean;
}

export interface CameraBridge {
  /** 复制出一份纯数据相机快照（不持有 Three.js 引用） */
  capture(): CameraState;
  /** 原子恢复：位置与朝向目标点同时写入同一渲染帧 */
  apply(camera: CameraState): void;
}

/**
 * 相机桥接：
 *  - 挂载时把 capture/apply 注册给宿主，卸载时注销（ref 回调稳定，无额外渲染）；
 *  - cameraNonce 变化时在 useLayoutEffect（绘制前）写入相机，
 *    与同一次 React 提交里的场型/强度/矢量开关一起呈现，保证控制区与三维场景原子同步；
 *  - 回放期间禁用 OrbitControls，防止用户在检查点之间插手相机。
 */
function CameraRig({
  registerBridge,
  restoreCamera,
  cameraNonce,
  interactive,
}: {
  registerBridge: (bridge: CameraBridge | null) => void;
  restoreCamera: CameraState;
  cameraNonce: number;
  interactive: boolean;
}) {
  const camera = useThree((s) => s.camera);
  const controlsRef = useRef<ControlsLike | null>(null);

  useEffect(() => {
    const bridge: CameraBridge = {
      capture: () => {
        const target = controlsRef.current?.target ?? new THREE.Vector3(0, 0, 0);
        return cloneCamera({
          position: [camera.position.x, camera.position.y, camera.position.z],
          target: [target.x, target.y, target.z],
        });
      },
      apply: (cam: CameraState) => {
        camera.position.set(cam.position[0], cam.position[1], cam.position[2]);
        const controls = controlsRef.current;
        if (controls) {
          controls.target.set(cam.target[0], cam.target[1], cam.target[2]);
          controls.update();
        }
        camera.updateProjectionMatrix();
      },
    };
    registerBridge(bridge);
    return () => registerBridge(null);
  }, [camera, registerBridge]);

  // useLayoutEffect：在浏览器绘制前写入相机，与同一次提交的 UI props 同帧呈现
  useLayoutEffect(() => {
    if (cameraNonce > 0) {
      camera.position.set(restoreCamera.position[0], restoreCamera.position[1], restoreCamera.position[2]);
      const controls = controlsRef.current;
      if (controls) {
        controls.target.set(restoreCamera.target[0], restoreCamera.target[1], restoreCamera.target[2]);
        controls.update();
      }
      camera.updateProjectionMatrix();
    }
  }, [cameraNonce, restoreCamera, camera]);

  return (
    <OrbitControls
      ref={(c: ControlsLike | null) => {
        controlsRef.current = c;
      }}
      makeDefault
      minDistance={5}
      maxDistance={14}
      enabled={interactive}
    />
  );
}

export interface EMSceneProps {
  mode: FieldMode;
  strength: number;
  showVectors: boolean;
  interactive: boolean;
  cameraNonce: number;
  restoreCamera: CameraState;
  registerBridge: (bridge: CameraBridge | null) => void;
}

export default function EMScene({
  mode,
  strength,
  showVectors,
  interactive,
  cameraNonce,
  restoreCamera,
  registerBridge,
}: EMSceneProps) {
  return (
    <Canvas camera={{ position: DEFAULT_CAMERA.position, fov: 42 }}>
      <color attach="background" args={['#0b0b1c']} />
      <ambientLight intensity={1.2} />
      <pointLight position={[3, 4, 5]} color="#9a8cff" intensity={18} />
      <pointLight position={[-4, -2, 2]} color="#49d5e7" intensity={12} />
      <group rotation={[0.18, -0.24, 0]}>
        <Source mode={mode} strength={strength} />
        <FieldLines mode={mode} strength={strength} />
        <Vectors mode={mode} strength={strength} showVectors={showVectors} />
        <mesh position={[0, 0, -0.45]}>
          <planeGeometry args={[7, 6]} />
          <meshBasicMaterial color="#25234b" transparent opacity={0.12} side={THREE.DoubleSide} />
        </mesh>
      </group>
      <CameraRig
        registerBridge={registerBridge}
        restoreCamera={restoreCamera}
        cameraNonce={cameraNonce}
        interactive={interactive}
      />
    </Canvas>
  );
}
