import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  BackHandler,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as FileSystem from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import * as Sharing from 'expo-sharing';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  WebView,
  type WebViewMessageEvent,
  type WebViewNavigation,
} from 'react-native-webview';

import { ensureAndroidChannels, registerForPushTokenAsync } from '../lib/push';

/**
 * The mobile app is a thin native shell: a full-screen WebView pointed at the
 * hosted web app. The entire UI (projects, chat, mail, docs, calls) is the same
 * Next.js build the browser and desktop clients use - no parallel screens.
 *
 * Native concerns handled here: Android hardware-back navigation, routing
 * off-origin links to the system browser, cookies/storage for the Better Auth
 * session, inline media + camera/mic for calls, a web-style top progress bar,
 * file downloads (Android WebView has no download listener, so the web side
 * hands us the bytes instead), and native push (FCM via Expo) so notifications
 * arrive even when the app is fully closed. The push token is bridged into the WebView so the web app
 * registers it against the logged-in session; notification taps deep-link the
 * WebView to the target route.
 */
// The hosted web app, from EXPO_PUBLIC_APP_URL (inlined by the Expo bundler at
// build time), e.g. https://app.example.com. The default only suits a simulator
// on the dev machine: on a phone, use your computer's LAN address.
const APP_URL: string = (String(process.env.EXPO_PUBLIC_APP_URL ?? '').trim() || 'http://localhost:3000').replace(
  /\/+$/,
  '',
);
// Scheme + host (+ port) of APP_URL. Parsed by hand: React Native's URL
// polyfill does not implement `origin`.
const APP_ORIGIN = /^https?:\/\/[^/?#]+/i.exec(APP_URL)?.[0] ?? APP_URL;
// Older origins that still appear in emails and push payloads, from the
// comma-separated EXPO_PUBLIC_APP_LEGACY_ORIGINS, so links to them stay in the
// WebView instead of bouncing to the browser.
const LEGACY_ORIGINS: string[] = String(process.env.EXPO_PUBLIC_APP_LEGACY_ORIGINS ?? '')
  .split(',')
  .map((o: string) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const BAR_COLOR = '#14b8a6';

/**
 * Exact origin match. A bare `startsWith(origin)` would also accept
 * `https://app.example.com.evil.com`. Avoids `new URL().origin`, which
 * React Native's URL polyfill does not implement.
 */
function isAppUrl(url: string): boolean {
  return [APP_ORIGIN, ...LEGACY_ORIGINS].some(
    (origin) =>
      url === origin ||
      url.startsWith(`${origin}/`) ||
      url.startsWith(`${origin}?`) ||
      url.startsWith(`${origin}#`),
  );
}

// Show banners even when the app is foregrounded (background/killed delivery is
// handled by the OS). Module scope so it's set once before any notification.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // SDK 52 deprecated shouldShowAlert in favour of shouldShowBanner +
    // shouldShowList; set all three so the heads-up banner shows in the
    // foreground on both old and new expo-notifications behaviours (sound alone
    // fired before because only shouldShowAlert was set).
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Auto-retry schedule for a failed page load. Tapping a notification often
// wakes the device out of Doze, and the first load races the network coming
// back - DNS fails (net::ERR_NAME_NOT_RESOLVED) a second or two before it
// would have succeeded.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

/**
 * Resolve a notification's `url` to an absolute app URL, or null when it is
 * not one. Only root-relative paths and app-origin URLs are accepted, so a
 * malformed payload (a missing value, "undefined", another site) opens the
 * app instead of loading a URL the WebView can't resolve. Legacy-origin links
 * are moved to the current origin, where the session cookies live.
 */
function toAppUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const value = url.trim();
  if (value.startsWith('/') && !value.startsWith('//')) return `${APP_ORIGIN}${value}`;
  if (!isAppUrl(value)) return null;
  const legacy = LEGACY_ORIGINS.find((origin) => value.startsWith(origin));
  return legacy ? `${APP_ORIGIN}${value.slice(legacy.length)}` : value;
}

/** The target of a tapped notification, keyed so one tap is handled once. */
function readResponse(
  resp: Notifications.NotificationResponse | null | undefined,
): { id: string; url: string | null } | null {
  if (!resp) return null;
  return {
    id: resp.notification.request.identifier,
    url: toAppUrl(resp.notification.request.content.data?.url),
  };
}

/**
 * Strip anything that could escape the cache directory or upset the platform
 * file APIs. The name arrives from an email attachment, so it is attacker
 * -influenced: "../../evil.sh" must not become a path.
 */
function safeFileName(raw: string): string {
  const base = (raw || 'download').split(/[\/]/).pop() || 'download';
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 120) || 'download';
}

