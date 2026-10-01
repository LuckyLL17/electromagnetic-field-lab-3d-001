import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Line, OrbitControls, Text } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import {
  CameraBridgeHandle,
  useExperimentSession,
} from './session/useExperimentSession';
import { CameraFrame, ExperimentControls, FieldMode } from './session/types';
import { SessionPanel } from './SessionPanel';

type Mode = FieldMode;
const colors = { field: '#68d7f2', vector: '#f6c86f', positive: '#f27f73', negative: '#6a9fff', coil: '#d995f2' };

function fieldAt(x: number, y: number, z: number, mode: Mode, strength: number) {
  if (mode === 'capacitor') return new THREE.Vector3(0, strength * (.9 + .12 * Math.cos(x * 1.7)), 0);
  if (mode === 'coil') return new THREE.Vector3(-z * .35 * strength, .15 * strength, x * .35 * strength);
  const r2 = x * x + y * y + z * z + .18;
  const scale = strength / Math.pow(r2, 2.1);
  return new THREE.Vector3(3 * x * z * scale, (3 * y * y - r2) * scale, 3 * z * x * scale);
}

function FieldLines({ mode }: { mode: Mode }) {
  const lines = useMemo(() => {
    if (mode === 'capacitor') {
      return Array.from({ length: 10 }, (_, i) => {
        const x = -2.6 + i * .58;
        return [new THREE.Vector3(x, -2, 0), new THREE.Vector3(x, 2, 0)];
      });
    }
    if (mode === 'coil') {
      return Array.from({ length: 12 }, (_, i) => {
        const a = i / 12 * Math.PI * 2;
        return Array.from({ length: 32 }, (_, j) => {
          const t = j / 31 * Math.PI * 2;
          const r = 1.15 + .65 * Math.sin(a * 2) ** 2;
          return new THREE.Vector3(Math.cos(t) * r, Math.sin(t) * r * .55, Math.sin(a) * .3);
        });
      });
    }
    return Array.from({ length: 14 }, (_, i) => {
      const a = i / 14 * Math.PI * 2;
      return Array.from({ length: 34 }, (_, j) => {
        const t = j / 33 * Math.PI * 2;
        const r = 1.05 + .23 * Math.sin(t * 2 + a);
        return new THREE.Vector3(Math.cos(a) * r * Math.cos(t), Math.sin(t) * r, Math.sin(a) * r * Math.cos(t));
      });
    });
  }, [mode]);
  return (
    <group>
      {lines.map((line, i) => (
        <Line key={i} points={line} color={mode === 'coil' ? colors.coil : colors.field} lineWidth={1.6} transparent opacity={.78} />
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
        const start = new THREE.Vector3(x, y, mode === 'capacitor' ? .15 : 0);
        const end = start.clone().add(v.normalize().multiplyScalar(.35));
        return [start, end] as [THREE.Vector3, THREE.Vector3];
      }),
    [mode, strength],
  );
  return (
    <group>
      {showVectors && vectors.map((v, i) => <Line key={i} points={v} color={colors.vector} lineWidth={1.3} />)}
    </group>
  );
}

function Source({ mode, strength }: { mode: Mode; strength: number }) {
  if (mode === 'capacitor') {
    return (
      <group>
        <mesh position={[-3, 0, 0]}><boxGeometry args={[.16, 5.2, .55]} /><meshStandardMaterial color={colors.positive} /></mesh>
        <mesh position={[3, 0, 0]}><boxGeometry args={[.16, 5.2, .55]} /><meshStandardMaterial color={colors.negative} /></mesh>
        <Text position={[-2.82, 2.75, .2]} fontSize={.2} color={colors.positive}>+Q</Text>
        <Text position={[2.82, 2.75, .2]} fontSize={.2} color={colors.negative}>−Q</Text>
      </group>
    );
  }
  if (mode === 'coil') {
    return (
      <group>
        {Array.from({ length: 7 }, (_, i) => (
          <mesh key={i} position={[0, 0, (i - 3) * .34]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[1.55, .07, 10, 48]} />
            <meshStandardMaterial color={colors.coil} emissive={colors.coil} emissiveIntensity={strength * .12} />
          </mesh>
        ))}
      </group>
    );
  }
  return (
    <group>
      <mesh position={[-.8, 0, 0]}><sphereGeometry args={[.28, 20, 16]} /><meshStandardMaterial color={colors.positive} emissive={colors.positive} emissiveIntensity={.4} /></mesh>
      <mesh position={[.8, 0, 0]}><sphereGeometry args={[.28, 20, 16]} /><meshStandardMaterial color={colors.negative} emissive={colors.negative} emissiveIntensity={.4} /></mesh>
      <Line points={[new THREE.Vector3(-.8, 0, 0), new THREE.Vector3(.8, 0, 0)]} color="#d8e4ef" lineWidth={2} />
    </group>
  );
}

/** Canvas 内侧：把真实相机 / OrbitControls 句柄注册到相机桥，并响应帧恢复。 */
function CameraRig({ bridgeRef }: { bridgeRef: React.MutableRefObject<CameraBridgeHandle | null> }) {
  const camera = useThree((s) => s.camera);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  useEffect(() => {
    const handle: CameraBridgeHandle = {
      read(): CameraFrame {
        const controls = controlsRef.current;
        const p = camera.position;
        const t = controls ? controls.target : new THREE.Vector3(0, 0, 0);
        return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
      },
      apply(frame: CameraFrame): void {
        const [px, py, pz] = frame.position;
        const [tx, ty, tz] = frame.target;
        for (const v of [px, py, pz, tx, ty, tz]) {
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            throw new Error('相机帧包含非有限数值');
          }
        }
        // 位置与目标同一同步任务写入，浏览器绘制前不会出现撕裂帧。
        camera.position.set(px, py, pz);
        const controls = controlsRef.current;
        if (controls) {
          controls.target.set(tx, ty, tz);
          controls.update();
        } else {
          camera.lookAt(tx, ty, tz);
        }
      },
    };
    bridgeRef.current = handle;
    return () => {
      // 仅当注册者仍是自己时注销，避免挤掉 StrictMode 重挂载后的新句柄。
      if (bridgeRef.current === handle) bridgeRef.current = null;
    };
  }, [camera, bridgeRef]);

  return (
    <OrbitControls
      makeDefault
      ref={(impl) => {
        controlsRef.current = impl;
      }}
      minDistance={5}
      maxDistance={14}
    />
  );
}

