'use client';

/**
 * Chat audio cues.
 *
 * Two playback modes, in priority order:
 *
 * 1. **File-backed** - drop an audio file at one of the paths in `AUDIO_PATHS`
 *    (relative to `apps/web/public/`) and it will be served at the matching
 *    `/sounds/...` URL. MP3, WAV, OGG all work; MP3 has the widest browser
 *    support. Recommended sizes: ringtone 2–4 s loopable, message blip <300 ms.
 *
 *    Paths:
 *      • Incoming ringtone - `apps/web/public/sounds/ringtone.mp3`
 *      • New-message blip  - `apps/web/public/sounds/message-blip.mp3`
 *
 * 2. **Synthesized fallback** - if the file is missing, 404s, fails to decode,
 *    or is blocked by autoplay policy, the original Web Audio sine-wave
 *    beeps still play so the user doesn't get silence. This is intentional:
 *    a missing asset shouldn't disable notification sounds in production.
 */
const AUDIO_PATHS = {
  ringtone: '/sounds/ringtone.mp3',
  messageBlip: '/sounds/message-blip.mp3',
} as const;

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/**
 * Best-effort file playback. Returns a promise that resolves `true` when the
 * `<audio>` element successfully starts playing, `false` if it errors out or
 * doesn't start within 1.2 s. The audio element is returned unconditionally
 * so the caller can `.pause()` / clean it up; on failure the element is
 * already detached.
 */
function tryFilePlayback(
  src: string,
  volume: number,
  loop: boolean,
): { audio: HTMLAudioElement; started: Promise<boolean> } {
  const audio = new Audio(src);
  audio.loop = loop;
  audio.volume = Math.max(0, Math.min(1, volume));
  // `preload='auto'` triggers a Range request the moment the element is
  // created; Chrome logs `ERR_CACHE_OPERATION_NOT_SUPPORTED` because the
  // browser cache can't satisfy partial-content reads for some MP3
  // responses. `'metadata'` defers the byte fetch until play() and skips
  // the noisy warning without changing user-visible behaviour.
  audio.preload = 'metadata';
  const started = new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    audio.addEventListener('playing', () => finish(true), { once: true });
    audio.addEventListener('error', () => finish(false), { once: true });
    audio.play().catch(() => finish(false));
    // Safety net: if neither event fires (e.g. silent autoplay block on some
    // mobile browsers) treat it as a failure so the synthesized fallback
    // kicks in instead of leaving the user without audio.
    setTimeout(() => finish(false), 1_200);
  });
  return { audio, started };
}

function playMessageBlipSynth(volume: number): void {
  const ac = getCtx();
  if (!ac) return;
  try {
    if (ac.state === 'suspended') void ac.resume();
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.linearRampToValueAtTime(1320, now + 0.06);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume * 0.5, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.24);
  } catch {
  }
}

let activeBlipAudio: HTMLAudioElement | null = null;
let activeRingtoneAudio: HTMLAudioElement | null = null;
let activeRingtoneStopSynth: (() => void) | null = null;

function stopAllPreviews(): void {
  if (activeBlipAudio) {
    try {
      activeBlipAudio.pause();
      activeBlipAudio.currentTime = 0;
    } catch {
      /* ignore */
    }
    activeBlipAudio = null;
  }
  if (activeRingtoneAudio) {
    try {
      activeRingtoneAudio.pause();
      activeRingtoneAudio.currentTime = 0;
    } catch {
      /* ignore */
    }
    activeRingtoneAudio = null;
  }
  if (activeRingtoneStopSynth) {
    try {
      activeRingtoneStopSynth();
    } catch {
      /* ignore */
    }
    activeRingtoneStopSynth = null;
  }
}

export function playMessageBlip(volume = 0.6): void {
  if (typeof window === 'undefined') return;
  stopAllPreviews();
  try {
    const { audio, started } = tryFilePlayback(AUDIO_PATHS.messageBlip, volume, false);
    activeBlipAudio = audio;
    void started.then((ok) => {
      if (!ok) {
        try {
          audio.pause();
        } catch {
          /* ignore */
        }
        if (activeBlipAudio === audio) {
          activeBlipAudio = null;
        }
        playMessageBlipSynth(volume);
      }
    });
    audio.addEventListener('ended', () => {
      if (activeBlipAudio === audio) {
        activeBlipAudio = null;
      }
    });
  } catch {
    playMessageBlipSynth(volume);
  }
}