export default function HomeScreen() {
  const webRef = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const webLoaded = useRef(false);
  const pushToken = useRef<string | null>(null);
  // A tap that arrives while the WebView is loading (or failed to load) is
  // parked here and flushed once a load succeeds.
  const pendingUrl = useRef<string | null>(null);
  // Cold start and the response listener can both report the tap that
  // launched the app; remember which ones were handled.
  const handledTaps = useRef(new Set<string>());
  // The first URL to load. Held back until we know whether a notification tap
  // launched the app, so a cold start loads its target directly instead of
  // the home page followed by a second full load.
  const [startUrl, setStartUrl] = useState<string | null>(null);
  const retryCount = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadFailed = useRef(false);
  // Last app page the WebView showed, for remounting after a renderer crash.
  const currentUrl = useRef<string | null>(null);

  // Top loading bar: width tracks WebView load progress (0 -> 1), then fades.
  const progress = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  const showBar = useCallback(() => {
    progress.stopAnimation();
    progress.setValue(0.08);
    opacity.setValue(1);
  }, [opacity, progress]);

  const setProgress = useCallback(
    (value: number) => {
      Animated.timing(progress, {
        toValue: Math.max(value, 0.08),
        duration: 180,
        useNativeDriver: false,
      }).start();
    },
    [progress],
  );

  const finishBar = useCallback(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: 160,
      useNativeDriver: false,
    }).start(() => {
      Animated.timing(opacity, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }).start(() => progress.setValue(0));
    });
  }, [opacity, progress]);

  // Hand the push token to the web app. It listens for `botss:push-token` (and
  // reads window.__BOTSS_PUSH_TOKEN__ as a fallback) and registers it against
  // the session. Re-injected on every load; registration is idempotent.
  const sendPushToken = useCallback((token: string) => {
    const t = JSON.stringify(token);
    webRef.current?.injectJavaScript(
      `(function(){window.__BOTSS_PUSH_TOKEN__=${t};` +
        `window.dispatchEvent(new CustomEvent('botss:push-token',` +
        `{detail:{token:${t},platform:'android'}}));})();true;`,
    );
  }, []);

  // Tell the web app this shell can save files. `lib/save-file.ts` gates on
  // this flag rather than on `window.ReactNativeWebView` existing, so a shell
  // older than the bridge falls back to its browser path instead of posting
  // into a shell with no `onMessage` handler and losing the message.
  const announceCapabilities = useCallback(() => {
    webRef.current?.injectJavaScript(
      "(function(){window.__BOTSS_NATIVE__=Object.assign(" +
        "window.__BOTSS_NATIVE__||{},{canSaveFile:true});})();true;",
    );
  }, []);

  /**
   * Save a file the web app handed us and offer it to the OS.
   *
   * This exists because Android's WebView drops downloads unless a
   * DownloadListener is registered, which react-native-webview does not do -
   * so an `<a download>` click in the web app produced nothing at all. The
   * web side base64s the blob and posts it here instead.
   *
   * The share sheet is the right destination on both platforms: it is the
   * only way to reach "Save to Files" on iOS, and on Android it offers both
   * Save and Open-with. Writing straight to a public Downloads folder would
   * need extra storage permissions on Android and is not possible on iOS.
   */
  const onMessage = useCallback(async (event: WebViewMessageEvent) => {
    let payload: {
      type?: string;
      filename?: string;
      mimeType?: string;
      base64?: string;
    };
    try {
      payload = JSON.parse(event.nativeEvent.data);
    } catch {
      return; // Not ours - the web app may post other things later.
    }
    if (payload.type !== 'botss:save-file') return;
    if (!payload.base64) return;

    const name = safeFileName(payload.filename ?? 'download');
    // cacheDirectory, not documentDirectory: once the user has saved or
    // opened the file the copy is disposable, and the OS can reclaim it.
    const uri = `${FileSystem.cacheDirectory ?? ''}${name}`;
    try {
      await FileSystem.writeAsStringAsync(uri, payload.base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("Couldn't open the share sheet", "Sharing isn't available on this device.");
        return;
      }
      await Sharing.shareAsync(uri, {
        mimeType: payload.mimeType || 'application/octet-stream',
        // iOS wants a UTI. Passing the MIME type is wrong for it but
        // harmless - it falls back to sniffing the extension, which is
        // present because we preserved the filename.
        UTI: payload.mimeType || undefined,
        dialogTitle: name,
      });
    } catch {
      // Usually a full disk (write failed) or a share sheet that errored out.
      // A user-cancelled share resolves normally, so it never lands here.
      Alert.alert("Couldn't save file", 'Check free space and try again.');
    }
  }, []);

  // Navigate the WebView to a notification's target. The web app handles
  // `botss:navigate` with a client-side route change (no full reload, so no
  // fresh DNS lookup); a web build without that listener leaves the event
  // uncancelled and we fall back to a full navigation.
  const navigateTo = useCallback((url: string) => {
    const full = JSON.stringify(url);
    webRef.current?.injectJavaScript(
      `(function(){var e=new CustomEvent('botss:navigate',` +
        `{detail:{url:${full}},cancelable:true});` +
        `if(window.dispatchEvent(e))window.location.href=${full};})();true;`,
    );
  }, []);

  const clearRetry = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);

  const retryLoad = useCallback(() => {
    clearRetry();
    webRef.current?.reload();
  }, [clearRetry]);

  // Register for push once, set up Android channels, and wire tap handling.
  useEffect(() => {
    void ensureAndroidChannels();
    void registerForPushTokenAsync().then((token) => {
      if (!token) return;
      pushToken.current = token;
      if (webLoaded.current) sendPushToken(token);
    });

    // Cold start: was the app launched by tapping a notification? Answered
    // before the WebView mounts so the first load can go straight there.
    let started = false;
    const start = (url: string | null): void => {
      if (started) return;
      started = true;
      setStartUrl(url ?? APP_URL);
    };
    void Notifications.getLastNotificationResponseAsync()
      .then((resp) => {
        const tap = readResponse(resp);
        if (tap) handledTaps.current.add(tap.id);
        // The listener may have parked this same tap already; the first load
        // goes there now, so don't navigate to it a second time.
        if (tap?.url && pendingUrl.current === tap.url) pendingUrl.current = null;
        start(tap?.url ?? null);
      })
      .catch(() => start(null));
    // Never hold the app hostage to the lookup.
    const fallback = setTimeout(() => start(null), 1500);

    // Tap while the app is running (foreground/background).
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const tap = readResponse(resp);
      if (!tap || handledTaps.current.has(tap.id)) return;
      handledTaps.current.add(tap.id);
      if (!tap.url) return;
      if (webLoaded.current) {
        navigateTo(tap.url);
      } else {
        pendingUrl.current = tap.url;
        // Sitting on a failed load: try again now rather than waiting out the
        // backoff - the user is looking at the screen.
        if (loadFailed.current) retryLoad();
      }
    });
    return () => {
      clearTimeout(fallback);
      sub.remove();
    };
  }, [navigateTo, retryLoad, sendPushToken]);

  // Coming back to the foreground on a failed load (e.g. the network was off
  // while backgrounded) retries straight away.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && loadFailed.current) retryLoad();
    });
    return () => {
      sub.remove();
      clearRetry();
    };
  }, [clearRetry, retryLoad]);

  // Android hardware back drives in-app history until there's nowhere to go.
  useFocusEffect(
    useCallback(() => {
      const onBack = (): boolean => {
        if (canGoBack.current) {
          webRef.current?.goBack();
          return true;
        }
        return false;
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
      return () => sub.remove();
    }, []),
  );

  const onNavStateChange = useCallback((nav: WebViewNavigation) => {
    canGoBack.current = nav.canGoBack;
    if (isAppUrl(nav.url)) currentUrl.current = nav.url;
  }, []);

  const onLoadProgress = useCallback(
    ({ nativeEvent }: { nativeEvent: { progress: number } }) => {
      setProgress(nativeEvent.progress);
    },
    [setProgress],
  );

  const onLoadStart = useCallback(() => {
    showBar();
    webLoaded.current = false;
  }, [showBar]);

  // `onLoad` fires only for a successful load (`onLoadEnd` also fires on
  // errors, which used to mark the error page as ready and inject navigation
  // into it).
  const onLoad = useCallback(() => {
    webLoaded.current = true;
    loadFailed.current = false;
    retryCount.current = 0;
    clearRetry();
    // Flush anything that was waiting on the WebView being ready.
    announceCapabilities();
    if (pushToken.current) sendPushToken(pushToken.current);
    if (pendingUrl.current) {
      navigateTo(pendingUrl.current);
      pendingUrl.current = null;
    }
  }, [announceCapabilities, clearRetry, navigateTo, sendPushToken]);

  const onError = useCallback(() => {
    webLoaded.current = false;
    loadFailed.current = true;
    clearRetry();
    const delay = RETRY_DELAYS_MS[retryCount.current];
    if (delay === undefined) return; // Out of auto-retries; the error screen has a button.
    retryCount.current += 1;
    retryTimer.current = setTimeout(retryLoad, delay);
  }, [clearRetry, retryLoad]);

  // The OS can kill the WebView's renderer while the app is backgrounded,
  // leaving a blank screen on return. Remount it.
  const [webKey, setWebKey] = useState(0);
  const onRendererGone = useCallback(() => {
    webLoaded.current = false;
    if (currentUrl.current) setStartUrl(currentUrl.current);
    setWebKey((k) => k + 1);
  }, []);

  const renderError = useCallback(
    () => (
      <View style={styles.errorScreen}>
        <Text style={styles.errorTitle}>Can't reach Botss</Text>
        <Text style={styles.errorBody}>
          Check your internet connection. We'll keep trying.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            retryCount.current = 0;
            retryLoad();
          }}
          style={({ pressed }) => [styles.retryButton, pressed && styles.retryPressed]}
        >
          <Text style={styles.retryLabel}>Try again</Text>
        </Pressable>
      </View>
    ),
    [retryLoad],
  );

  // Keep app-origin navigation inside the WebView; hand everything else
  // (payment providers, mailto:, external sites) to the OS.
  const onShouldStartLoad = useCallback((req: WebViewNavigation): boolean => {
    const { url } = req;
    // `blob:` is same-origin content the web app generated (image previews,
    // and any download path that has not been routed through the save-file
    // bridge). Handing it to Linking guaranteed failure - the OS cannot
    // resolve a blob: URL - so keep it in the WebView.
    if (
      isAppUrl(url) ||
      url.startsWith('about:') ||
      url.startsWith('data:') ||
      url.startsWith('blob:')
    ) {
      return true;
    }
    void Linking.openURL(url);
    return false;
  }, []);

  const width = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <Animated.View
        pointerEvents="none"
        style={[styles.barTrack, { opacity }]}
      >
        <Animated.View style={[styles.barFill, { width }]} />
      </Animated.View>
      {startUrl !== null && (
        <WebView
          key={webKey}
          ref={webRef}
          source={{ uri: startUrl }}
          style={styles.fill}
          // Auth + app state.
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          cacheEnabled
          // Calls: inline playback and camera/mic without a user-gesture gate.
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          mediaCapturePermissionGrantType="grant"
          // File picker (chat attachments, document uploads).
          allowFileAccess
          // Native Android pull-to-refresh.
          pullToRefreshEnabled
          // Navigation routing.
          originWhitelist={['https://*', 'http://*']}
          onNavigationStateChange={onNavStateChange}
          onShouldStartLoadWithRequest={onShouldStartLoad}
          // Receives `botss:save-file` from the web app. Setting this is also
          // what makes react-native-webview inject `window.ReactNativeWebView`.
          onMessage={(e) => void onMessage(e)}
          // iOS-only safety net for downloads WKWebView classifies itself (a
          // Content-Disposition navigation rather than an anchor click).
          // Without a handler those abort the load and show nothing at all.
          //
          // Caveat: this opens the URL in Safari, which has its own cookie jar.
          // That is correct for presigned object-storage links (chat/file
          // attachments) and will 401 for cookie-authenticated API routes. Every
          // download the app actually initiates now goes through the save-file
          // bridge above, so this only catches paths we did not anticipate -
          // where showing the user Safari beats showing them nothing.
          onFileDownload={({ nativeEvent }) => {
            void Linking.openURL(nativeEvent.downloadUrl);
          }}
          onLoadStart={onLoadStart}
          onLoadProgress={onLoadProgress}
          onLoad={onLoad}
          onLoadEnd={finishBar}
          onError={onError}
          renderError={renderError}
          onRenderProcessGone={onRendererGone}
          onContentProcessDidTerminate={onRendererGone}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  fill: { flex: 1 },
  barTrack: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    zIndex: 10,
    backgroundColor: 'transparent',
  },
  barFill: {
    height: 3,
    backgroundColor: BAR_COLOR,
  },
  errorScreen: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#ffffff',
  },
  errorTitle: { fontSize: 18, fontWeight: '600', color: '#0f172a', marginBottom: 8 },
  errorBody: { fontSize: 14, color: '#475569', textAlign: 'center', marginBottom: 20 },
  retryButton: {
    backgroundColor: BAR_COLOR,
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  retryPressed: { opacity: 0.8 },
  retryLabel: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
});
