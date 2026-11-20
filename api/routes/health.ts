/**
 * Liveness, readiness, and the public config and vocabulary the client boots
 * from.
 */

import { em } from "../db.js";
import { isDraining } from "../ops/drain.js";
import { RESULT_OUTCOMES } from "../entities/GameResult.js";
import { GAME_KINDS, SKILL_LEVELS, SPORTS } from "../entities/Game.js";
import { USER_AUDIENCES, USER_ROLES } from "../entities/User.js";
import { VENUE_KINDS } from "../entities/Venue.js";
import { CHECKIN_RULES } from "../games/checkin.js";
import { handleWalletUsdcBalance } from "../circle/budget-handler.js";
import { json } from "../http.js";
import { inviteOnlyEnabled } from "../auth/invites.js";
import { consoleCodes, emailLoginEnabled, smsLoginEnabled } from "../auth/mailer.js";
import { getCorePublicConfig } from "../circle/public-config.js";
import { get } from "../router.js";
import { relayerStatus } from "../web3/relayer/submit.js";
import { marketSports } from "../markets/catalog.js";
import { ORG_KINDS } from "../orgs/Organization.js";
import { ORG_ROLES } from "../orgs/OrgMember.js";

/** Readiness gives up on a database ping after this long. */
const READY_DB_TIMEOUT_MS = 2_000;

get("/health", ({ res }) => {
  json(res, 200, { status: "ok", timestamp: new Date().toISOString() });
});

/**
 * Readiness: 503 while shutting down or when the database does not answer
 * a ping in time, so a load balancer stops sending traffic here first.
 * `relayer` is the key that pays gas for players, as last read: its balance
 * and whether it is low. It never makes this check fail or wait.
 */
get("/health/ready", async ({ res }) => {
  if (isDraining()) {
    json(res, 503, { status: "shutting_down", timestamp: new Date().toISOString() });
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const db = await Promise.race([
    em().execute("select 1").then(() => true, () => false),
    new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), READY_DB_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (!db) {
    json(res, 503, { status: "db_unavailable", timestamp: new Date().toISOString() });
    return;
  }
  json(res, 200, { status: "ready", timestamp: new Date().toISOString(), relayer: relayerStatus() });
});

get("/api/config", ({ res }) => {
  json(res, 200, {
    ok: true,
    config: {
      ...getCorePublicConfig(),
      // Login options (mailer.ts, invites.ts). consoleCodes: codes print to
      // the API log (development only), so the login screen can say so.
      auth: {
        inviteOnly: inviteOnlyEnabled(),
        emailLogin: emailLoginEnabled(),
        phoneLogin: smsLoginEnabled(),
        consoleCodes: consoleCodes(),
      },
    },
  });
});

get("/api/meta", ({ res }) => {
  json(res, 200, {
    ok: true,
    meta: {
      sports: SPORTS,
      skillLevels: SKILL_LEVELS,
      gameKinds: GAME_KINDS,
      venueKinds: VENUE_KINDS,
      roles: USER_ROLES,
      audiences: USER_AUDIENCES,
      resultOutcomes: RESULT_OUTCOMES,
      // Organizations (api/orgs/).
      orgKinds: ORG_KINDS,
      orgRoles: ORG_ROLES,
      // Check-in window and geofence (api/games/checkin.ts).
      checkIn: CHECKIN_RULES,
      // Sports that have Pro markets on Gemini (api/markets/catalog.ts).
      marketSports: marketSports(),
    },
  });
});

get("/api/wallet/usdc-balance", async ({ res, query }) => {
  const result = await handleWalletUsdcBalance(query.get("address") ?? undefined);
  const status = result.ok ? 200 : result.error.code === "VALIDATION_ERROR" ? 400 : 502;
  json(res, status, result);
});