/** Synthesized one-shot used by the fallback ring loop. */
function playRingtoneOnceSynth(volume = 0.6): () => void {
  const ac = getCtx();
  if (!ac) return () => undefined;
  const now = ac.currentTime;
  const stops: (() => void)[] = [];
  try {
    if (ac.state === 'suspended') void ac.resume();
    const buildBeep = (offset: number) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now + offset);
      osc.frequency.linearRampToValueAtTime(660, now + offset + 0.18);
      osc.frequency.linearRampToValueAtTime(440, now + offset + 0.36);
      gain.gain.setValueAtTime(0, now + offset);
      gain.gain.linearRampToValueAtTime(volume, now + offset + 0.04);
      gain.gain.setValueAtTime(volume, now + offset + 0.36);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.5);
      osc.connect(gain).connect(ac.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.52);
      stops.push(() => {
        try {
          osc.stop();
        } catch {
        }
      });
    };
    buildBeep(0);
    buildBeep(0.55);
  } catch {
  }
  return () => {
    for (const s of stops) s();
  };
}

/**
 * Plays the ringtone once (best-effort file playback, falling back to synthesis).
 * Returns a cancel/cleanup callback.
 */
export function playRingtoneOnce(volume = 0.6): () => void {
  if (typeof window === 'undefined') return () => undefined;
  stopAllPreviews();
  let audio: HTMLAudioElement | null = null;
  let stopped = false;
  let stopSynth: (() => void) | null = null;

  try {
    const { audio: playAudio, started } = tryFilePlayback(AUDIO_PATHS.ringtone, volume, false);
    audio = playAudio;
    activeRingtoneAudio = playAudio;
    void started.then((ok) => {
      if (stopped) {
        try {
          playAudio.pause();
        } catch {
          /* ignore */
        }
        return;
      }
      if (!ok) {
        try {
          playAudio.pause();
        } catch {
          /* ignore */
        }
        if (activeRingtoneAudio === playAudio) {
          activeRingtoneAudio = null;
        }
        stopSynth = playRingtoneOnceSynth(volume);
        activeRingtoneStopSynth = stopSynth;
      }
    });
    playAudio.addEventListener('ended', () => {
      if (activeRingtoneAudio === playAudio) {
        activeRingtoneAudio = null;
      }
    });
  } catch {
    stopSynth = playRingtoneOnceSynth(volume);
    activeRingtoneStopSynth = stopSynth;
  }

  return () => {
    stopped = true;
    if (audio) {
      try {
        audio.pause();
      } catch {
        /* ignore */
      }
      if (activeRingtoneAudio === audio) {
        activeRingtoneAudio = null;
      }
    }
    if (stopSynth) {
      stopSynth();
      if (activeRingtoneStopSynth === stopSynth) {
        activeRingtoneStopSynth = null;
      }
    }
  };
}

/**
 * Incoming-call ringer. Plays `/sounds/ringtone.mp3` on loop when available,
 * otherwise falls back to a synthesized two-beep loop. The audio element /
 * fallback interval is held on the instance so `stop()` halts both cases.
 *
 * The class is stateful by design - `useChatNotifyingEffects` keeps a single
 * `RingLoop` per incoming call and cleans it up in the `useEffect` return.
 */
export class RingLoop {
  private audio: HTMLAudioElement | null = null;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  /** Bumped each `start()` so a delayed file-playback resolution from a
   *  previous attempt can't override a freshly started loop. */
  private generation = 0;

  start(volume: number): void {
    this.stop();
    if (typeof window === 'undefined') return;
    const gen = ++this.generation;
    try {
      const { audio, started } = tryFilePlayback(
        AUDIO_PATHS.ringtone,
        volume,
        true,
      );
      this.audio = audio;
      void started.then((ok) => {
        if (gen !== this.generation) {
          // A newer start() or stop() superseded this attempt. Tear down the
          // orphaned element so it doesn't keep playing in the background.
          try {
            audio.pause();
          } catch {
            /* ignore */
          }
          return;
        }
        if (!ok) {
          // File failed - drop the dead audio element and run the
          // synthesized loop. We do NOT call this.stop() here because
          // that would clobber the freshly-bumped generation.
          try {
            audio.pause();
          } catch {
            /* ignore */
          }
          this.audio = null;
          this.startSynthLoop(volume);
        }
      });
    } catch {
      this.audio = null;
      this.startSynthLoop(volume);
    }
  }

  private startSynthLoop(volume: number): void {
    playRingtoneOnceSynth(volume);
    this.fallbackTimer = setInterval(() => playRingtoneOnceSynth(volume), 1_500);
  }

  stop(): void {
    // Invalidate any in-flight `started` promise from a previous start().
    this.generation++;
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.currentTime = 0;
      } catch {
        /* ignore */
      }
      this.audio = null;
    }
  }
}
