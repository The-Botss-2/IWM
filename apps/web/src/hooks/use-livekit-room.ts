'use client';

import {
  ConnectionError,
  ConnectionErrorReason,
  ConnectionState,
  DisconnectReason,
  type LocalParticipant,
  Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  type TrackPublication,
} from 'livekit-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getApi } from '@/lib/api';
import {
  DEFAULT_SCREEN_SHARE_QUALITY,
  SCREEN_SHARE_QUALITY_PROFILES,
  type ScreenShareQuality,
} from '@/lib/screen-share-quality';
import { describeError, toast, toastErrorMessage, toastError } from '@/lib/toast';

export interface LivekitParticipantView {
  /** LiveKit identity - matches the CRM user id minted into the token. */
  identity: string;
  /** Display name on the token; falls back to identity. */
  name: string;
  /** Remote audio track, if the participant is publishing audio. Always null
   *  for the local participant (playing our own mic back would echo). */
  audioTrack: Track | null;
  /** Camera track, if the participant has their camera on. Exposed for the
   *  local participant too so their self-preview is the very track LiveKit
   *  publishes (no separate camera acquisition). */
  videoTrack: Track | null;
  /** Screen-share track, if the participant is presenting. Exposed for the
   *  local participant too so they can see their own shared screen. */
  screenTrack: Track | null;
  /** True when the audio publication is muted by the participant. */
  audioMuted: boolean;
  /** True when the video publication is muted. */
  videoMuted: boolean;
  /** True when this participant currently has a live screen-share. */
  screenSharing: boolean;
  /** True when the participant is actively speaking (LiveKit's VAD). */
  isSpeaking: boolean;
  /** Convenience flag - true for the local participant. */
  isLocal: boolean;
}

export type LivekitPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

interface ConnectOptions {
  /** Whether to enable the camera on join. Mic is always enabled (you join
   *  with audio; toggling it off is a one-button affair). */
  withVideo?: boolean;
}

/**
 * LiveKit room driver. Exposes a stable handle the call overlay binds to:
 *
 *   const lk = useLivekitRoom();
 *   await lk.connect({ kind: 'chat-room', roomId, withVideo: true });
 *   // lk.participants is N entries (local + remote). lk.disconnect() ends.
 *
 * We don't pool the `Room` - each connect() builds a fresh instance and
 * disposes it on disconnect(). LiveKit's `Room` keeps an internal WS, and
 * leaving one room while another is connecting causes glare; one-room-
 * at-a-time is simpler and matches the call lifecycle.
 */
