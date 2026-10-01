import { useCallback, useRef, useState } from 'react';
import EMScene, { type CameraBridge } from './EMScene';
import SessionPanel from './SessionPanel';
import { DEFAULT_CAMERA, createSession } from './session/checkpoints';
import type { ExperimentSession, FieldMode, LabState, PlaybackStatus } from './session/types';

type Mode = FieldMode;

const MODES: Mode[] = ['dipole', 'coil', 'capacitor'];
const MODE_LABEL: Record<Mode, string> = {
  dipole: '电偶极子',
  coil: '螺线管',
  capacitor: '平行板电容器',
};

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

export default function App() {
  // 控制区与三维场景的唯一真源；任何变更都通过一次原子提交完成。
  // cameraNonce 与 camera 同生同灭：同一次提交里 UI props 与相机恢复一起生效。
  const [lab, setLab] = useState<LabState & { cameraNonce: number }>({
    mode: 'dipole',
    strength: 1.6,
    showVectors: true,
    camera: DEFAULT_CAMERA,
    cameraNonce: 0,
  });
  const [session, setSession] = useState<ExperimentSession>(() => createSession());
  const [playback, setPlayback] = useState<PlaybackStatus>('idle');

  // 三维场景注册上来的相机桥；录制/捕获基线时经它取【复制快照】
  const bridgeRef = useRef<CameraBridge | null>(null);
  const registerBridge = useCallback((bridge: CameraBridge | null) => {
    bridgeRef.current = bridge;
  }, []);

  /**
   * 原子提交入口：所有字段（场型/强度/矢量开关/相机）合并进同一次 setState，
   * React 只产生一次渲染提交，EMScene 的 useLayoutEffect 在绘制前把相机
   * 写入 Three.js —— 控制区与三维场景绝不可能出现半同步状态。
   */
  const commit = useCallback(
    (next: Partial<LabState> & { cameraNonce?: number }) => {
      setLab((prev) => {
        if (!next.camera && !('cameraNonce' in next)) return { ...prev, ...next };
        return {
          ...prev,
          ...next,
          camera: next.camera ?? prev.camera,
          cameraNonce: next.cameraNonce ?? prev.cameraNonce,
        };
      });
    },
    [],
  );

  // 回放期间锁定控制区：避免用户改动与检查点应用相互覆盖
  const locked = playback === 'playing' || playback === 'paused';
  const modeLabel = MODE_LABEL[lab.mode];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">✦</div>
          <div>
            <span className="eyebrow">ELECTROMAGNETISM / FIELD EXPLORER</span>
            <h1>
              ElectroMag Lab <span>·</span> 电磁场与磁力线
            </h1>
          </div>
        </div>
        <div className="header-meta">
          <span className="dataset">MODEL 03 / {modeLabel}</span>
          <button
            onClick={() => !locked && setLab((v) => ({ ...v, showVectors: !v.showVectors }))}
            disabled={locked}
            title={locked ? '回放进行中，控制已锁定' : ''}
          >
            {lab.showVectors ? '隐藏场矢量' : '显示场矢量'}
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
              {MODES.map((item) => (
                <button
                  key={item}
                  className={lab.mode === item ? 'active' : ''}
                  disabled={locked}
                  onClick={() => setLab((v) => ({ ...v, mode: item }))}
                >
                  {item === 'dipole' ? '电偶极子' : item === 'coil' ? '螺线管' : '平行板'}
                </button>
              ))}
            </div>
          </div>
          <div className="canvas-wrap">
            <EMScene
              mode={lab.mode}
              strength={lab.strength}
              showVectors={lab.showVectors}
              interactive={!locked}
              cameraNonce={lab.cameraNonce}
              restoreCamera={lab.camera}
              registerBridge={registerBridge}
            />
            {locked && <div className="playback-banner">时间轴回放中 · 控制台已锁定</div>}
            <div className="viewer-legend">
              <span>
                <i className="dot protein" />
                场线
              </span>
              <span>
                <i className="dot ligand" />
                场源
              </span>
              <span>
                <i className="dot interaction" />
                矢量采样
              </span>
            </div>
            <div className="viewer-hint">左键旋转 · 滚轮缩放 · 切换场源模型</div>
          </div>
        </section>

        <aside className="sidebar">
          <section className="panel intro-panel">
            <span className="eyebrow">FIELD EXPERIMENT</span>
            <h3>三维场线实验台</h3>
            <p>在电偶极子、螺线管与平行板电容器之间切换，观察电场/磁场的空间拓扑和方向分布。</p>
            <div className="metrics">
              <Metric label="场强系数" value={lab.strength.toFixed(1)} note="归一化" />
              <Metric label="场线束" value={lab.mode === 'capacitor' ? '10' : '14'} note="采样轨迹" />
              <Metric label="采样矢量" value={lab.showVectors ? '25' : '关闭'} note="网格采样" />
            </div>
          </section>

          <SessionPanel
            lab={{ mode: lab.mode, strength: lab.strength, showVectors: lab.showVectors, camera: lab.camera }}
            session={session}
            onCommit={commit}
            onSessionChange={setSession}
            onPlaybackStatusChange={setPlayback}
            bridgeRef={bridgeRef}
          />

          <section className={`panel${locked ? ' disabled-panel' : ''}`}>
            <div className="panel-title">
              <div>
                <span className="eyebrow">SOURCE CONTROL</span>
                <h3>场源与强度</h3>
              </div>
            </div>
            <label className="control">
              <span>
                激励强度 <b>{lab.strength.toFixed(1)} ×</b>
              </span>
              <input
                type="range"
                min=".5"
                max="3"
                step=".1"
                value={lab.strength}
                disabled={locked}
                onChange={(e) => setLab((v) => ({ ...v, strength: Number(e.target.value) }))}
              />
            </label>
            <div className="source-list">
              {MODES.map((item) => (
                <button
                  key={item}
                  className={lab.mode === item ? 'source active' : 'source'}
                  disabled={locked}
                  onClick={() => setLab((v) => ({ ...v, mode: item }))}
                >
                  <span className={`source-dot ${item}`} />
                  {item === 'dipole' ? '电偶极子' : item === 'coil' ? '通电螺线管' : '平行板电容器'}
                  <em>{item === 'dipole' ? 'E' : item === 'coil' ? 'B' : 'E'}</em>
                </button>
              ))}
            </div>
          </section>

          <section className="panel">
            <span className="eyebrow">FIELD READOUT</span>
            <div className="readout">
              <div>
                <span>当前场型</span>
                <b>{lab.mode === 'coil' ? '近似磁场' : '静电场'}</b>
              </div>
              <div>
                <span>方向约定</span>
                <b>{lab.mode === 'coil' ? '右手螺旋定则' : '+ → −'}</b>
              </div>
              <div>
                <span>模型精度</span>
                <b>教学级采样</b>
              </div>
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}