function EMScene({ controls, bridgeRef }: { controls: ExperimentControls; bridgeRef: React.MutableRefObject<CameraBridgeHandle | null> }) {
  const { mode, strength, showVectors } = controls;
  return (
    <Canvas camera={{ position: [6, 4.5, 8], fov: 42 }}>
      <color attach="background" args={['#0b0b1c']} />
      <ambientLight intensity={1.2} />
      <pointLight position={[3, 4, 5]} color="#9a8cff" intensity={18} />
      <pointLight position={[-4, -2, 2]} color="#49d5e7" intensity={12} />
      <group rotation={[.18, -.24, 0]}>
        <Source mode={mode} strength={strength} />
        <FieldLines mode={mode} />
        <Vectors mode={mode} strength={strength} showVectors={showVectors} />
        <mesh position={[0, 0, -.45]}>
          <planeGeometry args={[7, 6]} />
          <meshBasicMaterial color="#25234b" transparent opacity={.12} side={THREE.DoubleSide} />
        </mesh>
      </group>
      <CameraRig bridgeRef={bridgeRef} />
    </Canvas>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

export default function App() {
  const [controls, setControls] = useState<ExperimentControls>({ mode: 'dipole', strength: 1.6, showVectors: true });
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const session = useExperimentSession(controlsRef);
  // 绑定真实 setState：原子恢复时控制区与相机处于同一同步任务，无中间渲染。
  session.bindSetControls(setControls);

  const seq = session.state.sequencer;
  const locked = seq.status !== 'idle'; // 回放/暂停期间锁定实时编辑，避免与时间轴竞争
  const modeLabel = { dipole: '电偶极子', coil: '螺线管', capacitor: '平行板电容器' }[controls.mode];
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const patch = (p: Partial<ExperimentControls>) => {
    if (!locked) setControls((c) => ({ ...c, ...p }));
  };

  const onPickFile = () => fileInputRef.current?.click();
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许再次选择同一文件
    if (file) await session.importFile(file);
  };

  const statusText = seq.status === 'playing' ? '播放中' : seq.status === 'paused' ? '已暂停' : '待机';
  const currentLabel = seq.index >= 0 ? seq.checkpoints[seq.index]?.label ?? '—' : '播放前画面';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">✦</div>
          <div>
            <span className="eyebrow">ELECTROMAGNETISM / FIELD EXPLORER</span>
            <h1>ElectroMag Lab <span>·</span> 电磁场与磁力线</h1>
          </div>
        </div>
        <div className="header-meta">
          <span className="dataset">MODEL 03 / {modeLabel}</span>
          <button onClick={() => patch({ showVectors: !controls.showVectors })} disabled={locked}>
            {controls.showVectors ? '隐藏场矢量' : '显示场矢量'}
          </button>
        </div>
      </header>
      <main className="layout">
        <section className="model-card">
          <div className="model-head">
            <div>
              <span className="eyebrow">3D FIELD MAPPING</span>
              <h2>{modeLabel} · Field Line Tracer</h2>
            </div>
            <div className="mode-switch">
              {(['dipole', 'coil', 'capacitor'] as Mode[]).map((item) => (
                <button key={item} className={controls.mode === item ? 'active' : ''} disabled={locked} onClick={() => patch({ mode: item })}>
                  {item === 'dipole' ? '电偶极子' : item === 'coil' ? '螺线管' : '平行板'}
                </button>
              ))}
            </div>
          </div>
          <div className="canvas-wrap">
            <EMScene controls={controls} bridgeRef={session.cameraBridge} />
            <div className="viewer-legend">
              <span><i className="dot protein" />场线</span>
              <span><i className="dot ligand" />场源</span>
              <span><i className="dot interaction" />矢量采样</span>
            </div>
            <div className="viewer-hint">{locked ? '回放中 · 控制已锁定' : '左键旋转 · 滚轮缩放 · 切换场源模型'}</div>
          </div>
        </section>
        <aside className="sidebar">
          <section className="panel intro-panel">
            <span className="eyebrow">FIELD EXPERIMENT</span>
            <h3>三维场线实验台</h3>
            <p>在电偶极子、螺线管与平行板电容器之间切换，观察电场/磁场的空间拓扑和方向分布。</p>
            <div className="metrics">
              <Metric label="场强系数" value={controls.strength.toFixed(1)} note="归一化" />
              <Metric label="场线束" value={controls.mode === 'capacitor' ? '10' : '14'} note="采样轨迹" />
              <Metric label="采样矢量" value={controls.showVectors ? '25' : '关闭'} note="网格采样" />
            </div>
          </section>
          <section className="panel">
            <div className="panel-title"><div><span className="eyebrow">SOURCE CONTROL</span><h3>场源与强度</h3></div></div>
            <label className="control">
              <span>激励强度 <b>{controls.strength.toFixed(1)} ×</b></span>
              <input type="range" min=".5" max="3" step=".1" value={controls.strength} disabled={locked} onChange={(e) => patch({ strength: Number(e.target.value) })} />
            </label>
            <div className="source-list">
              {(['dipole', 'coil', 'capacitor'] as Mode[]).map((item) => (
                <button key={item} className={controls.mode === item ? 'source active' : 'source'} disabled={locked} onClick={() => patch({ mode: item })}>
                  <span className={`source-dot ${item}`} />
                  {item === 'dipole' ? '电偶极子' : item === 'coil' ? '通电螺线管' : '平行板电容器'}
                  <em>{item === 'dipole' ? 'E' : item === 'coil' ? 'B' : 'E'}</em>
                </button>
              ))}
            </div>
          </section>
          <SessionPanel
            session={session}
            statusText={statusText}
            currentLabel={currentLabel}
            locked={locked}
            onPickFile={onPickFile}
            fileInputRef={fileInputRef}
            onFileChange={onFileChange}
          />
        </aside>
      </main>
    </div>
  );
}
