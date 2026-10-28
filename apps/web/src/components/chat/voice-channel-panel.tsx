'use client';

import type { Track } from 'livekit-client';
import {
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorOff,
  PhoneOff,
  Volume2,
} from 'lucide-react';
import { useEffect, useRef } from 'react';

import { ScreenShareQualityMenu } from '@/components/chat/screen-share-quality-menu';
import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useFullscreen } from '@/hooks/use-fullscreen';
import { useLivekitRoom, type LivekitParticipantView } from '@/hooks/use-livekit-room';
import { cn } from '@/lib/utils';

interface Props {
  roomId: string;
  channelName: string;
}

/**
 * Discord-style voice channel UI. Persistent: anyone can drop in or out
 * without ringing the other participants. Audio-only by default (camera
 * toggle deliberately left out - voice channels are for casual hangs;
 * full video calls go through the DM/GROUP call button).
 *
 * One panel per page mount = one LiveKit `Room`. Navigating away from the
 * channel route unmounts the panel and the `useLivekitRoom` cleanup
 * disconnects, freeing the slot on the server.
 */
export function VoiceChannelPanel({ roomId, channelName }: Props) {
  const lk = useLivekitRoom();

  // Hard-stop if the user navigates between voice channels: the hook keeps
  // its connection scoped to a single room, but the panel itself remounts
  // (component key) so the disconnect in the hook's cleanup runs anyway.
  // This effect is defensive - leaves the room when the surrounding panel
  // is replaced.
  useEffect(() => {
    return () => {
      if (lk.phase !== 'idle') {
        void lk.disconnect();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const joined = lk.phase === 'connected' || lk.phase === 'reconnecting';
  const connecting = lk.phase === 'connecting';

  return (
    <section
      aria-label={`Voice channel ${channelName}`}
      className="border-line border-b bg-white p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="bg-bg-subtle text-ink-muted grid h-9 w-9 place-items-center rounded-full">
            <Volume2 className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="text-ink truncate text-sm font-semibold">{channelName}</div>
            <div className="text-ink-muted text-xs">
              {joined
                ? `${lk.participants.length} connected`
                : connecting
                  ? 'Joining…'
                  : 'Drop in anytime'}
            </div>
          </div>
        </div>

        {!joined ? (
          <Button
            type="button"
            onClick={() => void lk.connect({ kind: 'voice-channel', roomId, withVideo: false })}
            disabled={connecting}
            className="bg-brand-teal hover:bg-emerald-700"
          >
            <Volume2 className="h-4 w-4" />
            {connecting ? 'Joining…' : 'Join voice'}
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={lk.micEnabled ? 'Mute' : 'Unmute'}
              onClick={lk.toggleMic}
              className="bg-bg-subtle hover:bg-line h-9 min-h-0 w-9 min-w-0 rounded-full"
            >
              {lk.micEnabled ? (
                <Mic className="h-4 w-4" />
              ) : (
                <MicOff className="text-state-error h-4 w-4" />
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={lk.screenShareEnabled ? 'Stop screen share' : 'Share your screen'}
              onClick={lk.toggleScreenShare}
              className={cn(
                'h-9 min-h-0 w-9 min-w-0 rounded-full',
                lk.screenShareEnabled
                  ? 'bg-brand-gradient shadow-soft text-white'
                  : 'bg-bg-subtle hover:bg-line',
              )}
            >
              {lk.screenShareEnabled ? (
                <MonitorOff className="h-4 w-4" />
              ) : (
                <Monitor className="h-4 w-4" />
              )}
            </Button>
            <ScreenShareQualityMenu
              value={lk.screenShareQuality}
              onChange={lk.setScreenShareQuality}
              variant="panel"
              sharing={lk.screenShareEnabled}
            />
            <Button
              type="button"
              size="icon"
              aria-label="Leave voice channel"
              onClick={() => void lk.disconnect()}
              className="bg-state-error hover:bg-state-error h-9 min-h-0 w-9 min-w-0 rounded-full text-white"
            >
              <PhoneOff className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {joined && lk.participants.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2" role="list" aria-label="Connected participants">
          {lk.participants.map((p) => (
            <li
              key={p.identity}
              className={cn(
                'bg-bg-subtle flex items-center gap-2 rounded-full px-2 py-1 text-xs',
                p.isSpeaking && 'bg-tint-info ring-brand-teal ring-1',
              )}
            >
              <UserAvatar size="sm" name={p.name} image={null} />
              <span className="text-ink font-medium">
                {p.name}
                {p.isLocal ? <span className="text-ink-disabled ml-1">(you)</span> : null}
              </span>
              {p.screenSharing ? (
                <Monitor className="text-brand-teal h-3 w-3" aria-label="Sharing screen" />
              ) : null}
              {p.audioMuted ? (
                <MicOff className="text-state-error h-3 w-3" aria-label="Muted" />
              ) : null}
              {!p.isLocal && p.audioTrack ? <ParticipantAudioSink track={p.audioTrack} /> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {/* Inline screen-share viewer. The voice channel panel is otherwise
          audio-only - when somebody shares we expand into a presenter
          tile so peers can see the screen without leaving the chat. The
          local share is already visible to the user via the OS picker
          preview but we still render the LiveKit track so they get the
          same view their peers do (and can verify what's being shared). */}
      {joined
        ? lk.participants
            .filter((p) => p.screenSharing)
            .map((presenter) => (
              <ScreenShareTile key={`share-${presenter.identity}`} participant={presenter} />
            ))
        : null}
    </section>
  );
}

function ScreenShareTile({ participant }: { participant: LivekitParticipantView }) {
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
  return (
    <div
      ref={containerRef}
      className="ring-line mt-3 flex flex-col overflow-hidden rounded-lg bg-[#0F0F1A] ring-1"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-white">
        <span className="flex items-center gap-2">
          <Monitor className="text-brand-teal h-3.5 w-3.5" aria-hidden />
          <span>
            {participant.isLocal
              ? 'You are sharing your screen'
              : `${participant.name} is presenting`}
          </span>
        </span>
        <button
          type="button"
          onClick={toggle}
          aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
          className="grid h-7 w-7 place-items-center rounded-full text-white/80 hover:bg-white/10"
        >
          {isFullscreen ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      {participant.screenTrack ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={participant.isLocal}
          className={cn(
            'w-full bg-black object-contain',
            // Cap height inline; fill the viewport when fullscreen.
            isFullscreen ? 'min-h-0 flex-1' : 'max-h-[50vh]',
          )}
        />
      ) : (
        <div className="grid h-32 place-items-center text-xs text-white/60">
          Waiting for screen…
        </div>
      )}
    </div>
  );
}

function ParticipantAudioSink({ track }: { track: Track }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    el.play().catch(() => {});
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <audio ref={ref} autoPlay playsInline className="hidden" />;
}
