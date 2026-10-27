'use client';

import { Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/** Playback speeds cycled by the speed pill, WhatsApp-style. */
const SPEEDS = [1, 1.5, 2] as const;

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Inline voice-message player (WhatsApp-style): play/pause, a draggable
 * progress scrubber with elapsed/total time, and a 1x/1.5x/2x speed toggle.
 * Replaces the bare native `<audio controls>` so audio can be controlled
 * directly in the bubble instead of via the message menu.
 *
 * `fromMe` flips the palette so the control reads well on the sender's
 * gradient bubble vs. the neutral incoming bubble.
 */
export function VoiceMessage({
  src,
  fileName,
  fromMe,
}: {
  src: string;
  fileName: string;
  fromMe: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);

  // Some webm/ogg blobs report duration = Infinity until you force a seek.
  // Nudge to a large time, then back, to coax the real duration out.
  const resolveDuration = useCallback((el: HTMLAudioElement) => {
    if (Number.isFinite(el.duration) && el.duration > 0) {
      setDuration(el.duration);
      return;
    }
    const onSeeked = () => {
      el.currentTime = 0;
      setDuration(Number.isFinite(el.duration) ? el.duration : 0);
      el.removeEventListener('seeked', onSeeked);
    };
    el.addEventListener('seeked', onSeeked);
    el.currentTime = 1e101;
  }, []);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrent(el.currentTime);
    const onMeta = () => resolveDuration(el);
    const onEnd = () => {
      setPlaying(false);
      setCurrent(0);
      el.currentTime = 0;
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('ended', onEnd);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('ended', onEnd);
    };
  }, [resolveDuration]);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
      setPlaying(true);
    } else {
      el.pause();
      setPlaying(false);
    }
  }, []);

  const onSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const el = audioRef.current;
    if (!el) return;
    const t = Number(e.target.value);
    el.currentTime = t;
    setCurrent(t);
  }, []);

  const cycleSpeed = useCallback(() => {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next]!;
  }, [speedIdx]);

  const pct = duration > 0 ? (current / duration) * 100 : 0;
  const accent = fromMe ? 'text-white' : 'text-ink';
  const subtle = fromMe ? 'text-white/70' : 'text-ink-muted';

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg px-2 py-1.5',
        fromMe ? 'bg-white/10' : 'bg-bg-subtle',
        'min-w-[220px] max-w-[280px]',
      )}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} preload="metadata" src={src} />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          fromMe ? 'bg-white/20 hover:bg-white/30' : 'bg-line hover:bg-ink/10',
          accent,
        )}
      >
        {playing ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4 translate-x-[1px]" />
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={current}
          onChange={onSeek}
          aria-label={`Seek ${fileName}`}
          className={cn(
            'h-1 w-full cursor-pointer appearance-none rounded-full',
            fromMe ? 'bg-white/30' : 'bg-line',
          )}
          style={{
            backgroundImage: `linear-gradient(to right, currentColor ${pct}%, transparent ${pct}%)`,
          }}
        />
        <div className={cn('flex justify-between text-[10px] tabular-nums', subtle)}>
          <span>{fmt(current)}</span>
          <span>{fmt(duration)}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={cycleSpeed}
        aria-label="Change playback speed"
        className={cn(
          'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
          fromMe ? 'bg-white/20 hover:bg-white/30' : 'bg-line hover:bg-ink/10',
          accent,
        )}
      >
        {SPEEDS[speedIdx]}x
      </button>
    </div>
  );
}
