import { ExperimentSessionApi } from './session/useExperimentSession';

interface SessionPanelProps {
  session: ExperimentSessionApi;
  statusText: string;
  currentLabel: string;
  locked: boolean;
  onPickFile: () => void;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

/**
 * 实验会话面板：不可变检查点时间轴、回放控制、JSON 导入导出。
 * 所有按钮的启用规则与引擎状态机保持一致，UI 层不做“静默失败”的操作。
 */
export function SessionPanel({
  session,
  statusText,
  currentLabel,
  locked,
  onPickFile,
  fileInputRef,
  onFileChange,
}: SessionPanelProps) {
  const { state } = session;
  const seq = state.sequencer;
  const checkpoints = seq.checkpoints;
  const playing = seq.status === 'playing';
  const paused = seq.status === 'paused';
  const notice = state.notice;
  const isError = typeof notice === 'string' && /拒绝|失败|错误|无法|为空|尚未|放弃/.test(notice);

  return (
    <section className="panel session-panel">
      <div className="panel-title">
        <div>
          <span className="eyebrow">EXPERIMENT SESSION</span>
          <h3>实验会话 · 检查点时间轴</h3>
        </div>
        <span className={`session-badge ${seq.status}`}>{statusText}</span>
      </div>

      <label className="control session-name">
        <span>会话名称</span>
        <input
          type="text"
          value={state.name}
          disabled={locked}
          onChange={(e) => session.setName(e.target.value)}
          placeholder="未命名会话"
        />
      </label>

      <div className="session-transport">
        <button
          className="transport-btn"
          onClick={() => (paused ? session.resume() : session.play())}
          disabled={playing || checkpoints.length === 0}
          title="从首个/当前检查点开始播放"
        >
          {paused ? '继续' : '播放'}
        </button>
        <button className="transport-btn" onClick={() => session.pause()} disabled={!playing}>
          暂停
        </button>
        <button
          className="transport-btn warn"
          onClick={() => session.cancel()}
          disabled={seq.status === 'idle'}
          title="取消并恢复到播放前的画面"
        >
          取消
        </button>
        <button
          className="transport-btn"
          onClick={() => session.interrupt()}
          disabled={seq.status === 'idle'}
          title="中断播放，停在当前帧"
        >
          中断
        </button>
        <button
          className="transport-btn primary"
          onClick={() => session.capture()}
          title="把当前场型/强度/矢量开关/相机记录为不可变检查点（回放中会先中断）"
        >
          + 记录检查点
        </button>
      </div>

      <div className="timeline" aria-label="检查点时间轴">
        <div className="timeline-track">
          {checkpoints.length === 0 && <span className="timeline-empty">尚无检查点 — 调整好场景后点击「记录检查点」</span>}
          {checkpoints.map((cp, i) => {
            const active = i === seq.index;
            return (
              <button
                key={cp.id}
                className={`timeline-dot ${active ? 'active' : ''}`}
                // 播放中禁止点击跳转：seek 会打断节奏，避免与自动推进竞争。
                disabled={playing}
                title={`${cp.label} · t=${(cp.t / 1000).toFixed(1)}s\n${cp.controls.mode} · ${cp.controls.strength.toFixed(1)}× · 矢量${cp.controls.showVectors ? '开' : '关'}`}
                onClick={() => session.seek(i)}
              >
                <i />
                <em>{i + 1}</em>
              </button>
            );
          })}
        </div>
        <div className="timeline-meta">
          <span>当前：<b>{currentLabel}</b></span>
          <span>{checkpoints.length > 0 ? `${Math.max(0, seq.index + 1)} / ${checkpoints.length}` : '—'}</span>
        </div>
      </div>

      <div className="session-io">
        <button className="io-btn" onClick={onPickFile} title="导入 JSON 会话（坏文件/未知版本不会影响当前实验）">
          导入 JSON
        </button>
        <button className="io-btn" onClick={() => session.exportToFile()} disabled={checkpoints.length === 0} title="导出为 JSON 文件">
          导出 JSON
        </button>
        <button className="io-btn ghost" onClick={() => session.clear()} disabled={locked || checkpoints.length === 0}>
          清空
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={onFileChange}
          hidden
        />
      </div>

      {notice && (
        <div className={`session-notice ${isError ? 'error' : 'ok'}`} role="status">
          {notice}
        </div>
      )}
      <p className="session-foot">
        检查点为不可变快照（场型 / 强度 / 矢量开关 / 相机位置与注视点）；回放期间控制区锁定，取消将原子恢复到播放前画面。
      </p>
    </section>
  );
}
