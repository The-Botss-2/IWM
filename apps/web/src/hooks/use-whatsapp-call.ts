'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { getApi } from '@/lib/api';
import { getChatSocket } from '@/lib/chat-socket';
import { toast, toastError, toastErrorMessage } from '@/lib/toast';

export type CallPhase =
  | 'idle'
  | 'outgoing'
  | 'incoming'
  | 'connecting'
  | 'connected';

interface IncomingCall {
  callId: string;
  roomId: string;
  callerId: string;
}

interface ActiveSession {
  callId: string;
  roomId: string;
  initiated: boolean;
  peerUserId: string | null;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

export function useWhatsAppCall(selfUserId: string) {
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [activeCallRoomId, setActiveCallRoomId] = useState<string | null>(null);
  const [activeCallPeerUserId, setActiveCallPeerUserId] = useState<string | null>(null);

  const sessionRef = useRef<ActiveSession | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  // Pre-allocated transceivers per media kind. We attach them up front so
  // the very first SDP exchange already carries both audio AND video
  // m-lines - even when the user hasn't turned the camera on yet. That way
  // toggling the camera mid-call is a `replaceTrack` (silent, no glare-
  // prone renegotiation) instead of an `addTrack` (which would need a
  // fresh offer/answer round trip - the bug behind "I only see my own
  // video"). Stored alongside the PC so teardown clears them too.
  const audioTransceiverRef = useRef<RTCRtpTransceiver | null>(null);
  const videoTransceiverRef = useRef<RTCRtpTransceiver | null>(null);
  // Re-entrancy lock for inbound-offer handling. Two offers processed
  // concurrently both pass the `signalingState === 'stable'` guard, then race
  // on setRemoteDescription/setLocalDescription - the second answer lands in
  // `stable` and throws "Called in wrong state".
  const handlingOfferRef = useRef(false);

  const stopLocal = useCallback(() => {
    const s = localStreamRef.current;
    if (s) for (const t of s.getTracks()) t.stop();
    localStreamRef.current = null;
  }, []);

  const teardown = useCallback(() => {
    const pc = pcRef.current;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        /* already closed - nothing to clean up */
      }
    }
    pcRef.current = null;
    audioTransceiverRef.current = null;
    videoTransceiverRef.current = null;
    handlingOfferRef.current = false;
    stopLocal();
    setRemoteStream(null);
    setMuted(false);
    setCameraOn(false);
    pendingIceRef.current = [];
    sessionRef.current = null;
    setActiveCallRoomId(null);
    setActiveCallPeerUserId(null);
    setPhase('idle');
  }, [stopLocal]);

  const buildPeer = useCallback(
    (remoteUserId: string) => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const session = sessionRef.current;
      pc.onicecandidate = (e) => {
        if (!e.candidate || !session) return;
        getChatSocket().emit('webrtc_ice_candidate', {
          callId: session.callId,
          toUserId: remoteUserId,
          candidate: e.candidate.toJSON(),
        });
      };
      // Build a *single* remote MediaStream on the receiver side. Some
      // browsers (notably Firefox) fire `ontrack` with `streams: []` for
      // m-lines we created from transceivers, so we can't rely on the
      // event's `streams[0]`. Adding tracks to one stable stream gives
      // the overlay a single ref to bind both audio and video to.
      const remoteMediaStream = new MediaStream();
      pc.ontrack = (e) => {
        if (!remoteMediaStream.getTracks().some((t) => t.id === e.track.id)) {
          remoteMediaStream.addTrack(e.track);
        }
        setRemoteStream(remoteMediaStream);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setPhase('connected');
        } else if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected'
        ) {
          // The actual call media runs over LiveKit now - this peer
          // connection is a signaling-era leftover whose stream is no longer
          // rendered anywhere. If its ICE fails (e.g. the public TURN relay is
          // flaky), that must NOT cancel the call: tearing down here flipped
          // `phase` to 'idle', which made <GlobalRealtime> disconnect LiveKit
          // *mid-connect* and surfaced as "could not establish pc connection"
          // / "client initiated disconnect". Log and leave the call alive -
          // real termination comes from call_end/reject + the safety timeouts.
          console.warn(
            '[call] p2p peer connection',
            pc.connectionState,
            '- ignoring (LiveKit carries call media)',
          );
        }
      };
      // Pre-create transceivers for both kinds in 'sendrecv' direction.
      // The audio transceiver carries the mic from the moment the call
      // connects; the video transceiver starts with a null track and only
      // gets a real track when the user toggles the camera on. Because the
      // m-line is already negotiated, the camera toggle is a no-op for SDP
      // and the peer sees video immediately via the established RTP flow.
      audioTransceiverRef.current = pc.addTransceiver('audio', {
        direction: 'sendrecv',
      });
      videoTransceiverRef.current = pc.addTransceiver('video', {
        direction: 'sendrecv',
      });
      pcRef.current = pc;
      return pc;
    },
    [],
  );

  const attachLocalTracks = useCallback(async (withVideo: boolean) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: withVideo,
    });
    localStreamRef.current = stream;
    setCameraOn(withVideo);
    const audioTrack = stream.getAudioTracks()[0] ?? null;
    const videoTrack = stream.getVideoTracks()[0] ?? null;
    if (audioTransceiverRef.current && audioTrack) {
      await audioTransceiverRef.current.sender.replaceTrack(audioTrack);
    }
    if (videoTransceiverRef.current && videoTrack) {
      await videoTransceiverRef.current.sender.replaceTrack(videoTrack);
    }
  }, []);

  const startOutgoingCall = useCallback(
    async (roomId: string, peerUserId?: string) => {
      if (sessionRef.current) return;
      sessionRef.current = {
        callId: 'pending',
        roomId,
        initiated: true,
        peerUserId: peerUserId ?? null,
      };
      setActiveCallRoomId(roomId);
      setActiveCallPeerUserId(peerUserId ?? null);
      setPhase('outgoing');

      const socket = getChatSocket();

      /**
       * Caller-cancelled-before-ack handler. If the user cancels the call
       * during the window between `call_initiate` going out and the server's
       * ack coming back, `endCall()` runs `teardown()` which nulls out
       * `sessionRef.current`. The server has already broadcast `call_incoming`
       * to the callee at that point, so they're ringing - but the caller's
       * `endCall()` had no callId to attach to its `call_end` emit, so the
       * server never tells the callee to stop. We close that race here: when
       * the ack finally arrives and we discover the session is already gone,
       * we emit `call_end` for the freshly-known callId immediately. The
       * server then broadcasts `call_ended` and the callee's ringer halts.
       */
      const handleAckedCallId = (callId: string): void => {
        if (sessionRef.current) {
          sessionRef.current.callId = callId;
        } else {
          try {
            socket.emit('call_end', { callId });
          } catch {
            /* socket might be down - the server's ring timeout will catch it */
          }
        }
      };

      const tryRest = async (reason: string) => {
        console.warn('[call] socket initiate failed, falling back to REST:', reason);
        try {
          const res = await getApi().chat.initiateCall(roomId);
          handleAckedCallId(res.call.id);
        } catch (restErr) {
          console.error('[call] REST initiate failed:', restErr);
          if (sessionRef.current) {
            toastError(restErr, "Couldn't start call");
            teardown();
          }
        }
      };

      if (!socket.connected) {
        await tryRest('socket disconnected');
        return;
      }

      socket
        .timeout(8_000)
        .emit(
          'call_initiate',
          { roomId },
          (err: Error | null, ack: { ok: boolean; callId: string } | undefined) => {
            if (err || !ack?.ok) {
              void tryRest(err?.message ?? 'no ack');
              return;
            }
            handleAckedCallId(ack.callId);
          },
        );
    },
    [teardown],
  );

  const acceptIncoming = useCallback(async () => {
    if (!incoming) return;
    sessionRef.current = {
      callId: incoming.callId,
      roomId: incoming.roomId,
      initiated: false,
      peerUserId: incoming.callerId,
    };
    setActiveCallRoomId(incoming.roomId);
    setActiveCallPeerUserId(incoming.callerId);
    setPhase('connecting');
    setIncoming(null);
    try {
      buildPeer(incoming.callerId);
      await attachLocalTracks(false);
      getChatSocket().emit('call_accept', { callId: incoming.callId });
    } catch (err) {
      console.error(err);
      toastError(err, "Couldn't use the microphone");
      teardown();
    }
  }, [attachLocalTracks, buildPeer, incoming, teardown]);

  const declineIncoming = useCallback(() => {
    if (!incoming) return;
    getChatSocket().emit('call_reject', { callId: incoming.callId });
    setIncoming(null);
    // Always tear down so the ringtone halts and `callPhase` returns to
    // 'idle' even if the server's `call_rejected` echo is delayed or lost.
    teardown();
  }, [incoming, teardown]);

  const endCall = useCallback(() => {
    const session = sessionRef.current;
    if (session && session.callId !== 'pending') {
      getChatSocket().emit('call_end', { callId: session.callId });
    }
    teardown();
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    for (const t of stream.getAudioTracks()) t.enabled = !next;
    setMuted(next);
  }, [muted]);

  const toggleCamera = useCallback(async () => {
    const stream = localStreamRef.current;
    const transceiver = videoTransceiverRef.current;
    if (!stream || !transceiver) return;
    const existingVideo = stream.getVideoTracks()[0];
    if (existingVideo) {
      // Camera was on - detach the track from the sender so the peer
      // stops receiving frames, then stop the local track to release the
      // hardware. The video m-line stays in the SDP so turning the camera
      // back on later is again a `replaceTrack` with no renegotiation.
      await transceiver.sender.replaceTrack(null);
      existingVideo.stop();
      stream.removeTrack(existingVideo);
      setCameraOn(false);
      return;
    }
    try {
      const vid = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = vid.getVideoTracks()[0];
      if (!track) return;
      stream.addTrack(track);
      await transceiver.sender.replaceTrack(track);
      setCameraOn(true);
    } catch (err) {
      console.error(err);
      toastError(err, "Couldn't use the camera");
    }
  }, []);

  useEffect(() => {
    if (!selfUserId) return;
    const socket = getChatSocket();

    const onIncoming = (payload: IncomingCall) => {
      if (sessionRef.current) return;
      setIncoming(payload);
      setPhase('incoming');
    };

    const onRinging = () => {
      if (phase === 'outgoing') setPhase('outgoing');
    };

    const onAccepted = async (payload: {
      callId: string;
      roomId: string;
      byUserId: string;
    }) => {
      const session = sessionRef.current;
      if (!session || !session.initiated) return;
      // Ignore a duplicate `call_accepted`. Building a second peer here would
      // emit a second offer, and the callee processing two offers corrupts its
      // signaling state ("Called in wrong state: stable" on setLocalDescription).
      // Test via a boolean local so the guard doesn't permanently narrow the
      // ref to null (buildPeer repopulates pcRef.current below).
      const alreadyNegotiating = pcRef.current != null;
      if (alreadyNegotiating) return;
      session.callId = payload.callId;
      session.peerUserId = payload.byUserId;
      setPhase('connecting');
      try {
        buildPeer(payload.byUserId);
        await attachLocalTracks(false);
        const pc = pcRef.current;
        if (!pc) return;
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        await pc.setLocalDescription(offer);
        getChatSocket().emit('webrtc_offer', {
          callId: payload.callId,
          toUserId: payload.byUserId,
          description: { type: offer.type, sdp: offer.sdp ?? '' },
        });
      } catch (err) {
        console.error(err);
        toastError(err, "Couldn't use the microphone");
        teardown();
      }
    };

    const onRejected = () => {
      toastErrorMessage("Call declined", { description: "The other person declined the call." });
      teardown();
    };

    const onEnded = () => {
      teardown();
    };

    const onOffer = async (payload: {
      callId: string;
      fromUserId: string;
      description: RTCSessionDescriptionInit;
    }) => {
      const pc = pcRef.current;
      if (!pc) return;
      // Skip duplicate offers. A retransmitted `webrtc_offer` after we've
      // already moved past `stable`/`have-remote-offer` would throw
      // "Called in wrong state". Only `stable` or `have-local-offer`
      // (glare resolution) are valid starting states for an inbound offer.
      // Read into a local so we don't narrow `pc.signalingState` itself - the
      // awaits below mutate it and the post-await recheck needs the wide type.
      const entryState = pc.signalingState;
      if (entryState !== 'stable' && entryState !== 'have-local-offer') {
        return;
      }
      // Serialize: a second offer must not interleave with this one's awaits.
      if (handlingOfferRef.current) return;
      handlingOfferRef.current = true;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.description));
        for (const c of pendingIceRef.current) {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        }
        pendingIceRef.current = [];
        const answer = await pc.createAnswer();
        // signalingState can drift across the awaits above (teardown, a glare
        // rollback, a duplicate that slipped through). Only set the local
        // answer while we're genuinely the answerer, else setLocalDescription
        // throws "Called in wrong state: stable".
        if (pc.signalingState !== 'have-remote-offer') return;
        await pc.setLocalDescription(answer);
        getChatSocket().emit('webrtc_answer', {
          callId: payload.callId,
          toUserId: payload.fromUserId,
          description: { type: answer.type, sdp: answer.sdp ?? '' },
        });
      } catch {
        // LiveKit carries the call media and reports
        // its own connect failures (use-livekit-room). This peer connection
        // is a signaling-era leftover (see onconnectionstatechange above):
        // glare / wrong-state races here are harmless during a working call,
        // so they are neither toasted nor logged.
      } finally {
        handlingOfferRef.current = false;
      }
    };

    const onAnswer = async (payload: {
      callId: string;
      description: RTCSessionDescriptionInit;
    }) => {
      const pc = pcRef.current;
      if (!pc) return;
      // Answer is only valid while we're in `have-local-offer`. If we've
      // already settled (`stable`) - typical when the peer retransmits
      // its answer after a brief socket reconnect - there's nothing to
      // apply. Calling `setRemoteDescription` in `stable` throws the
      // "Called in wrong state" InvalidStateError the user reported.
      if (pc.signalingState !== 'have-local-offer') {
        return;
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.description));
        for (const c of pendingIceRef.current) {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        }
        pendingIceRef.current = [];
      } catch {
        // Same as onOffer: the legacy peer connection's failures don't affect
        // the LiveKit call, which reports its own.
      }
    };

    const onIce = async (payload: { candidate: RTCIceCandidateInit }) => {
      const pc = pcRef.current;
      if (!pc || !pc.remoteDescription) {
        pendingIceRef.current.push(payload.candidate);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch {
        // A stray candidate that doesn't apply (late, duplicate, other
        // network) is normal, and this legacy peer connection doesn't carry
        // the call media anyway - nothing to report.
      }
    };

    socket.on('call_incoming', onIncoming);
    socket.on('call_ringing', onRinging);
    socket.on('call_accepted', onAccepted);
    socket.on('call_rejected', onRejected);
    socket.on('call_ended', onEnded);
    socket.on('webrtc_offer', onOffer);
    socket.on('webrtc_answer', onAnswer);
    socket.on('webrtc_ice_candidate', onIce);

    return () => {
      socket.off('call_incoming', onIncoming);
      socket.off('call_ringing', onRinging);
      socket.off('call_accepted', onAccepted);
      socket.off('call_rejected', onRejected);
      socket.off('call_ended', onEnded);
      socket.off('webrtc_offer', onOffer);
      socket.off('webrtc_answer', onAnswer);
      socket.off('webrtc_ice_candidate', onIce);
    };
  }, [attachLocalTracks, buildPeer, phase, selfUserId, teardown]);

  /**
   * Safety-net timeouts. The server should send `call_ended` / `call_rejected`
   * on any terminal state, but a flaky network, a crashed peer tab, or a
   * caller who never explicitly cancels can leave the receiver stuck in
   * 'incoming' (ringing forever) or the caller stuck in 'outgoing'. These
   * timers force a clean teardown after a sane wait - about the length of
   * a typical WhatsApp ring before "no answer".
   */
  const RING_TIMEOUT_MS = 45_000;
  const OUTGOING_TIMEOUT_MS = 60_000;
  useEffect(() => {
    if (phase === 'incoming') {
      const t = setTimeout(() => {
        // Auto-decline and tear down. This also stops the ringtone via
        // useChatNotifyingEffects watching `callPhase`.
        if (incoming) {
          try {
            getChatSocket().emit('call_reject', { callId: incoming.callId });
          } catch {
            /* socket might be down - fall through to teardown */
          }
          setIncoming(null);
        }
        teardown();
        toastErrorMessage("Missed call", { description: "You did not answer in time." });
      }, RING_TIMEOUT_MS);
      return () => clearTimeout(t);
    }
    if (phase === 'outgoing') {
      const t = setTimeout(() => {
        const session = sessionRef.current;
        if (session && session.callId !== 'pending') {
          try {
            getChatSocket().emit('call_end', { callId: session.callId });
          } catch {
            /* fall through to teardown */
          }
        }
        teardown();
        toastErrorMessage("No answer", { description: "The other person did not pick up." });
      }, OUTGOING_TIMEOUT_MS);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [incoming, phase, teardown]);

  return {
    phase,
    incoming,
    muted,
    cameraOn,
    remoteStream,
    localStream: localStreamRef.current,
    activeCallRoomId,
    activeCallPeerUserId,
    startOutgoingCall,
    acceptIncoming,
    declineIncoming,
    endCall,
    toggleMute,
    toggleCamera,
  };
}
