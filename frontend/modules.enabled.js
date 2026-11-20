/**
 * Which optional modules this build enables.
 *
 * Each entry is a function returning a dynamic import, so a module that is
 * absent costs nothing. This branch enables Pro markets (Gemini prediction
 * markets on the sport pages; markets/index.js) and organizations
 * (orgs/index.js). Research lives on the
 * feature/x402-research branch, where the free tools sit alongside the paid
 * x402 ones, and where that branch's copy of this file reads:
 *
 *   export const ENABLED_MODULES = [() => import("./research/index.js")];
 *
 * This is deliberately the one file the two branches disagree about.
 */

export const ENABLED_MODULES = [
  () => import("./markets/index.js"),
  // Organizations: org pages, staff, leagues, tryouts (orgs/index.js).
  () => import("./orgs/index.js"),
];
