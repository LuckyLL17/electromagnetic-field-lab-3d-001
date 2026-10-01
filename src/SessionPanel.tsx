import { useCallback, useEffect, useRef, useState } from 'react';
import {
  appendCheckpoint,
  cloneLab,
  createSession,
  parseSessionText,
  serializeSession,
  sessionDuration,
} from './session/checkpoints';
import { downloadJson, readJsonFile, revokeAllObjectUrls } from './session/io';
import { useTimelinePlayer } from './session/useTimelinePlayer';
import type {
  ExperimentSession,
  FieldMode,
  LabState,
  PlaybackStatus,
} from './session/types';
import type { CameraBridge } from './EMScene';

interface SessionPanelProps {
  lab: LabState;
  session: ExperimentSession;
  /** 原子提交：录制/导入/回放应用/恢复基线都经由同一个入口更新全局状态 */
  onCommit: (next: Partial<LabState> & { cameraNonce?: number; camera?: LabState['camera'] }) => void;
  onSessionChange: (session: ExperimentSession) => void;
  onPlaybackStatusChange: (status: PlaybackStatus) => void;
  bridgeRef: React.MutableRefObject<CameraBridge | null>;
}

type Banner = { kind: 'error' | 'success'; text: string } | null;

function fmtTime(ms: number): string {
  const total = Math.round(ms / 100) / 10;
  const s = Math.floor(total);
  const tenths = Math.round((total - s) * 10);
  return `${s}.${tenths}s`;
}

const MODE_TAG: Record<FieldMode, string> = {
  dipole: '电偶极子',
  coil: '螺线管',
  capacitor: '平行板',
};