export function useLivekitRoom() {
  const roomRef = useRef<Room | null>(null);
  const unmountedRef = useRef(false);
  const [phase, setPhase] = useState<LivekitPhase>('idle');
  const [participants, setParticipants] = useState<LivekitParticipantView[]>([]);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [screenShareEnabled, setScreenShareEnabled] = useState(false);
  const [screenShareQuality, setScreenShareQualityState] = useState<ScreenShareQuality>(
    DEFAULT_SCREEN_SHARE_QUALITY,
  );
  const [roomName, setRoomName] = useState<string | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);

  // Snapshot participants + their track refs whenever LiveKit fires any
  // event that could change the view. The snapshot is the source of truth
  // the call overlay binds to - bypassing it would make us juggle 6+
  // individual event types in the UI.
  const refresh = useCallback(() => {
    const room = roomRef.current;
    if (!room) {
      setParticipants([]);
      return;
    }
    const all: Participant[] = [
      room.localParticipant,
      ...Array.from(room.remoteParticipants.values()),
    ];
    setParticipants(
      all.map((p) => {
        const audioPub = p.getTrackPublication(Track.Source.Microphone);
        const videoPub = p.getTrackPublication(Track.Source.Camera);
        const screenPub = p.getTrackPublication(Track.Source.ScreenShare);
        const localFlag = p === room.localParticipant;
        return {
          identity: p.identity,
          name: p.name || p.identity,
          // Local audio stays null - we never play our own mic back. Video and
          // screen tracks are exposed for local + remote so the user sees their
          // own camera/screen from the same track everyone else does.
          audioTrack: !localFlag ? (audioPub?.track ?? null) : null,
          videoTrack: videoPub?.track ?? null,
          screenTrack: screenPub?.track ?? null,
          audioMuted: audioPub?.isMuted ?? true,
          videoMuted: videoPub?.isMuted ?? !videoPub,
          screenSharing: screenPub != null && !screenPub.isMuted,
          isSpeaking: p.isSpeaking,
          isLocal: localFlag,
        };
      }),
    );
    // Keep the local screen-share flag in sync with what LiveKit actually
    // reports, so the UI button doesn't get stuck "on" if the OS-level
    // share-picker was cancelled or the share track was removed externally.
    const localScreenPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    setScreenShareEnabled(localScreenPub != null && !localScreenPub.isMuted);
  }, []);

  const teardown = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    setPhase('idle');
    setParticipants([]);
    setRoomName(null);
    setActiveRoomId(null);
    setMicEnabled(true);
    setCameraEnabled(false);
    if (room) {
      try {
        await room.disconnect();
      } catch {
        // disconnect throws if the room is already detached - fine.
      }
    }
  }, []);

  const connect = useCallback(
    async (input: { kind: 'chat-room' | 'voice-channel'; roomId: string; withVideo?: boolean }) => {
      if (roomRef.current) {
        // Already in a room - disconnect first so we don't stack sessions
        // and end up with two media engines competing for the mic.
        await teardown();
      }
      setPhase('connecting');
      setActiveRoomId(input.roomId);
      try {
        const tokenRes = await getApi().livekit.token({
          kind: input.kind,
          roomId: input.roomId,
          withVideo: !!input.withVideo,
        });
        // The owning component unmounted while the token was in flight (the
        // call ended before LiveKit joined). Don't open a room nobody will
        // ever tear down.
        if (unmountedRef.current) return;
        const room = new Room({
          // Adaptive streams downsize subscribed video when offscreen - saves
          // bandwidth in larger group calls without code changes per surface.
          adaptiveStream: true,
          // Dynacast halts publishing tracks that nobody is currently
          // subscribed to (e.g. a participant in a tab nobody is watching).
          dynacast: true,
        });
        roomRef.current = room;

        room
          .on(RoomEvent.ParticipantConnected, refresh)
          .on(RoomEvent.ParticipantDisconnected, refresh)
          .on(RoomEvent.TrackSubscribed, (_track: RemoteTrack, _pub: RemoteTrackPublication) =>
            refresh(),
          )
          .on(RoomEvent.TrackUnsubscribed, () => refresh())
          .on(RoomEvent.TrackMuted, (_pub: TrackPublication) => refresh())
          .on(RoomEvent.TrackUnmuted, (_pub: TrackPublication) => refresh())
          .on(RoomEvent.LocalTrackPublished, () => refresh())
          .on(RoomEvent.LocalTrackUnpublished, () => refresh())
          .on(RoomEvent.ActiveSpeakersChanged, () => refresh())
          .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
            // Map every LiveKit state to our four-phase enum so the
            // overlay always reflects what's actually happening. The
            // previous version silently dropped Failed and SignalReconnecting
            // which left the UI stuck at "connecting" while the
            // underlying socket was already dead - the "could not
            // establish PC connection" report.
            if (state === ConnectionState.Connected) setPhase('connected');
            else if (
              state === ConnectionState.Reconnecting ||
              state === ConnectionState.SignalReconnecting
            )
              setPhase('reconnecting');
            else if (state === ConnectionState.Connecting) setPhase('connecting');
            else if (state === ConnectionState.Disconnected) {
              setPhase('idle');
            }
            refresh();
          })
          .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
            // A network-driven disconnect surfaces as DUPLICATE_IDENTITY or
            // SIGNAL_CLOSE here; the user-driven one (we called disconnect)
            // is CLIENT_INITIATED. Only show a toast in the unexpected
            // cases - quitting normally shouldn't yell at the user.
            if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED) {
              toastErrorMessage('Call disconnected', {
                description: 'The connection to the call was lost. Check your network and rejoin.',
              });
            }
            void teardown();
          })
          .on(RoomEvent.MediaDevicesError, (err: Error) => {
            console.error('[livekit] media device error:', err);
            toastError(err, 'Microphone or camera unavailable');
          })
          .on(RoomEvent.SignalConnected, () => refresh());

        // Wrap connect in a watchdog so we never hang in "connecting"
        // forever when ICE never completes - a common cause of the
        // "could not establish connection" report. After 20s of no
        // 'connected' transition we tear down and surface a clear toast.
        const connectPromise = room.connect(tokenRes.url, tokenRes.token, {
          autoSubscribe: true,
        });
        const watchdog = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Connection timed out.')), 20_000);
        });
        await Promise.race([connectPromise, watchdog]);
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicEnabled(true);
        if (input.withVideo) {
          try {
            await room.localParticipant.setCameraEnabled(true);
            setCameraEnabled(true);
          } catch (camErr) {
            // Camera failure shouldn't tank the audio call - log and
            // continue. The user can re-toggle the camera once they
            // grant permission.
            console.warn('[livekit] camera unavailable on join:', camErr);
            toastErrorMessage("Couldn't turn on the camera", {
              description: `${describeError(camErr, 'The camera could not be opened.')} You joined with audio only.`,
            });
          }
        }
        setRoomName(tokenRes.roomName);
        setPhase('connected');
        refresh();
      } catch (err) {
        // A teardown (the call ended or was superseded) while we're still
        // connecting cancels the in-flight connect with a client-initiated
        // ConnectionError. That's expected - clean up quietly without an error
        // toast or the 'error' phase.
        if (isBenignCancellation(err)) {
          await teardown();
          return;
        }
        console.error('[livekit] connect failed:', err);
        toastErrorMessage("Couldn't join the call", { description: friendlyConnectError(err) });
        await teardown();
        setPhase('error');
      }
    },
    [refresh, teardown],
  );

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !micEnabled;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicEnabled(next);
      refresh();
    } catch (err) {
      console.error('[livekit] mic toggle failed:', err);
      toastError(err, "Couldn't use the microphone");
    }
  }, [micEnabled, refresh]);

  const toggleCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !cameraEnabled;
    try {
      await room.localParticipant.setCameraEnabled(next);
      setCameraEnabled(next);
      refresh();
    } catch (err) {
      console.error('[livekit] camera toggle failed:', err);
      toastError(err, "Couldn't use the camera");
    }
  }, [cameraEnabled, refresh]);

  const toggleScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !screenShareEnabled;
    try {
      // setScreenShareEnabled(true) triggers the browser's display-picker.
      // If the user cancels we hit a `NotAllowedError` here - swallow it
      // silently rather than toast, since cancelling the picker is a
      // legitimate user action. The selected quality profile drives the
      // capture resolution/fps and the publish encoding.
      if (next) {
        const profile = SCREEN_SHARE_QUALITY_PROFILES[screenShareQuality];
        await room.localParticipant.setScreenShareEnabled(true, profile.capture, profile.publish);
      } else {
        await room.localParticipant.setScreenShareEnabled(false);
      }
      setScreenShareEnabled(next);
      refresh();
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'NotAllowedError' || name === 'AbortError') {
        // User dismissed the share picker - no-op.
        return;
      }
      console.error('[livekit] screen-share toggle failed:', err);
      toastError(err, "Couldn't start screen share");
    }
  }, [screenShareEnabled, screenShareQuality, refresh]);

  /**
   * Change the screen-share quality profile. If a share is already live we
   * restart the track so the new resolution/encoding takes effect - capture
   * constraints can't be changed on a running getDisplayMedia track, so this
   * re-opens the OS picker. When idle it just records the choice for the next
   * share.
   */
  const setScreenShareQuality = useCallback(
    async (quality: ScreenShareQuality) => {
      setScreenShareQualityState(quality);
      const room = roomRef.current;
      if (!room || !screenShareEnabled) return;
      const profile = SCREEN_SHARE_QUALITY_PROFILES[quality];
      try {
        await room.localParticipant.setScreenShareEnabled(false);
        await room.localParticipant.setScreenShareEnabled(true, profile.capture, profile.publish);
        setScreenShareEnabled(true);
        refresh();
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === 'NotAllowedError' || name === 'AbortError') {
          // User cancelled the re-share picker - we already stopped the old
          // track, so reflect that we're no longer sharing.
          setScreenShareEnabled(false);
          refresh();
          return;
        }
        console.error('[livekit] screen-share quality change failed:', err);
        toastErrorMessage("Couldn't change screen share quality", {
          description: `${describeError(err, 'The screen share could not restart.')} Stop sharing and start again.`,
        });
      }
    },
    [screenShareEnabled, refresh],
  );

  const disconnect = useCallback(async () => {
    await teardown();
  }, [teardown]);

  // Cleanup on unmount: leave the room cleanly so the LiveKit server can
  // free the participant slot instead of waiting for the WS heartbeat to
  // expire.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      const room = roomRef.current;
      roomRef.current = null;
      if (room) {
        room.disconnect().catch(() => {});
      }
    };
  }, []);

  // Expose the local participant separately so the overlay can bind a
  // <Track> ref to it without iterating the participants array.
  const localParticipant = useMemo<LocalParticipant | null>(() => {
    const room = roomRef.current;
    return room?.localParticipant ?? null;
  }, [participants]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    phase,
    participants,
    micEnabled,
    cameraEnabled,
    screenShareEnabled,
    screenShareQuality,
    roomName,
    activeRoomId,
    localParticipant,
    connect,
    disconnect,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    setScreenShareQuality,
  };
}

