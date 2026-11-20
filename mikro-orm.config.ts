import "reflect-metadata";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { User } from "./api/entities/User.js";
import { UserIdentifier } from "./api/entities/UserIdentifier.js";
import { OtpChallenge } from "./api/entities/OtpChallenge.js";
import { RateLimitHit } from "./api/entities/RateLimitHit.js";
import { Venue } from "./api/entities/Venue.js";
import { Game } from "./api/entities/Game.js";
import { GameParticipant } from "./api/entities/GameParticipant.js";
import { Post } from "./api/entities/Post.js";
import { PostLike } from "./api/entities/PostLike.js";
import { Follow } from "./api/entities/Follow.js";
import { School } from "./api/entities/School.js";
import { AthleteRecord } from "./api/entities/AthleteRecord.js";
import { ImportRun } from "./api/entities/ImportRun.js";
import { Notification } from "./api/entities/Notification.js";
import { ProfileView } from "./api/entities/ProfileView.js";
import { GameResult } from "./api/entities/GameResult.js";
import { ResultSeat } from "./api/entities/ResultSeat.js";
import { RosterCheck } from "./api/entities/RosterCheck.js";
import { BetaInvite } from "./api/entities/BetaInvite.js";
import { WEB3_ENTITIES } from "./api/web3/entities.js";
import { RelayerNonce } from "./api/web3/relayer/RelayerNonce.js";
import { MARKETS_ENTITIES } from "./api/markets/entities.js";
import { ORG_ENTITIES } from "./api/orgs/entities.js";
import { LEAGUE_ENTITIES } from "./api/leagues/entities.js";
import { TRYOUT_ENTITIES } from "./api/tryouts/entities.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entities: [
    User, UserIdentifier, OtpChallenge, BetaInvite, RateLimitHit,
    Venue, Game, GameParticipant, GameResult, ResultSeat, RosterCheck,
    Post, PostLike, Follow,
    School, AthleteRecord, ImportRun,
    Notification, ProfileView,
    ...WEB3_ENTITIES, RelayerNonce,
    ...MARKETS_ENTITIES,
    ...ORG_ENTITIES,
    ...LEAGUE_ENTITIES,
    ...TRYOUT_ENTITIES,
  ],
  extensions: [Migrator],
  clientUrl: process.env.DATABASE_URL,
  debug: false,
  migrations: {
    path: join(__dirname, "api", "migrations"),
    tableName: "mikro_orm_migrations",
  },
});