export default function SessionPanel({
  lab,
  session,
  onCommit,
  onSessionChange,
  onPlaybackStatusChange,
  bridgeRef,
}: SessionPanelProps) {
  const timeline = useTimelinePlayer();
  const { status, elapsed, index } = timeline;

  const [banner, setBanner] = useState<Banner>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recordStartRef = useRef<number>(performance.now());
  const bannerTimerRef = useRef<number | null>(null);
  // 播放开始前的实验基线：取消或异常中断时原子恢复它
  const baselineRef = useRef<LabState | null>(null);

  // 非空闲（播放/暂停/结束）都锁定编辑：结束态必须先显式“恢复当前实验”，
  // 防止在他人的检查点视角下继续录制造成会话语义混乱
  const busy = status !== 'idle';

  const showBanner = useCallback((b: NonNullable<Banner>) => {
    setBanner(b);
    if (bannerTimerRef.current !== null) window.clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = window.setTimeout(() => {
      bannerTimerRef.current = null;
      setBanner(null);
    }, 4200);
  }, []);

  // 卸载清理：成功提示定时器与尚未回收的 Object URL 都不得残留
  useEffect(() => {
    return () => {
      if (bannerTimerRef.current !== null) window.clearTimeout(bannerTimerRef.current);
      revokeAllObjectUrls();
    };
  }, []);

  useEffect(() => {
    onPlaybackStatusChange(status);
  }, [status, onPlaybackStatusChange]);

  // ---- 录制 ---------------------------------------------------------------

  const record = useCallback(() => {
    const camera = bridgeRef.current?.capture() ?? lab.camera;
    const at = performance.now() - recordStartRef.current;
    const next = appendCheckpoint(session, { ...lab, camera }, at);
    onSessionChange(next);
    showBanner({ kind: 'success', text: `已记录检查点 #${next.checkpoints.length}` });
  }, [bridgeRef, lab, session, onSessionChange, showBanner]);

  /** 放弃当前会话，从空时间轴重新开始（回放期间禁用） */
  const newSession = useCallback(() => {
    recordStartRef.current = performance.now();
    onSessionChange(createSession());
    setBanner(null);
  }, [onSessionChange]);

  // ---- 回放 ---------------------------------------------------------------

  const startPlayback = useCallback(() => {
    if (session.checkpoints.length === 0) {
      showBanner({ kind: 'error', text: '当前会话没有检查点，无法回放' });
      return;
    }
    // 基线在启动瞬间捕获【实时相机】，保证取消后恢复的是用户真实视角
    const liveCamera = bridgeRef.current?.capture() ?? lab.camera;
    baselineRef.current = cloneLab({ ...lab, camera: liveCamera });
    timeline.start(session.checkpoints, {
      // 关键原子点：场型/强度/矢量开关 + 相机在同一次提交中生效
      onApply: (cp) => {
        onCommit({
          mode: cp.mode,
          strength: cp.strength,
          showVectors: cp.showVectors,
          camera: cp.camera,
          cameraNonce: Date.now() + Math.random(),
        });
      },
      // 取消：原子恢复基线，当前实验不被半程状态污染
      onCancel: () => {
        const base = baselineRef.current;
        if (base) {
          onCommit({
            mode: base.mode,
            strength: base.strength,
            showVectors: base.showVectors,
            camera: base.camera,
            cameraNonce: Date.now() + Math.random(),
          });
        }
        baselineRef.current = null;
      },
      onFinish: () => {
        baselineRef.current = null;
      },
    });
  }, [bridgeRef, lab, session, timeline, onCommit, showBanner]);

  // ---- 导入导出 -----------------------------------------------------------

  const exportSession = useCallback(() => {
    if (session.checkpoints.length === 0) {
      showBanner({ kind: 'error', text: '没有检查点可导出，请先录制' });
      return;
    }
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      downloadJson(`em-lab-session-${stamp}.json`, serializeSession(session));
      showBanner({ kind: 'success', text: '会话 JSON 已导出' });
    } catch (err) {
      // 导出失败也回收已创建的 Object URL（downloadJson 已做调度，这里兜底）
      revokeAllObjectUrls();
      showBanner({ kind: 'error', text: `导出失败：${(err as Error).message}` });
    }
  }, [session, showBanner]);

  const handleFile = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      try {
        const text = await readJsonFile(file);
        // 先完整解析+校验，成功后才提交；坏文件在这一步即被拒绝，
        // 当前实验与当前会话都不会被修改。
        const parsed = parseSessionText(text);
        recordStartRef.current = performance.now() - sessionDuration(parsed);
        onSessionChange(parsed);
        showBanner({
          kind: 'success',
          text: `已导入「${parsed.name}」· ${parsed.checkpoints.length} 个检查点`,
        });
      } catch (err) {
        showBanner({ kind: 'error', text: (err as Error).message });
      }
    },
    [onSessionChange, showBanner],
  );

  const duration = sessionDuration(session);
  const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;

  const statusLabel: Record<PlaybackStatus, string> = {
    idle: '就绪',
    playing: '回放中',
    paused: '已暂停',
    ended: '回放结束',
  };

  return (
    <section className={`panel session-panel${busy ? ' busy' : ''}`}>
      <div className="panel-title">
        <div>
          <span className="eyebrow">EXPERIMENT SESSION</span>
          <h3>实验会话 · 检查点时间轴</h3>
        </div>
        <span className={`session-status status-${status}`}>● {statusLabel[status]}</span>
      </div>

      <p className="session-name" title={session.name}>
        {session.name} · 共 {session.checkpoints.length} 个检查点
      </p>

      {banner && <div className={`session-banner ${banner.kind}`}>{banner.text}</div>}

      {/* 录制与传输：回放期间一律禁用，防止两条时间线互相污染 */}
      <div className="session-actions">
        <button className="primary" onClick={record} disabled={busy} title={busy ? '回放未结束，请先取消或恢复' : ''}>
          ● 记录检查点
        </button>
        <button onClick={exportSession} disabled={busy}>
          ↥ 导出 JSON
        </button>
        <button onClick={() => fileInputRef.current?.click()} disabled={busy}>
          ↧ 导入 JSON
        </button>
        <button onClick={newSession} disabled={busy} title="清空当前会话并重新开始">
          ＋ 新会话
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            // 重置 value：同一文件可再次选择（验证“重新导入”场景）
            e.target.value = '';
          }}
        />
      </div>

      {/* 时间轴 */}
      <div className={`timeline${status === 'idle' ? ' idle' : ''}`}>
        <div
          className="timeline-track"
          onClick={(e) => {
            if (status === 'idle' || duration === 0) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            timeline.seek(ratio * duration);
          }}
        >
          <div className="timeline-progress" style={{ width: `${progress * 100}%` }} />
          {session.checkpoints.map((cp, i) => (
            <button
              key={cp.id}
              type="button"
              className={`timeline-dot${i === index && status !== 'idle' ? ' active' : ''}`}
              style={{ left: `${duration > 0 ? (cp.at / duration) * 100 : 0}%` }}
              title={`${cp.label} · ${fmtTime(cp.at)}`}
              onClick={(e) => {
                e.stopPropagation();
                if (status !== 'idle') timeline.seek(cp.at);
              }}
            />
          ))}
        </div>
        <div className="timeline-time">
          <span>{fmtTime(elapsed)}</span>
          <span>{fmtTime(duration)}</span>
        </div>
      </div>

      {/* 传输控制 */}
      <div className="transport">
        {status === 'idle' && (
          <button className="primary" onClick={startPlayback} disabled={session.checkpoints.length === 0}>
            ▶ 回放
          </button>
        )}
        {status === 'playing' && <button onClick={timeline.pause}>⏸ 暂停</button>}
        {status === 'paused' && <button className="primary" onClick={timeline.resume}>▶ 继续</button>}
        {(status === 'playing' || status === 'paused') && (
          <button onClick={timeline.cancel}>■ 取消并恢复</button>
        )}
        {status === 'ended' && (
          <>
            <button className="primary" onClick={startPlayback}>↻ 重新回放</button>
            <button onClick={timeline.cancel}>↩ 恢复当前实验</button>
          </>
        )}
      </div>

      {/* 检查点列表 */}
      <ul className="checkpoint-list">
        {session.checkpoints.length === 0 && <li className="checkpoint-empty">尚未记录检查点。调好场型、强度、矢量开关与视角后点击“记录检查点”。</li>}
        {session.checkpoints.map((cp, i) => (
          <li
            key={cp.id}
            className={`checkpoint-item${i === index && status !== 'idle' ? ' active' : ''}`}
            onClick={() => {
              if (status !== 'idle') timeline.seek(cp.at);
            }}
          >
            <span className="cp-index">{i + 1}</span>
            <span className="cp-label">{cp.label}</span>
            <span className="cp-meta">
              {MODE_TAG[cp.mode]} · {cp.strength.toFixed(1)}× · {cp.showVectors ? '矢量开' : '矢量关'}
            </span>
            <span className="cp-time">{fmtTime(cp.at)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
