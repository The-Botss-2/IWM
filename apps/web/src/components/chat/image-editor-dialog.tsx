'use client';

import Cropper, { type Area } from 'react-easy-crop';
import {
  Check,
  Crop as CropIcon,
  Eraser,
  Pencil,
  RotateCw,
  Type as TypeIcon,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * WhatsApp-style image editor. Two steps:
 *   1. Crop + rotate + zoom (react-easy-crop).
 *   2. Annotate the cropped result - freehand pen and text - on a canvas
 *      overlay, then flatten everything into a single image.
 *
 * Strokes and text are tracked in DISPLAY-space coordinates relative to the
 * shown cropped image; on export we scale them by (naturalSize / displaySize)
 * so the baked-in annotations land in the right place at full resolution.
 *
 * Returns a brand-new File (PNG) via `onConfirm`; the caller stages/sends it.
 */
export interface ImageEditorDialogProps {
  file: File;
  onCancel: () => void;
  onConfirm: (edited: File) => void;
}

type Point = { x: number; y: number };
type Stroke = { points: Point[]; color: string; width: number };
type TextItem = { id: string; x: number; y: number; text: string; color: string; size: number };

const PEN_COLORS = ['#ffffff', '#111827', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6'];

export function ImageEditorDialog({ file, onCancel, onConfirm }: ImageEditorDialogProps) {
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [step, setStep] = useState<'crop' | 'annotate'>('crop');

  // --- crop state ---
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [aspect, setAspect] = useState<number | undefined>(undefined);
  const croppedAreaPixelsRef = useRef<Area | null>(null);

  // --- annotate state ---
  const [croppedUrl, setCroppedUrl] = useState<string | null>(null);
  const [croppedNatural, setCroppedNatural] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<'pen' | 'text'>('pen');
  const [penColor, setPenColor] = useState('#ef4444');
  const [penWidth, setPenWidth] = useState(4);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [texts, setTexts] = useState<TextItem[]>([]);
  const [busy, setBusy] = useState(false);

  const annotateBoxRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef<Stroke | null>(null);

  // Load the source file into an object URL for the cropper.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrcUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Revoke the cropped object URL when it changes / unmounts.
  useEffect(() => {
    return () => {
      if (croppedUrl) URL.revokeObjectURL(croppedUrl);
    };
  }, [croppedUrl]);

  const onCropComplete = useCallback((_a: Area, areaPixels: Area) => {
    croppedAreaPixelsRef.current = areaPixels;
  }, []);

  // Produce the cropped (and rotated) image as an object URL + natural size.
  async function applyCrop(): Promise<void> {
    if (!srcUrl) return;
    const area = croppedAreaPixelsRef.current;
    let rendered: Awaited<ReturnType<typeof renderCroppedImage>>;
    try {
      rendered = await renderCroppedImage(srcUrl, area, rotation);
    } catch (err) {
      toastError(err, "Couldn't crop the image");
      return;
    }
    const { url, w, h } = rendered;
    if (croppedUrl) URL.revokeObjectURL(croppedUrl);
    setCroppedUrl(url);
    setCroppedNatural({ w, h });
    setStrokes([]);
    setTexts([]);
    setStep('annotate');
  }

  // Redraw all strokes onto the overlay whenever they change.
  useEffect(() => {
    if (step !== 'annotate') return;
    const canvas = overlayRef.current;
    const box = annotateBoxRef.current;
    if (!canvas || !box) return;
    const rect = box.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      if (s.points.length === 0) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(s.points[0]!.x, s.points[0]!.y);
      for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }, [strokes, step]);

  function pointerPos(e: React.PointerEvent): Point {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onOverlayPointerDown(e: React.PointerEvent): void {
    if (tool === 'text') {
      // Place a new text item at the click point and focus it.
      const p = pointerPos(e);
      const id = `t${strokes.length}-${texts.length}-${Math.round(p.x)}-${Math.round(p.y)}`;
      setTexts((prev) => [
        ...prev,
        { id, x: p.x, y: p.y, text: '', color: penColor, size: Math.max(16, penWidth * 5) },
      ]);
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drawingRef.current = { points: [pointerPos(e)], color: penColor, width: penWidth };
  }

  function onOverlayPointerMove(e: React.PointerEvent): void {
    if (tool !== 'pen' || !drawingRef.current) return;
    drawingRef.current.points.push(pointerPos(e));
    // Live draw without committing to state on every move (cheap).
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext('2d');
    const pts = drawingRef.current.points;
    if (ctx && pts.length >= 2) {
      ctx.strokeStyle = drawingRef.current.color;
      ctx.lineWidth = drawingRef.current.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[pts.length - 2]!.x, pts[pts.length - 2]!.y);
      ctx.lineTo(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
      ctx.stroke();
    }
  }

  function onOverlayPointerUp(): void {
    if (tool !== 'pen' || !drawingRef.current) return;
    const stroke = drawingRef.current;
    drawingRef.current = null;
    if (stroke.points.length > 0) setStrokes((prev) => [...prev, stroke]);
  }

  function undo(): void {
    // Undo the most recent annotation (text first if it's the latest, else a stroke).
    setStrokes((prev) => prev.slice(0, -1));
  }

  // Flatten cropped image + strokes + text into a single PNG File.
  async function exportEdited(): Promise<void> {
    if (!croppedUrl || !croppedNatural || !annotateBoxRef.current) return;
    setBusy(true);
    try {
      const box = annotateBoxRef.current.getBoundingClientRect();
      const scale = croppedNatural.w / box.width; // display -> natural
      const img = await loadImage(croppedUrl);
      const out = document.createElement('canvas');
      out.width = croppedNatural.w;
      out.height = croppedNatural.h;
      const ctx = out.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(img, 0, 0, out.width, out.height);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const s of strokes) {
        if (s.points.length === 0) continue;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width * scale;
        ctx.beginPath();
        ctx.moveTo(s.points[0]!.x * scale, s.points[0]!.y * scale);
        for (const p of s.points.slice(1)) ctx.lineTo(p.x * scale, p.y * scale);
        ctx.stroke();
      }
      for (const t of texts) {
        if (!t.text.trim()) continue;
        ctx.fillStyle = t.color;
        ctx.textBaseline = 'top';
        ctx.font = `bold ${Math.round(t.size * scale)}px ui-sans-serif, system-ui, sans-serif`;
        // Slight shadow so light text stays legible on light images.
        ctx.shadowColor = 'rgba(0,0,0,0.4)';
        ctx.shadowBlur = 2 * scale;
        ctx.fillText(t.text, t.x * scale, t.y * scale);
        ctx.shadowBlur = 0;
      }
      const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'));
      if (!blob) throw new Error('toBlob failed');
      const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
      const edited = new File([blob], `${baseName}.png`, { type: 'image/png' });
      onConfirm(edited);
    } catch (err) {
      toastError(err, "Couldn't save the edited image");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Cancel"
          onClick={onCancel}
          className="text-white hover:bg-white/10"
        >
          <X className="h-5 w-5" />
        </Button>
        <span className="text-sm font-medium">
          {step === 'crop' ? 'Crop & rotate' : 'Draw & annotate'}
        </span>
        {step === 'crop' ? (
          <Button onClick={applyCrop} className="bg-brand-gradient text-white">
            Next
          </Button>
        ) : (
          <Button onClick={exportEdited} disabled={busy} className="bg-brand-gradient text-white">
            <Check className="mr-1 h-4 w-4" /> Done
          </Button>
        )}
      </div>

      {/* Stage */}
      <div className="relative flex-1">
        {step === 'crop' && srcUrl ? (
          <Cropper
            image={srcUrl}
            crop={crop}
            zoom={zoom}
            rotation={rotation}
            aspect={aspect}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onRotationChange={setRotation}
            onCropComplete={onCropComplete}
            restrictPosition={false}
          />
        ) : null}

        {step === 'annotate' && croppedUrl ? (
          <div className="flex h-full items-center justify-center p-2">
            <div ref={annotateBoxRef} className="relative max-h-full max-w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={croppedUrl}
                alt="Edit preview"
                className="block max-h-[70vh] w-auto max-w-full select-none"
                draggable={false}
              />
              <canvas
                ref={overlayRef}
                onPointerDown={onOverlayPointerDown}
                onPointerMove={onOverlayPointerMove}
                onPointerUp={onOverlayPointerUp}
                className={cn(
                  'absolute inset-0 h-full w-full touch-none',
                  tool === 'pen' ? 'cursor-crosshair' : 'cursor-text',
                )}
              />
              {texts.map((t) => (
                <textarea
                  key={t.id}
                  value={t.text}
                  onChange={(e) =>
                    setTexts((prev) =>
                      prev.map((x) => (x.id === t.id ? { ...x, text: e.target.value } : x)),
                    )
                  }
                  autoFocus
                  rows={1}
                  spellCheck={false}
                  style={{
                    left: t.x,
                    top: t.y,
                    color: t.color,
                    fontSize: t.size,
                    textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                  }}
                  className="absolute resize-none overflow-hidden border-none bg-transparent p-0 font-bold leading-tight outline-none"
                  placeholder="Text"
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-center gap-2 px-4 py-3">
        {step === 'crop' ? (
          <>
            <Button
              variant="ghost"
              onClick={() => setRotation((r) => (r + 90) % 360)}
              className="text-white hover:bg-white/10"
            >
              <RotateCw className="mr-1 h-4 w-4" /> Rotate
            </Button>
            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              aria-label="Zoom"
              className="w-40"
            />
            <div className="ml-2 flex items-center gap-1">
              {([['Free', undefined], ['1:1', 1], ['4:3', 4 / 3], ['16:9', 16 / 9]] as const).map(
                ([label, val]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setAspect(val)}
                    className={cn(
                      'rounded-full px-2 py-1 text-[11px]',
                      aspect === val ? 'bg-white text-black' : 'bg-white/15 text-white',
                    )}
                  >
                    {label}
                  </button>
                ),
              )}
            </div>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              onClick={() => setTool('pen')}
              className={cn('text-white hover:bg-white/10', tool === 'pen' && 'bg-white/20')}
              aria-label="Pen"
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              onClick={() => setTool('text')}
              className={cn('text-white hover:bg-white/10', tool === 'text' && 'bg-white/20')}
              aria-label="Text"
            >
              <TypeIcon className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-1">
              {PEN_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setPenColor(c)}
                  aria-label={`Color ${c}`}
                  style={{ backgroundColor: c }}
                  className={cn(
                    'h-5 w-5 rounded-full ring-1 ring-white/40',
                    penColor === c && 'ring-2 ring-white',
                  )}
                />
              ))}
            </div>
            <input
              type="range"
              min={2}
              max={16}
              step={1}
              value={penWidth}
              onChange={(e) => setPenWidth(Number(e.target.value))}
              aria-label="Brush size"
              className="w-24"
            />
            <Button
              variant="ghost"
              onClick={undo}
              disabled={strokes.length === 0}
              className="text-white hover:bg-white/10"
              aria-label="Undo"
            >
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setStrokes([]);
                setTexts([]);
              }}
              disabled={strokes.length === 0 && texts.length === 0}
              className="text-white hover:bg-white/10"
              aria-label="Clear"
            >
              <Eraser className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              onClick={() => setStep('crop')}
              className="text-white hover:bg-white/10"
              aria-label="Back to crop"
            >
              <CropIcon className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Render the crop region of `src` (after `rotation` degrees) to a PNG object
 * URL. If no crop area is provided yet, the whole (rotated) image is used.
 */
async function renderCroppedImage(
  src: string,
  area: Area | null,
  rotation: number,
): Promise<{ url: string; w: number; h: number }> {
  const img = await loadImage(src);
  const rad = (rotation * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  // Bounding box of the rotated source.
  const bW = img.width * cos + img.height * sin;
  const bH = img.width * sin + img.height * cos;

  // Draw the rotated image onto a temp canvas sized to its bounding box.
  const tmp = document.createElement('canvas');
  tmp.width = Math.round(bW);
  tmp.height = Math.round(bH);
  const tctx = tmp.getContext('2d');
  if (!tctx) throw new Error('no 2d context');
  tctx.translate(bW / 2, bH / 2);
  tctx.rotate(rad);
  tctx.drawImage(img, -img.width / 2, -img.height / 2);

  const cropArea: Area = area ?? { x: 0, y: 0, width: tmp.width, height: tmp.height };
  const w = Math.max(1, Math.round(cropArea.width));
  const h = Math.max(1, Math.round(cropArea.height));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  if (!octx) throw new Error('no 2d context');
  octx.drawImage(
    tmp,
    Math.round(cropArea.x),
    Math.round(cropArea.y),
    w,
    h,
    0,
    0,
    w,
    h,
  );
  const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'));
  if (!blob) throw new Error('toBlob failed');
  return { url: URL.createObjectURL(blob), w, h };
}
