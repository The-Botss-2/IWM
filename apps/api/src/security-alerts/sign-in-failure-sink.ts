/**
 * Better Auth is built before Nest starts, so the sign-in failure hook cannot
 * inject `SecurityAlertsService`. `main.ts` hands `reportSignInFailure` to
 * `createAuth`; the service registers itself here once Nest is up. Until then
 * (and if it never registers) failures are simply not counted.
 */
type Sink = (email: string) => void;

let sink: Sink | null = null;

export function setSignInFailureSink(next: Sink | null): void {
  sink = next;
}

export function reportSignInFailure(email: string): void {
  try {
    sink?.(email);
  } catch {
    // Counting must never touch the sign-in response.
  }
}
