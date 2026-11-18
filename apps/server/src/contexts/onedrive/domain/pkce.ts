import { createHash, randomBytes } from 'node:crypto';

/** RFC 7636: 43-128 chars of [A-Za-z0-9-._~]; 64 random bytes -> 86 base64url chars. */
export function newCodeVerifier(): string {
  return randomBytes(64).toString('base64url');
}

export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Unguessable, single-use CSRF value for the OAuth `state` parameter. */
export function newState(): string {
  return randomBytes(32).toString('base64url');
}
