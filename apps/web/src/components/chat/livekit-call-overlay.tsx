'use client';

import {
  Maximize2,
  MicOff,
  Mic,
  Minimize2,
  Monitor,
  MonitorOff,
  PhoneOff,
  Video,
  VideoOff,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ScreenShareQualityMenu } from '@/components/chat/screen-share-quality-menu';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/ui/avatar';
import { useFullscreen } from '@/hooks/use-fullscreen';
import type { LivekitParticipantView, LivekitPhase } from '@/hooks/use-livekit-room';
import type { ScreenShareQuality } from '@/lib/screen-share-quality';
import { cn } from '@/lib/utils';

interface Props {
  phase: LivekitPhase;
  participants: LivekitParticipantView[];
  micEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;
  screenShareQuality: ScreenShareQuality;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onChangeScreenShareQuality: (quality: ScreenShareQuality) => void;
  onEnd: () => void;
  /** Display title - usually the chat-room name. */
  title: string;
  /**
   * Optional override for the status pill text. When omitted we derive
   * status from `phase` ("Connecting…" / "Reconnecting…" / etc.). Parent
   * passes a value to swap "Connecting…" for "Calling…" (peer offline)
   * or "Ringing…" (peer online but hasn't answered) while we wait for
   * the LiveKit handshake to start.
   */
  statusOverride?: string;
}

/**
 * Multi-participant call overlay backed by LiveKit. When nobody is sharing
 * a screen the layout is the participant-tile grid (1 → 1×1, 2 → 2×1,
 * 3-4 → 2×2, more → 3-column wrap). When somebody is sharing, the share
 * promotes to a dominant tile across the top and participant tiles strip
 * along the bottom - same shape Slack / Meet use for screen-sharing.
 *
 * Brand-aligned controls: gradient pill for active states, white-glass for
 * toggle buttons, and a destructive red for the hang-up pill. The phase
 * pill at the top reflects every LiveKit state including
 * reconnecting → "Reconnecting…" so the user knows it's recovering rather
 * than dead.
 */
