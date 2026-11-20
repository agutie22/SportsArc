/**
 * Core public config (Circle app + chain): only what the SPA reads.
 */

import { isUuid } from "../validate.js";
import { CHAIN_DEFAULTS, normalizeBuyerChainKey } from "./chain-config.js";

export interface CorePublicConfig {
  circleAppId: string | null;
  /** Human label, e.g. "Arc Testnet". */
  chainName: string;
  /** Block explorer base; the client appends /address/… or /tx/…. */
  explorerUrl: string;
  /** SHOWCASE_RECORD: a user id whose public record the sign-in screen links to, so a visitor can see one without an account. */
  showcaseRecord: string | null;
}

export function getCorePublicConfig(): CorePublicConfig {
  const chain = normalizeBuyerChainKey(process.env.BUYER_CHAIN);
  const chainCfg = CHAIN_DEFAULTS[chain] ?? CHAIN_DEFAULTS.arcTestnet;
  return {
    circleAppId: process.env.CIRCLE_APP_ID?.trim() || null,
    chainName: chainCfg.name,
    explorerUrl: chainCfg.explorer,
    showcaseRecord: isUuid(process.env.SHOWCASE_RECORD?.trim() ?? "") ? process.env.SHOWCASE_RECORD!.trim() : null,
  };
}
