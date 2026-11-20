/**
 * Whether this process is draining. Set once by shutdown() in server.ts;
 * readiness answers 503 from then on.
 */

let draining = false;

export const isDraining = (): boolean => draining;

export function startDraining(): void {
  draining = true;
}
