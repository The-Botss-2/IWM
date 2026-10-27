import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

/**
 * SSRF guard for user-configured mail hosts (IMAP/SMTP).
 *
 * Zod blocks literal private hostnames at input time, but a domain the
 * attacker controls can rebind to an internal IP on a later lookup. Callers
 * use `resolvePublicHost` and then connect to the RETURNED ADDRESS, with the
 * original name kept only for TLS SNI and certificate checks. Resolving and
 * then connecting by name (what `assertHostnamePublic` alone does) leaves a
 * window where a zero-TTL record answers public for the check and internal
 * for the library's own lookup a moment later.
 *
 * Refuses loopback / private / link-local / CGNAT / IMDS (169.254.169.254) /
 * benchmark / reserved / multicast ranges, plus IPv6 prefixes that embed an
 * IPv4 address (NAT64, 6to4). IPv4-mapped IPv6 and numeric-encoded IPv4
 * literals are normalised so they can't slip past as `::ffff:127.0.0.1` or
 * `2130706433`.
 */
export function isPrivateIp(ip: string): boolean {
  let v = ip.trim().toLowerCase();
  // Strip IPv6 brackets and any zone id.
  v = (v.replace(/^\[/, '').replace(/\]$/, '').split('%')[0] ?? v).trim();

  // IPv4-mapped / -compatible IPv6, e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1.
  const mapped = v.match(/^::ffff:(.+)$/i);
  if (mapped) {
    const inner = mapped[1]!;
    if (isIP(inner) === 4) return isPrivateIp(inner);
    const hex = inner.replace(/:/g, '');
    if (/^[0-9a-f]{8}$/.test(hex)) {
      const quad = [0, 2, 4, 6]
        .map((i) => parseInt(hex.slice(i, i + 2), 16))
        .join('.');
      return isPrivateIp(quad);
    }
  }

  // IPv6 prefixes that carry an embedded IPv4 address: NAT64 (64:ff9b::/96)
  // and 6to4 (2002::/16). Treated as private outright rather than decoded;
  // no legitimate mail host is published that way.
  if (/^64:ff9b:/.test(v) || /^2002:/.test(v)) return true;

  if (v === '::1' || v === '::' || v === '0.0.0.0') return true;
  if (v.startsWith('127.') || v.startsWith('10.') || v.startsWith('192.168.')) return true;
  if (v.startsWith('169.254.') || v.startsWith('0.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  // CGNAT 100.64.0.0/10
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v)) return true;
  // IETF protocol assignments 192.0.0.0/24, benchmarking 198.18.0.0/15
  if (v.startsWith('192.0.0.') || /^198\.1[89]\./.test(v)) return true;
  // Multicast 224.0.0.0/4 and reserved 240.0.0.0/4 (first octet 224-255)
  const firstOctet = Number.parseInt(v.split('.')[0] ?? '', 10);
  if (isIP(v) === 4 && firstOctet >= 224) return true;
  // IPv6 ULA (fc00::/7) and link-local (fe80::/10)
  if (v.startsWith('fc') || v.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(v)) return true;
  return false;
}

/**
 * A user- or admin-supplied mail host was refused (private address, numeric
 * host, unresolvable name). It is the caller's input that is wrong, so the
 * HTTP layer answers 400 with this message (ProblemDetailsExceptionFilter)
 * instead of a 500; queue workers see an ordinary Error, as before.
 */
export class MailHostRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailHostRefusedError';
  }
}

/**
 * Resolve `host` once, refuse if ANY answer is non-public, and return the
 * address to connect to plus the name to use for TLS SNI / certificate
 * verification. Connect with `{ host: result.host, servername: result.servername }`.
 */
export async function resolvePublicHost(
  host: string,
): Promise<{ host: string; servername: string | undefined }> {
  const trimmed = host.trim();
  if (!trimmed) throw new MailHostRefusedError('Empty hostname');

  if (isIP(trimmed)) {
    if (isPrivateIp(trimmed)) {
      throw new MailHostRefusedError(`Refusing to connect to private address ${trimmed}`);
    }
    return { host: trimmed, servername: undefined };
  }
  // Numeric-encoded IPv4 (decimal/hex) that isIP() rejects but the OS resolver
  // may still interpret as an address (e.g. 2130706433, 0x7f000001).
  if (/^(0x[0-9a-f]+|\d+)$/i.test(trimmed)) {
    throw new MailHostRefusedError(`Refusing to connect to numeric host ${trimmed}`);
  }

  let records: { address: string }[];
  try {
    records = await dns.lookup(trimmed, { all: true });
  } catch (err) {
    throw new MailHostRefusedError(`DNS lookup failed for ${trimmed}: ${(err as Error).message}`);
  }
  if (records.length === 0) {
    throw new MailHostRefusedError(`DNS lookup returned no addresses for ${trimmed}`);
  }
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      throw new MailHostRefusedError(
        `Hostname ${trimmed} resolves to private address ${r.address}; refusing to connect.`,
      );
    }
  }
  // Prefer IPv4: EC2 instances often have no IPv6 egress route.
  const chosen = records.find((r) => isIP(r.address) === 4) ?? records[0]!;
  return { host: chosen.address, servername: trimmed };
}

/**
 * Resolve `host` and throw if it (or any DNS answer) points at a non-public
 * address. Prefer `resolvePublicHost` and connect to the returned address;
 * this form is for verification paths that do not open a connection.
 */
export async function assertHostnamePublic(host: string): Promise<void> {
  await resolvePublicHost(host);
}
