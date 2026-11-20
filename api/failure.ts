/**
 * The failure half of a handler's result object: handlers return
 * `{ ok: true, ... }` or one of these, and never throw across a boundary.
 * Dependency-free so every layer can import it.
 */

export interface Failure {
  ok: false;
  error: { code: string; message: string };
}

export const fail = (code: string, message: string): Failure => ({ ok: false, error: { code, message } });
