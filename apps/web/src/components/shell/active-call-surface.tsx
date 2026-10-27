'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { ChatRoomSummary } from '@botss/shared-types';

import { useCall } from '@/components/chat/call-context';
import { LivekitCallOverlay } from '@/components/chat/livekit-call-overlay';
import { useLivekitRoom } from '@/hooks/use-livekit-room';
import { roomTitle } from '@/lib/chat-room-label';

interface ActiveCallSurfaceProps {
  rooms: ChatRoomSummary[];
  userId: string;
  /** Online user ids - drives the "Ringing…" vs "peer offline" pill. */
  presenceSet: ReadonlySet<string>;
}

/**
 * The LiveKit media session + full-screen call overlay. Split out of
 * `<GlobalRealtime />` and loaded with `next/dynamic` so `livekit-client`
 * (and the overlay) only download once a call actually starts, instead of
 * shipping in every authenticated page's first-load bundle.
 *
 * Mounted by GlobalRealtime only while the call phase is `outgoing`,
 * `connecting` or `connected`. When the call ends the phase returns to
 * `idle`, this component unmounts, and `useLivekitRoom`'s unmount cleanup
 * leaves the room.
 */
export default function ActiveCallSurface({ rooms, userId, presenceSet }: ActiveCallSurfaceProps) {
  const call = useCall();
  const lk = useLivekitRoom();
  const lastConnectedRoomIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (call.phase === 'connecting' || call.phase === 'connected') {
      const roomId = call.activeCallRoomId;
      if (roomId && lastConnectedRoomIdRef.current !== roomId && lk.phase === 'idle') {
        lastConnectedRoomIdRef.current = roomId;
        void lk.connect({ kind: 'chat-room', roomId, withVideo: false });
      }
    } else if (call.phase === 'idle' && lastConnectedRoomIdRef.current) {
      lastConnectedRoomIdRef.current = null;
      if (lk.phase !== 'idle') void lk.disconnect();
    }
  }, [call.phase, call.activeCallRoomId, lk]);

  const activeRoom = useMemo(() => {
    const id = call.activeCallRoomId ?? null;
    if (!id) return null;
    return rooms.find((r) => r.id === id) ?? null;
  }, [call.activeCallRoomId, rooms]);

  const activePeerName = useMemo(() => {
    if (!activeRoom) return '';
    if (activeRoom.type === 'DM') {
      const peerId = call.activeCallPeerUserId ?? null;
      const peer = peerId
        ? activeRoom.participants.find((p) => p.userId === peerId)
        : activeRoom.participants.find((p) => p.userId !== userId);
      return peer?.user.name ?? peer?.user.email ?? roomTitle(activeRoom, userId);
    }
    return roomTitle(activeRoom, userId);
  }, [activeRoom, call.activeCallPeerUserId, userId]);

  // Presence-aware outgoing label. If the peer isn't currently online
  // (i.e. no CRM tab open / on a flaky connection) we show "Unreachable"
  // instead of "Calling…" so the caller knows to fall back to phone.
  const peerOnline = useMemo(() => {
    if (!call.activeCallPeerUserId) return true;
    return presenceSet.has(call.activeCallPeerUserId);
  }, [call.activeCallPeerUserId, presenceSet]);

  return (
    <LivekitCallOverlay
      phase={
        lk.phase === 'connected' || lk.phase === 'reconnecting' || lk.phase === 'error'
          ? lk.phase
          : 'connecting'
      }
      participants={lk.participants}
      micEnabled={lk.micEnabled}
      cameraEnabled={lk.cameraEnabled}
      screenShareEnabled={lk.screenShareEnabled}
      screenShareQuality={lk.screenShareQuality}
      onToggleMic={lk.toggleMic}
      onToggleCamera={lk.toggleCamera}
      onToggleScreenShare={lk.toggleScreenShare}
      onChangeScreenShareQuality={lk.setScreenShareQuality}
      onEnd={() => {
        call.endCall();
        void lk.disconnect();
      }}
      title={activePeerName || 'Call'}
      // Status pill differentiates the pre-answer state so the caller
      // can read at a glance whether the peer is being notified or
      // simply unreachable. LiveKit's own "Connecting…" only kicks in
      // once both sides have signalled - until then we override.
      statusOverride={
        call.phase === 'outgoing' && lk.phase !== 'connected'
          ? peerOnline
            ? 'Ringing…'
            : 'Calling… (peer offline)'
          : undefined
      }
    />
  );
}
