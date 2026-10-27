'use client';

import { useState } from 'react';

/**
 * Latches to `true` the first time `open` is true. Used to defer mounting a
 * lazily-imported (`next/dynamic`) dialog until it's first opened - so its
 * chunk isn't fetched for users who never open it - while keeping it mounted
 * afterwards so its close animation still plays.
 */
export function useHasOpened(open: boolean): boolean {
  const [hasOpened, setHasOpened] = useState(open);
  // Adjusting state during render: React's documented pattern for state
  // derived from a prop transition (no extra effect pass / flash).
  if (open && !hasOpened) setHasOpened(true);
  return hasOpened || open;
}