/**
 * True when a connect() rejection is just us cancelling an in-flight
 * connection (the call ended or was superseded mid-connect). LiveKit raises a
 * `ConnectionError` with reason `Cancelled` and message "Client initiated
 * disconnect" in that case - not a real failure, so we swallow it instead of
 * toasting "Couldn't connect."
 */
function isBenignCancellation(err: unknown): boolean {
  if (err instanceof ConnectionError && err.reason === ConnectionErrorReason.Cancelled) {
    return true;
  }
  const msg = (err as { message?: string })?.message ?? '';
  return /client initiated disconnect/i.test(msg);
}

/**
 * Map LiveKit / browser errors to a user-readable string. The default
 * `describeError` happily prints "API error from /livekit/token" or
 * "PeerConnection failed" - both of which leak implementation detail. We
 * route every connect failure through this helper so toasts read like
 * "Couldn't connect." instead.
 */
function friendlyConnectError(err: unknown): string {
  const msg = (err as { message?: string })?.message ?? '';
  if (/timeout|timed out/i.test(msg)) {
    return 'The connection timed out. Check your network and try again.';
  }
  if (/permission|denied/i.test(msg)) {
    return 'Microphone or camera access was denied. Allow it in your browser settings.';
  }
  if (/ice|peer/i.test(msg)) {
    return 'A media connection could not be established. Try again.';
  }
  if (/token/i.test(msg)) {
    return 'The room did not accept your access token. Try again.';
  }
  return 'Something unexpected happened. Try again.';
}