export function LivekitCallOverlay({
  phase,
  participants,
  micEnabled,
  cameraEnabled,
  screenShareEnabled,
  screenShareQuality,
  onToggleMic,
  onToggleCamera,
  onToggleScreenShare,
  onChangeScreenShareQuality,
  onEnd,
  title,
  statusOverride,
}: Props) {
  const status =
    statusOverride ??
    (phase === 'connecting'
      ? 'Connecting…'
      : phase === 'reconnecting'
        ? 'Reconnecting…'
        : phase === 'error'
          ? 'Connection lost'
          : phase === 'connected'
            ? `${participants.length} ${participants.length === 1 ? 'participant' : 'participants'}`
            : 'Idle');

  // Everyone currently presenting a screen. When two people share at once we
  // let the user choose which one fills the stage.
  const screenSharers = useMemo(
    () => participants.filter((p) => p.screenSharing),
    [participants],
  );

  // The share the user has explicitly focused (null = let us pick a default).
  const [focusedShareId, setFocusedShareId] = useState<string | null>(null);

  // The share promoted to the main stage: honour the user's pick, but fall
  // back to the first remote share (then the local one) so a stale pick - the
  // chosen sharer stopped presenting - never blanks the stage.
  const activeShare = useMemo<LivekitParticipantView | null>(() => {
    if (screenSharers.length === 0) return null;
    const picked = screenSharers.find((p) => p.identity === focusedShareId);
    if (picked) return picked;
    return screenSharers.find((p) => !p.isLocal) ?? screenSharers[0] ?? null;
  }, [screenSharers, focusedShareId]);

  const tileGridClass = (() => {
    const c = participants.length;
    if (c <= 1) return 'grid-cols-1 grid-rows-1';
    if (c === 2) return 'grid-cols-2 grid-rows-1';
    if (c <= 4) return 'grid-cols-2 grid-rows-2';
    return 'grid-cols-3 auto-rows-fr';
  })();

  return (
    <div
      role="dialog"
      aria-label="Active call"
      className="fixed inset-0 z-50 flex flex-col bg-[#0F0F1A] text-white"
    >
      {/* Top status pill */}
      <div className="pointer-events-none absolute left-1/2 top-5 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-white/10 px-4 py-1.5 text-center backdrop-blur">
        <span
          aria-hidden
          className={cn(
            'h-2 w-2 rounded-full',
            phase === 'connected' && 'bg-brand-teal',
            phase === 'connecting' && 'animate-pulse bg-brand-orange',
            phase === 'reconnecting' && 'animate-pulse bg-brand-orange',
            phase === 'error' && 'bg-state-error',
            (phase === 'idle' || phase === undefined) && 'bg-ink-muted',
          )}
        />
        <span className="text-sm font-medium">{title}</span>
        <span aria-hidden className="text-white/30">·</span>
        <span aria-live="polite" className="text-[11px] text-white/70">
          {status}
        </span>
      </div>

      {/* Stage */}
      <div className="flex-1 min-h-0 overflow-hidden p-4 pb-32 pt-20">
        {activeShare ? (
          // Sharing mode: presenter at top, participant strip at bottom.
          <div className="grid h-full grid-rows-[minmax(0,1fr)_120px] gap-3">
            <ScreenShareStage
              participant={activeShare}
              sharers={screenSharers}
              activeId={activeShare.identity}
              onSelectShare={setFocusedShareId}
              onStopLocalShare={
                screenShareEnabled ? onToggleScreenShare : undefined
              }
            />
            <div className="grid h-full grid-flow-col grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2 overflow-x-auto">
              {participants.map((p) => (
                <ParticipantTile key={p.identity} participant={p} compact />
              ))}
            </div>
          </div>
        ) : (
          <div className={cn('grid h-full w-full gap-3', tileGridClass)}>
            {participants.map((p) => (
              <ParticipantTile key={p.identity} participant={p} />
            ))}
            {participants.length === 0 ? (
              <div className="col-span-full row-span-full flex flex-col items-center justify-center gap-2 text-sm text-white/50">
                <div className="spinner-gradient" aria-hidden />
                {phase === 'connecting' ? 'Connecting…' : 'Waiting for participants…'}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Bottom control bar */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2">
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2 py-2 backdrop-blur-lg shadow-soft-lg">
          <CallButton
            ariaLabel={micEnabled ? 'Mute microphone' : 'Unmute microphone'}
            onClick={onToggleMic}
            active={micEnabled}
            danger={!micEnabled}
          >
            {micEnabled ? (
              <Mic className="h-5 w-5" />
            ) : (
              <MicOff className="h-5 w-5" />
            )}
          </CallButton>
          <CallButton
            ariaLabel={cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
            onClick={onToggleCamera}
            active={cameraEnabled}
            danger={!cameraEnabled}
          >
            {cameraEnabled ? (
              <Video className="h-5 w-5" />
            ) : (
              <VideoOff className="h-5 w-5" />
            )}
          </CallButton>
          <CallButton
            ariaLabel={
              screenShareEnabled ? 'Stop screen share' : 'Share your screen'
            }
            onClick={onToggleScreenShare}
            active={screenShareEnabled}
          >
            {screenShareEnabled ? (
              <MonitorOff className="h-5 w-5" />
            ) : (
              <Monitor className="h-5 w-5" />
            )}
          </CallButton>
          <ScreenShareQualityMenu
            value={screenShareQuality}
            onChange={onChangeScreenShareQuality}
            variant="overlay"
            sharing={screenShareEnabled}
          />
          <div className="mx-1 h-8 w-px bg-white/10" aria-hidden />
          <Button
            type="button"
            size="icon"
            aria-label="End call"
            onClick={onEnd}
            className="h-12 w-12 min-h-0 min-w-0 rounded-full bg-state-error text-white shadow-soft hover:bg-[#D03B40]"
          >
            <PhoneOff className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

interface CallButtonProps {
  ariaLabel: string;
  onClick: () => void;
  active: boolean;
  /** When true the button paints in the destructive red palette - used
   *  for "you're muted" / "camera off" so it's obvious at a glance. */
  danger?: boolean;
  children: React.ReactNode;
}

function CallButton({
  ariaLabel,
  onClick,
  active,
  danger,
  children,
}: CallButtonProps) {
  return (
    <Button
      type="button"
      size="icon"
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        'h-12 w-12 min-h-0 min-w-0 rounded-full transition-all',
        danger
          ? 'bg-state-error/85 text-white hover:bg-state-error'
          : active
            ? 'bg-brand-gradient text-white shadow-soft hover:shadow-soft-lg'
            : 'bg-white/10 text-white hover:bg-white/20',
      )}
    >
      {children}
    </Button>
  );
}

function ScreenShareStage({
  participant,
  sharers,
  activeId,
  onSelectShare,
  onStopLocalShare,
}: {
  participant: LivekitParticipantView;
  sharers: LivekitParticipantView[];
  activeId: string;
  onSelectShare: (identity: string) => void;
  /** Provided only when the local user is sharing - stops their own share. */
  onStopLocalShare?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { isFullscreen, toggle } = useFullscreen(containerRef);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const track = participant.screenTrack;
    if (!track) return;
    track.attach(v);
    return () => {
      track.detach(v);
    };
  }, [participant.screenTrack]);

  // Switcher only matters when more than one person is presenting.
  const multiShare = sharers.length > 1;
  const localSharing = sharers.some((p) => p.isLocal);
  // Offer to stop our own share when we're presenting but viewing someone
  // else's screen (covers requirement: "prompt to stop my own share").
  const offerStopLocal = multiShare && localSharing && !participant.isLocal;

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden rounded-xl bg-black ring-1 ring-white/10"
    >
      {participant.screenTrack ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="grid h-full place-items-center">
          <div className="text-sm text-white/60">
            {participant.isLocal
              ? 'You are sharing your screen'
              : `${participant.name} is sharing their screen`}
          </div>
        </div>
      )}

      {/* View switcher: pick which screen fills the stage when 2+ are shared. */}
      {multiShare ? (
        <div className="absolute left-1/2 top-2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/60 p-1 backdrop-blur">
          {sharers.map((s) => (
            <button
              key={s.identity}
              type="button"
              onClick={() => onSelectShare(s.identity)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                s.identity === activeId
                  ? 'bg-white text-black'
                  : 'text-white/80 hover:bg-white/15',
              )}
            >
              {s.isLocal ? 'Your screen' : s.name}
            </button>
          ))}
        </div>
      ) : null}

      {/* Top-right actions: stop-my-share prompt + fullscreen. */}
      <div className="absolute right-2 top-2 flex items-center gap-2">
        {offerStopLocal && onStopLocalShare ? (
          <button
            type="button"
            onClick={onStopLocalShare}
            className="inline-flex items-center gap-1.5 rounded-full bg-state-error/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-state-error"
          >
            <MonitorOff className="h-3.5 w-3.5" aria-hidden />
            Stop your share
          </button>
        ) : null}
        <button
          type="button"
          onClick={toggle}
          aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
          className="grid h-8 w-8 place-items-center rounded-full bg-black/55 text-white hover:bg-black/75"
        >
          {isFullscreen ? (
            <Minimize2 className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </button>
      </div>

      <div className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-black/50 px-2.5 py-1 text-[11px]">
        <Monitor className="h-3 w-3 text-brand-teal" aria-hidden />
        {participant.isLocal
          ? 'Your screen'
          : `${participant.name} is presenting`}
      </div>
    </div>
  );
}

function ParticipantTile({
  participant,
  compact = false,
}: {
  participant: LivekitParticipantView;
  compact?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Attach the camera track for both local and remote participants. For the
  // local user this is the exact track LiveKit publishes, so the preview only
  // exists when the camera is actually on - it never spins the camera up on
  // its own (the previous fresh-getUserMedia preview did, even with the video
  // toggle off).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const track = participant.videoTrack;
    if (track && !participant.videoMuted) {
      track.attach(v);
      return () => {
        track.detach(v);
      };
    }
    v.srcObject = null;
    return undefined;
  }, [participant.videoTrack, participant.videoMuted]);

  // Remote audio only - playing the local mic back would echo.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (participant.isLocal) return;
    const track = participant.audioTrack;
    if (track) {
      track.attach(a);
      a.play().catch(() => {});
      return () => {
        track.detach(a);
      };
    }
    a.srcObject = null;
    return undefined;
  }, [participant.audioTrack, participant.isLocal]);

  const showVideo = !!participant.videoTrack && !participant.videoMuted;

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl bg-[#1A1A2E] ring-1 ring-white/5',
        // Active-speaker glow: gradient ring on top of the dark frame.
        participant.isSpeaking &&
          'ring-2 ring-brand-teal shadow-[0_0_0_2px_rgba(34,197,197,0.35)]',
      )}
    >
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // Mute + mirror the local self-view; remote video plays normally.
          muted={participant.isLocal}
          className={cn(
            'h-full w-full object-cover',
            participant.isLocal && '-scale-x-100',
          )}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <UserAvatar
            size={compact ? 'md' : 'xl'}
            name={participant.name}
            image={null}
          />
        </div>
      )}
      <audio ref={audioRef} autoPlay playsInline className="hidden" />
      <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-2 rounded-md bg-black/55 px-2 py-1 text-xs backdrop-blur-sm">
        <span className="truncate">
          {participant.name}
          {participant.isLocal ? (
            <span className="ml-1 text-white/50">(you)</span>
          ) : null}
        </span>
        <span className="flex items-center gap-1">
          {participant.screenSharing ? (
            <Monitor className="h-3.5 w-3.5 text-brand-teal" aria-label="Sharing" />
          ) : null}
          {participant.audioMuted ? (
            <MicOff className="h-3.5 w-3.5 text-state-error" aria-label="Muted" />
          ) : null}
        </span>
      </div>
    </div>
  );
}
