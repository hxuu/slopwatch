import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The prefix every Slopwatch bearer token carries, so it is recognizable. */
const TOKEN_PREFIX = "slop_";

/** Mint a long-lived bearer token. Shown to the admin once, never stored raw. */
export function mintToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * Hash a bearer token for storage and lookup. Tokens are high-entropy random
 * strings, so a plain SHA-256 is enough; there is nothing to brute-force.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison, so a wrong admin token cannot be guessed by timing. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
