'use client';

import { Eraser } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type SignaturePadType from 'signature_pad';
import { SIGNATURE_CONSENT_TEXT, type SignatureMethod } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  TYPED_SIGNATURE_FONT,
  trimmedCanvasPng,
  typedSignaturePng,
} from '@/lib/signatures/signature-image';
import { cn } from '@/lib/utils';

export interface AdoptedSignature {
  method: SignatureMethod;
  imageDataUrl: string;
  typedName?: string;
}

/**
 * "Adopt your signature": draw it or type it, and agree to sign
 * electronically. The result is always a PNG; a typed name is rendered in a
 * script face so the sealed PDF shows what the signer saw here.
 */
export function SignaturePadDialog({
  open,
  onOpenChange,
  defaultName,
  onAdopt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  onAdopt: (sig: AdoptedSignature) => void;
}) {
  const [mode, setMode] = useState<SignatureMethod>('DRAWN');
  const [typed, setTyped] = useState(defaultName);
  const [consent, setConsent] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePadType | null>(null);

  useEffect(() => {
    if (open) setTyped((t) => t || defaultName);
  }, [open, defaultName]);

  // Mount the pad when the Draw tab is visible. The canvas backing store is
  // sized to its CSS box times devicePixelRatio, or strokes come out offset
  // and blurry on phones.
  useEffect(() => {
    if (!open || mode !== 'DRAWN') return;
    let disposed = false;
    let cleanup: (() => void) | null = null;
    // The dialog animates in; wait a frame so the canvas has its size.
    const raf = requestAnimationFrame(() => {
      void import('signature_pad').then(({ default: SignaturePad }) => {
        const canvas = canvasRef.current;
        if (disposed || !canvas) return;
        const resize = () => {
          const ratio = Math.max(window.devicePixelRatio || 1, 1);
          const data = padRef.current?.toData();
          canvas.width = canvas.offsetWidth * ratio;
          canvas.height = canvas.offsetHeight * ratio;
          canvas.getContext('2d')?.scale(ratio, ratio);
          padRef.current?.clear();
          if (data) padRef.current?.fromData(data);
        };
        const pad = new SignaturePad(canvas, {
          penColor: '#0f1f5c',
          minWidth: 0.8,
          maxWidth: 2.6,
          backgroundColor: 'rgba(0,0,0,0)',
        });
        padRef.current = pad;
        resize();
        const onEnd = () => {
          setHasInk(!pad.isEmpty());
          setError(null);
        };
        pad.addEventListener('endStroke', onEnd);
        window.addEventListener('resize', resize);
        cleanup = () => {
          pad.removeEventListener('endStroke', onEnd);
          window.removeEventListener('resize', resize);
          pad.off();
          padRef.current = null;
        };
      });
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanup?.();
    };
  }, [open, mode]);

  const clear = () => {
    padRef.current?.clear();
    setHasInk(false);
  };

  const adopt = () => {
    setError(null);
    if (!consent) {
      setError('Tick the box to agree to sign electronically.');
      return;
    }
    if (mode === 'DRAWN') {
      const canvas = canvasRef.current;
      const png = canvas && padRef.current && !padRef.current.isEmpty() ? trimmedCanvasPng(canvas) : null;
      if (!png) {
        setError('Draw your signature in the box.');
        return;
      }
      onAdopt({ method: 'DRAWN', imageDataUrl: png });
    } else {
      const name = typed.trim();
      if (name.length < 2) {
        setError('Type your full name.');
        return;
      }
      onAdopt({ method: 'TYPED', imageDataUrl: typedSignaturePng(name), typedName: name });
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Adopt your signature</DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">
            It is placed in every signature box that is yours.
          </DialogDescription>
        </DialogHeader>

        <div role="tablist" aria-label="Signature style" className="flex gap-1 rounded-lg bg-bg-subtle p-1">
          {(['DRAWN', 'TYPED'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                mode === m ? 'bg-bg-surface text-ink shadow-soft' : 'text-ink-muted hover:text-ink',
              )}
            >
              {m === 'DRAWN' ? 'Draw' : 'Type'}
            </button>
          ))}
        </div>

        {mode === 'DRAWN' ? (
          <div className="space-y-2">
            <div className="relative rounded-lg border border-line bg-white">
              <canvas
                ref={canvasRef}
                className="block h-44 w-full touch-none rounded-lg"
                aria-label="Signature pad. Draw your signature with a mouse, finger or pen."
              />
              <div className="pointer-events-none absolute inset-x-6 bottom-9 border-b border-dashed border-line-strong" />
              {!hasInk ? (
                <span className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-ink-disabled">
                  Sign here
                </span>
              ) : null}
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={clear} disabled={!hasInk}>
                <Eraser className="mr-1 h-3.5 w-3.5" aria-hidden />
                Clear
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="typed-signature">Full name</Label>
            <Input
              id="typed-signature"
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                setError(null);
              }}
              maxLength={120}
              autoComplete="name"
            />
            <div
              className="flex h-24 items-center overflow-hidden rounded-lg border border-line bg-white px-5 text-4xl italic text-[#0f1f5c]"
              style={{ fontFamily: TYPED_SIGNATURE_FONT }}
              aria-hidden
            >
              <span className="truncate">{typed.trim() || 'Your name'}</span>
            </div>
          </div>
        )}

        <label className="flex items-start gap-2.5 rounded-lg bg-bg-subtle p-3 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-brand-purple"
            checked={consent}
            onChange={(e) => {
              setConsent(e.target.checked);
              setError(null);
            }}
          />
          <span>{SIGNATURE_CONSENT_TEXT}</span>
        </label>

        {error ? (
          <p role="alert" className="text-sm text-state-error">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={adopt}>Adopt and sign</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
