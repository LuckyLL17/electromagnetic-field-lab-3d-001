import { useCallback, useEffect, useRef, useState } from 'react';
import { rafClock, TimelinePlayer, type PlayerHandlers, type TimelineClock } from './player.js';
import type { PlaybackStatus, SessionCheckpoint } from './types';

export interface TimelineApi {
  status: PlaybackStatus;
  elapsed: number;
  index: number;
  /** 启动一次回放（再次调用即重播）。handlers 在启动时捕获，保证拿到最新回调 */
  start: (checkpoints: readonly SessionCheckpoint[], handlers: PlayerHandlers) => void;
  pause: () => void;
  resume: () => void;
  seek: (elapsed: number) => void;
  cancel: () => void;
}

/**
 * 托管 TimelinePlayer 生命周期的 Hook：
 *  - 卸载时 dispose，rAF 句柄绝不残留；
 *  - 每次 start 先销毁旧播放器再建新实例，旧循环不可能继续触发；
 *  - 每帧只同步本 Hook 内部状态（进度条）；外部 handlers.onStatusChange
 *    仅在【播放状态或激活检查点】变化时触发，避免宿主组件被 60fps 拖着重渲染。
 */
export function useTimelinePlayer(clock: TimelineClock = rafClock): TimelineApi {
  const playerRef = useRef<TimelinePlayer | null>(null);
  const [status, setStatus] = useState<PlaybackStatus>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [index, setIndex] = useState(0);
  const lastExternal = useRef<{ s: PlaybackStatus; i: number } | null>(null);

  const start = useCallback(
    (checkpoints: readonly SessionCheckpoint[], handlers: PlayerHandlers) => {
      playerRef.current?.dispose();
      lastExternal.current = null;
      const player = new TimelinePlayer(
        checkpoints,
        {
          ...handlers,
          onStatusChange: (s, e, i) => {
            setStatus(s);
            setElapsed(e);
            setIndex(i);
            const last = lastExternal.current;
            if (!last || last.s !== s || last.i !== i) {
              lastExternal.current = { s, i };
              handlers.onStatusChange?.(s, e, i);
            }
          },
        },
        clock,
      );
      playerRef.current = player;
      player.start();
    },
    [clock],
  );

  const pause = useCallback(() => playerRef.current?.pause(), []);
  const resume = useCallback(() => playerRef.current?.resume(), []);
  const seek = useCallback((e: number) => playerRef.current?.seek(e), []);
  const cancel = useCallback(() => playerRef.current?.cancel(), []);

  useEffect(() => {
    return () => {
      // 卸载仅停帧：播放器 dispose 不会回调 onCancel，杜绝对已卸载组件 setState
      playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, []);

  return { status, elapsed, index, start, pause, resume, seek, cancel };
}
