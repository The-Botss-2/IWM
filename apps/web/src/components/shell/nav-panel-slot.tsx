'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * A slot in the rail layout's contextual panel that a feature can fill with
 * its own sidebar.
 *
 * ## Why this exists
 *
 * Mail and Chat each own a second level of navigation - folders, channels and
 * DMs. Before this, the rail panel rendered a thin stub of that list (a single
 * "Inbox" entry; a room list without search or unread previews) while the page
 * rendered its real sidebar beside it. The user saw the same navigation twice,
 * in two adjacent columns, costing ~280px of horizontal space.
 *
 * The fix is that a feature's real sidebar IS the panel. This slot is how it
 * gets there without lifting page state into the URL or into global state:
 * the page keeps owning its selection state and simply renders through a
 * portal into the panel's DOM node.
 *
 * ## Contract
 *
 * - `useNavPanelAvailable()` is false under the top-bar layout (no outlet is
 *   mounted), so features must keep their inline rendering path for it. It is
 *   also false for the first render under the rail, until the outlet's ref
 *   callback lands - hence `claimed` gating rather than an assumption.
 * - A feature that portals in should NOT also render its inline sidebar, and
 *   should collapse its own grid column accordingly.
 * - Claims are counted, so a page that mounts two portals (or remounts during
 *   a transition) does not leave the panel showing nothing.
 */
interface NavPanelContextValue {
  el: HTMLElement | null;
  setEl: (el: HTMLElement | null) => void;
  claimed: boolean;
  claim: () => void;
  release: () => void;
  /**
   * The panel only exists at lg+. Below that the rail collapses into a
   * drawer and the desktop chrome is hidden with CSS - which does NOT
   * unmount it, so the outlet's ref still fires and `el` is non-null on a
   * phone. Portalling there would push a feature's sidebar into a
   * `display:none` column and make it unreachable, so availability is gated
   * on the viewport as well as on the node existing.
   */
  wide: boolean;
}

const NavPanelContext = createContext<NavPanelContextValue | null>(null);

/** Matches the `lg:` breakpoint the rail chrome itself is gated on. */
const PANEL_MEDIA = '(min-width: 1024px)';

export function NavPanelProvider({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState(0);
  // Starts false so the server render and the first client render agree; the
  // effect below corrects it before paint on a desktop.
  const [wide, setWide] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(PANEL_MEDIA);
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const claim = useCallback(() => setClaims((n) => n + 1), []);
  const release = useCallback(() => setClaims((n) => Math.max(0, n - 1)), []);

  const value = useMemo<NavPanelContextValue>(
    () => ({ el, setEl, claimed: claims > 0, claim, release, wide }),
    [el, claims, claim, release, wide],
  );

  return <NavPanelContext.Provider value={value}>{children}</NavPanelContext.Provider>;
}

function useNavPanel(): NavPanelContextValue | null {
  return useContext(NavPanelContext);
}

/** True when a feature sidebar can be portalled into the panel right now. */
export function useNavPanelAvailable(): boolean {
  const ctx = useNavPanel();
  return ctx?.el != null && ctx.wide;
}

/** True when some feature has filled the slot - the panel hides its own list. */
export function useNavPanelClaimed(): boolean {
  return useNavPanel()?.claimed ?? false;
}

/**
 * Rendered by the panel. The portal target.
 *
 * Exactly ONE of these may be mounted at a time - the context holds a single
 * node, so a second outlet would silently steal the slot from the first. The
 * mobile drawer therefore renders the panel without one and falls back to the
 * panel's own link lists.
 */
export function NavPanelOutlet({ className }: { className?: string }) {
  const ctx = useNavPanel();
  return <div ref={ctx?.setEl ?? null} className={className} />;
}

/**
 * Rendered by a feature page. Portals its children into the panel and marks
 * the slot claimed for as long as it is mounted.
 */
export function NavPanelPortal({ children }: { children: ReactNode }) {
  const ctx = useNavPanel();
  const available = ctx?.el != null && ctx.wide;
  const claim = ctx?.claim;
  const release = ctx?.release;

  // Claim only while genuinely portalling. Claiming on a phone would blank
  // the drawer's own list without putting anything in its place.
  useEffect(() => {
    if (!available || !claim || !release) return;
    claim();
    return release;
  }, [available, claim, release]);

  if (!ctx?.el || !available) return null;
  return createPortal(children, ctx.el);
}
