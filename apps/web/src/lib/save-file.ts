'use client';

/**
 * "Save this blob to the user's device", for every client the web build runs
 * in: browser, Electron desktop, and the Expo WebView that is the mobile app.
 *
 * ## Why this exists
 *
 * The usual trick - make an `<a download href="blob:...">` and click it - is
 * silently inert inside a React Native WebView:
 *
 *  - **Android.** `android.webkit.WebView` routes downloads to a
 *    `DownloadListener`. `react-native-webview` does not register one, so the
 *    click is swallowed. No error, no file, no callback. This is the reported
 *    "PDF won't download on mobile".
 *  - **iOS.** `WKWebView` has `onFileDownload`, but it fires for navigations
 *    it classifies as downloads, not for anchor clicks on a `blob:` URL. The
 *    shell's `onShouldStartLoadWithRequest` also only admits `https://` app
 *    origin, `about:` and `data:`, so a `blob:` navigation is handed to
 *    `Linking.openURL`, which cannot open it.
 *
 * Either way the user taps Download and nothing happens at all - the worst
 * failure shape, because it looks like the app ignored them.
 *
 * So inside the native shell we hand the bytes to the native side over the
 * WebView bridge and let it write the file and open the OS share sheet
 * ("Save to Files" / "Open with"). Everywhere else, the anchor path is
 * correct and stays exactly as it was.
 *
 * ## Version safety
 *
 * We deliberately gate on `window.__BOTSS_NATIVE__.canSaveFile`, which the
 * shell injects on load, rather than on `window.ReactNativeWebView` existing.
 * A shell build older than this bridge has no `onMessage` handler, so posting
 * to it would drop the message into a black hole and reintroduce the exact
 * silent failure we are fixing. Without the flag we fall through to the
 * anchor path: still broken on old builds, but no worse than today, and it
 * starts working the moment the user updates the app.
 */

interface NativeShell {
  /** Present once the shell can receive `botss:save-file` messages. */
  canSaveFile?: boolean;
}

interface RNWebView {
  postMessage: (message: string) => void;
}

function nativeShell(): NativeShell | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { __BOTSS_NATIVE__?: NativeShell };
  return w.__BOTSS_NATIVE__ ?? null;
}

function rnBridge(): RNWebView | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { ReactNativeWebView?: RNWebView };
  return w.ReactNativeWebView ?? null;
}

/** True when the web app is running inside the Expo WebView shell. */
export function isNativeShell(): boolean {
  return nativeShell() !== null && rnBridge() !== null;
}

/**
 * Ceiling on what we push across the bridge. `postMessage` takes a string, so
 * the payload is base64 (+33%) and is copied several times between the JS
 * heap, the bridge and the native side. A 100 MB attachment would take the
 * app down; better to refuse clearly. Well above any normal mail attachment.
 */
const NATIVE_MAX_BYTES = 24 * 1024 * 1024;

/** Thrown when the file is too large to hand across the native bridge. */
export class FileTooLargeForNativeError extends Error {
  constructor(readonly bytes: number) {
    super('File is too large to save on this device.');
    this.name = 'FileTooLargeForNativeError';
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read file."));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error("Couldn't read file."));
        return;
      }
      // `readAsDataURL` yields "data:<mime>;base64,<payload>" - the native
      // side wants the payload alone.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Save `blob` to the device as `filename`.
 *
 * Resolves once the save has been handed off - in the browser that is the
 * moment the click is dispatched, in the native shell the moment the bytes
 * are on the bridge. Neither waits for the user to finish choosing a
 * destination, which is not observable to us on either platform.
 *
 * Throws `FileTooLargeForNativeError` only in the native shell. Callers
 * should surface that to the user; every other failure mode is either
 * impossible or already silent in the browser.
 */
export async function saveFile(blob: Blob, filename: string): Promise<void> {
  if (typeof window === 'undefined') return;
  const name = filename || 'download';

  if (isNativeShell() && nativeShell()?.canSaveFile) {
    if (blob.size > NATIVE_MAX_BYTES) {
      throw new FileTooLargeForNativeError(blob.size);
    }
    const base64 = await blobToBase64(blob);
    rnBridge()?.postMessage(
      JSON.stringify({
        type: 'botss:save-file',
        filename: name,
        mimeType: blob.type || 'application/octet-stream',
        base64,
      }),
    );
    return;
  }

  saveFileViaAnchor(blob, name);
}

/**
 * Browser / Electron path. A `blob:` URL is same-origin, so the browser
 * honours `download` here even when it would ignore it on a cross-origin
 * link.
 */
function saveFileViaAnchor(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Chromium starts the save synchronously on click but reads the blob
    // asynchronously, so revoking in the same tick can truncate the file.
    // A generous delay costs nothing and still frees the memory.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
