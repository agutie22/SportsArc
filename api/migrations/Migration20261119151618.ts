import { Migration } from '@mikro-orm/migrations';

export class Migration20261119151618 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "gateway_scans" ("id" uuid not null, "scan_key" varchar(80) not null, "block_number" varchar(30) not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "gateway_scans_pkey" primary key ("id"));`);
    this.addSql(`alter table "gateway_scans" add constraint "gateway_scans_scan_key_unique" unique ("scan_key");`);

    this.addSql(`create table "import_runs" ("id" uuid not null, "source" varchar(32) not null, "status" varchar(16) not null default 'running', "created" int not null default 0, "updated" int not null default 0, "skipped" int not null default 0, "problems" jsonb null, "error" text null, "started_at" timestamptz not null, "finished_at" timestamptz null, constraint "import_runs_pkey" primary key ("id"));`);
    this.addSql(`create index "import_runs_source_started_at_index" on "import_runs" ("source", "started_at");`);

    this.addSql(`create table "market_ticks" ("id" uuid not null, "symbol" varchar(120) not null, "chance" smallint not null, "at" timestamptz not null, "created_at" timestamptz not null, constraint "market_ticks_pkey" primary key ("id"));`);
    this.addSql(`alter table "market_ticks" add constraint "market_ticks_symbol_at_unique" unique ("symbol", "at");`);

    this.addSql(`create table "otp_challenges" ("id" uuid not null, "kind" varchar(16) not null, "value" varchar(255) not null, "code_hash" varchar(64) not null, "expires_at" timestamptz not null, "attempts" int not null default 0, "created_at" timestamptz not null, constraint "otp_challenges_pkey" primary key ("id"));`);
    this.addSql(`create index "otp_challenges_kind_value_index" on "otp_challenges" ("kind", "value");`);

    this.addSql(`create table "rate_limit_hits" ("id" uuid not null, "bucket" varchar(32) not null, "key" varchar(300) not null, "hit_at" timestamptz not null, constraint "rate_limit_hits_pkey" primary key ("id"));`);
    this.addSql(`create index "rate_limit_hits_hit_at_index" on "rate_limit_hits" ("hit_at");`);
    this.addSql(`create index "rate_limit_hits_bucket_key_hit_at_index" on "rate_limit_hits" ("bucket", "key", "hit_at");`);

    this.addSql(`create table "relayer_nonces" ("address" varchar(42) not null, "chain_id" int not null, "genesis" varchar(66) not null, "next_nonce" bigint not null, "updated_at" timestamptz not null, constraint "relayer_nonces_pkey" primary key ("address", "chain_id"));`);

    this.addSql(`create table "schools" ("id" uuid not null, "name" varchar(200) not null, "state" varchar(2) null, "city" varchar(120) null, "external_ids" jsonb null, "created_at" timestamptz not null, constraint "schools_pkey" primary key ("id"));`);
    this.addSql(`create index "schools_state_index" on "schools" ("state");`);
    this.addSql(`alter table "schools" add constraint "schools_name_state_unique" unique ("name", "state");`);

    this.addSql(`create table "users" ("id" uuid not null, "name" varchar(255) null, "role" varchar(32) null, "headline" varchar(255) null, "audience" varchar(32) null, "bio" text null, "location" varchar(120) null, "primary_sport" varchar(24) null, "position" varchar(32) null, "class_year" varchar(16) null, "school" varchar(160) null, "height_inches" int null, "weight_lbs" int null, "avatar_url" varchar(80) null, "cover_url" varchar(80) null, "record_private" boolean not null default false, "highlight_url" varchar(300) null, "links" jsonb null, "circle_user_id" varchar(64) null, "wallet_address" varchar(42) null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "users_pkey" primary key ("id"));`);
    this.addSql(`alter table "users" add constraint "users_circle_user_id_unique" unique ("circle_user_id");`);
    this.addSql(`create unique index "users_name_lower_unique" on "users" (lower("name")) where "name" is not null;`);

    this.addSql(`create table "record_shares" ("id" uuid not null, "user_id" uuid not null, "token" varchar(43) not null, "created_at" timestamptz not null, constraint "record_shares_pkey" primary key ("id"));`);
    this.addSql(`alter table "record_shares" add constraint "record_shares_token_unique" unique ("token");`);
    this.addSql(`alter table "record_shares" add constraint "record_shares_user_id_unique" unique ("user_id");`);

    this.addSql(`create table "profile_views" ("id" uuid not null, "viewer_id" uuid not null, "viewed_id" uuid not null, "day" varchar(10) not null, "created_at" timestamptz not null, constraint "profile_views_pkey" primary key ("id"));`);
    this.addSql(`create index "profile_views_viewed_id_created_at_index" on "profile_views" ("viewed_id", "created_at");`);
    this.addSql(`alter table "profile_views" add constraint "profile_views_viewer_id_viewed_id_day_unique" unique ("viewer_id", "viewed_id", "day");`);

    this.addSql(`create table "practice_fills" ("id" uuid not null, "user_id" uuid not null, "client_order_id" varchar(64) not null, "symbol" varchar(120) not null, "event_ticker" varchar(100) not null, "title" varchar(160) not null, "label" varchar(120) not null, "sport" varchar(24) not null, "outcome" varchar(3) not null, "qty" varchar(24) not null, "price" varchar(12) not null, "cost_cents" int not null, "settled_at" timestamptz null, "payout_cents" int null, "created_at" timestamptz not null, constraint "practice_fills_pkey" primary key ("id"));`);
    this.addSql(`create index "practice_fills_user_id_settled_at_index" on "practice_fills" ("user_id", "settled_at");`);
    this.addSql(`alter table "practice_fills" add constraint "practice_fills_user_id_client_order_id_unique" unique ("user_id", "client_order_id");`);

    this.addSql(`create table "payout_destinations" ("id" uuid not null, "user_id" uuid not null, "chain_key" varchar(24) not null, "address" varchar(42) not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "payout_destinations_pkey" primary key ("id"));`);
    this.addSql(`alter table "payout_destinations" add constraint "payout_destinations_user_id_chain_key_address_unique" unique ("user_id", "chain_key", "address");`);

    this.addSql(`create table "gemini_links" ("id" uuid not null, "user_id" uuid not null, "env" varchar(16) not null, "access_token" text not null, "refresh_token" text not null, "access_expires_at" timestamptz not null, "scopes" varchar(255) not null, "terms_version" varchar(64) null, "settled_seen_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "gemini_links_pkey" primary key ("id"));`);
    this.addSql(`alter table "gemini_links" add constraint "gemini_links_user_id_unique" unique ("user_id");`);

    this.addSql(`create table "follows" ("id" uuid not null, "follower_id" uuid not null, "followee_id" uuid not null, "created_at" timestamptz not null, constraint "follows_pkey" primary key ("id"));`);
    this.addSql(`create index "follows_followee_id_index" on "follows" ("followee_id");`);
    this.addSql(`alter table "follows" add constraint "follows_follower_id_followee_id_unique" unique ("follower_id", "followee_id");`);

    this.addSql(`create table "cctp_transfers" ("id" uuid not null, "user_id" uuid not null, "state" varchar(16) not null default 'burn_approval', "source_chain_id" int not null, "source_domain" int not null, "destination_chain_id" int not null, "destination_domain" int not null, "wallet_address" varchar(42) not null, "recipient_address" varchar(42) null, "forward" boolean not null default true, "amount" varchar(78) not null, "max_fee" varchar(78) null, "min_finality_threshold" int not null, "step_tx_id" uuid null, "burn_approval_tx_hash" varchar(66) null, "burn_tx_hash" varchar(66) null, "source_message" text null, "attested_message" text null, "attestation" text null, "nonce" varchar(66) null, "iris_polls" int not null default 0, "receive_tx_hash" varchar(66) null, "minted_amount" varchar(78) null, "next_check_at" timestamptz null, "last_error_code" varchar(40) null, "last_error" text null, "completed_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "cctp_transfers_pkey" primary key ("id"));`);
    this.addSql(`create index "cctp_transfers_state_next_check_at_index" on "cctp_transfers" ("state", "next_check_at");`);
    this.addSql(`create index "cctp_transfers_user_id_created_at_index" on "cctp_transfers" ("user_id", "created_at");`);
    this.addSql(`alter table "cctp_transfers" add constraint "cctp_transfers_burn_tx_hash_unique" unique ("burn_tx_hash");`);

    this.addSql(`create table "cctp_fundings" ("id" uuid not null, "user_id" uuid not null, "state" varchar(8) not null default 'sent', "source_chain_id" int not null, "source_domain" int not null, "wallet_address" varchar(42) not null, "burn_tx_hash" varchar(66) not null, "amount" varchar(78) null, "received_amount" varchar(78) null, "mint_tx_hash" varchar(66) null, "polls" int not null default 0, "next_check_at" timestamptz null, "last_error" text null, "completed_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "cctp_fundings_pkey" primary key ("id"));`);
    this.addSql(`create index "cctp_fundings_state_next_check_at_index" on "cctp_fundings" ("state", "next_check_at");`);
    this.addSql(`create index "cctp_fundings_user_id_created_at_index" on "cctp_fundings" ("user_id", "created_at");`);
    this.addSql(`alter table "cctp_fundings" add constraint "cctp_fundings_source_chain_id_burn_tx_hash_unique" unique ("source_chain_id", "burn_tx_hash");`);

    this.addSql(`create table "beta_invites" ("id" uuid not null, "email" varchar(254) not null, "invited_by_id" uuid null, "note" varchar(200) null, "created_at" timestamptz not null, "accepted_at" timestamptz null, constraint "beta_invites_pkey" primary key ("id"));`);
    this.addSql(`alter table "beta_invites" add constraint "beta_invites_email_unique" unique ("email");`);

    this.addSql(`create table "athlete_records" ("id" uuid not null, "source" varchar(32) not null, "source_id" varchar(200) not null, "source_url" varchar(500) null, "name" varchar(160) not null, "school_id" uuid null, "sport" varchar(24) not null, "position" varchar(32) null, "class_year" varchar(16) null, "height_inches" int null, "weight_lbs" int null, "stats" jsonb null, "claimed_by_id" uuid null, "claimed_at" timestamptz null, "first_seen_at" timestamptz not null, "last_seen_at" timestamptz not null, constraint "athlete_records_pkey" primary key ("id"));`);
    this.addSql(`create index "athlete_records_school_id_index" on "athlete_records" ("school_id");`);
    this.addSql(`create index "athlete_records_sport_class_year_index" on "athlete_records" ("sport", "class_year");`);
    this.addSql(`alter table "athlete_records" add constraint "athlete_records_source_source_id_unique" unique ("source", "source_id");`);

    this.addSql(`create table "user_evm_txs" ("id" uuid not null, "user_id" uuid not null, "kind" varchar(32) not null default 'call', "status" varchar(24) not null default 'awaiting_signature', "chain_id" int not null, "from_address" varchar(42) not null, "to_address" varchar(42) not null, "value" varchar(78) not null default '0', "data" text not null default '0x', "nonce" int not null, "gas_limit" varchar(78) not null, "max_fee_per_gas" varchar(78) not null, "max_priority_fee_per_gas" varchar(78) not null, "unsigned_tx" text not null, "memo" varchar(120) null, "challenge_id" varchar(64) null, "tx_hash" varchar(66) null, "block_number" varchar(32) null, "gas_used" varchar(78) null, "error" text null, "submitted_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "user_evm_txs_pkey" primary key ("id"));`);
    this.addSql(`create index "user_evm_txs_user_id_created_at_index" on "user_evm_txs" ("user_id", "created_at");`);

    this.addSql(`create table "user_evm_wallets" ("id" uuid not null, "user_id" uuid not null, "circle_wallet_id" varchar(64) null, "address" varchar(42) null, "challenge_id" varchar(64) null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "user_evm_wallets_pkey" primary key ("id"));`);
    this.addSql(`alter table "user_evm_wallets" add constraint "user_evm_wallets_user_id_unique" unique ("user_id");`);

    this.addSql(`create table "user_identifiers" ("id" uuid not null, "user_id" uuid not null, "kind" varchar(16) not null, "value" varchar(255) not null, "created_at" timestamptz not null, constraint "user_identifiers_pkey" primary key ("id"));`);
    this.addSql(`create unique index "user_identifiers_kind_lower_value_unique" on "user_identifiers" ("kind", lower("value"));`);
    this.addSql(`alter table "user_identifiers" add constraint "user_identifiers_kind_value_unique" unique ("kind", "value");`);

    this.addSql(`create table "user_signatures" ("id" uuid not null, "user_id" uuid not null, "kind" varchar(32) not null, "status" varchar(24) not null default 'awaiting_signature', "signer_address" varchar(42) not null, "typed_data" text not null, "challenge_id" varchar(64) not null, "signature" varchar(132) null, "created_at" timestamptz not null, "signed_at" timestamptz null, constraint "user_signatures_pkey" primary key ("id"));`);
    this.addSql(`create index "user_signatures_user_id_created_at_index" on "user_signatures" ("user_id", "created_at");`);

    this.addSql(`create table "venues" ("id" uuid not null, "name" varchar(160) not null, "address" varchar(255) null, "lat" double precision not null, "lng" double precision not null, "kind" varchar(16) not null default 'park', "indoor" boolean not null default false, "created_by_id" uuid null, "created_at" timestamptz not null, constraint "venues_pkey" primary key ("id"));`);
    this.addSql(`create index "venues_lat_lng_index" on "venues" ("lat", "lng");`);

    this.addSql(`create table "games" ("id" uuid not null, "host_id" uuid not null, "host_plays" boolean not null default true, "venue_id" uuid not null, "sport" varchar(24) not null, "kind" varchar(16) not null default 'pickup', "starts_at" timestamptz not null, "duration_minutes" int not null default 90, "capacity" int not null default 10, "skill_level" varchar(16) not null default 'any', "visibility" varchar(16) not null default 'public', "status" varchar(16) not null default 'open', "notes" varchar(500) null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "games_pkey" primary key ("id"));`);
    this.addSql(`create index "games_sport_starts_at_index" on "games" ("sport", "starts_at");`);
    this.addSql(`create index "games_starts_at_index" on "games" ("starts_at");`);

    this.addSql(`create table "posts" ("id" uuid not null, "author_id" uuid not null, "body" text not null, "kind" varchar(16) not null default 'user', "images" jsonb not null default '[]', "game_id" uuid null, "reply_to_id" uuid null, "sport" varchar(24) null, "market" jsonb null, "like_count" int not null default 0, "reply_count" int not null default 0, "created_at" timestamptz not null, constraint "posts_pkey" primary key ("id"));`);
    this.addSql(`create index "posts_sport_created_at_index" on "posts" ("sport", "created_at");`);
    this.addSql(`create index "posts_author_id_created_at_index" on "posts" ("author_id", "created_at");`);
    this.addSql(`create index "posts_created_at_index" on "posts" ("created_at");`);

    this.addSql(`create table "post_likes" ("id" uuid not null, "post_id" uuid not null, "user_id" uuid not null, "created_at" timestamptz not null, constraint "post_likes_pkey" primary key ("id"));`);
    this.addSql(`alter table "post_likes" add constraint "post_likes_post_id_user_id_unique" unique ("post_id", "user_id");`);

    this.addSql(`create table "payments" ("id" uuid not null, "payer_id" uuid not null, "payee_id" uuid not null, "amount" bigint not null, "note" varchar(80) null, "game_id" uuid null, "status" varchar(10) not null default 'pending', "was_request" boolean not null default false, "signature_id" uuid null, "chain_id" int null, "tx_hash" varchar(66) null, "created_at" timestamptz not null, "paid_at" timestamptz null, constraint "payments_pkey" primary key ("id"));`);
    this.addSql(`create index "payments_payee_id_created_at_index" on "payments" ("payee_id", "created_at");`);
    this.addSql(`create index "payments_payer_id_status_index" on "payments" ("payer_id", "status");`);

    this.addSql(`create table "notifications" ("id" uuid not null, "recipient_id" uuid not null, "actor_id" uuid null, "kind" varchar(16) not null, "post_id" uuid null, "game_id" uuid null, "detail" varchar(120) null, "read_at" timestamptz null, "created_at" timestamptz not null, constraint "notifications_pkey" primary key ("id"));`);
    this.addSql(`create index "notifications_recipient_id_created_at_index" on "notifications" ("recipient_id", "created_at");`);

    this.addSql(`create table "gateway_payouts" ("id" uuid not null, "user_id" uuid not null, "game_id" uuid null, "source_key" varchar(120) not null, "state" varchar(20) not null default 'queued', "amount" varchar(78) not null, "dest_chain_key" varchar(24) not null, "dest_address" varchar(42) not null, "fee" varchar(78) null, "sent_amount" varchar(78) null, "deposit_tx_hash" varchar(66) null, "attempt" int not null default 0, "transfer_id" varchar(36) null, "dest_tx_hash" varchar(66) null, "fallback_tx_hash" varchar(66) null, "fallback_reason" varchar(200) null, "errors" int not null default 0, "last_error_code" varchar(40) null, "last_error" text null, "next_attempt_at" timestamptz null, "completed_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "gateway_payouts_pkey" primary key ("id"));`);
    this.addSql(`create index "gateway_payouts_state_next_attempt_at_index" on "gateway_payouts" ("state", "next_attempt_at");`);
    this.addSql(`create index "gateway_payouts_user_id_created_at_index" on "gateway_payouts" ("user_id", "created_at");`);
    this.addSql(`alter table "gateway_payouts" add constraint "gateway_payouts_source_key_unique" unique ("source_key");`);

    this.addSql(`create table "game_results" ("id" uuid not null, "game_id" uuid not null, "status" varchar(16) not null default 'locked', "locked_at" timestamptz not null, "locked_by_id" uuid null, "outcome" varchar(16) null, "winning_side" smallint null, "score0" int null, "score1" int null, "recorded_by_id" uuid null, "recorded_at" timestamptz null, "first_recorded_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "game_results_pkey" primary key ("id"));`);
    this.addSql(`alter table "game_results" add constraint "game_results_game_id_unique" unique ("game_id");`);

    this.addSql(`create table "game_participants" ("id" uuid not null, "game_id" uuid not null, "user_id" uuid not null, "status" varchar(16) not null default 'joined', "checked_in_at" timestamptz null, "side" smallint null, "cohost" boolean not null default false, "removed_at" timestamptz null, "joined_at" timestamptz not null, constraint "game_participants_pkey" primary key ("id"));`);
    this.addSql(`alter table "game_participants" add constraint "game_participants_game_id_user_id_unique" unique ("game_id", "user_id");`);

    this.addSql(`create table "result_seats" ("id" uuid not null, "result_id" uuid not null, "participant_id" uuid not null, "side" smallint null, constraint "result_seats_pkey" primary key ("id"));`);
    this.addSql(`alter table "result_seats" add constraint "result_seats_result_id_participant_id_unique" unique ("result_id", "participant_id");`);

    this.addSql(`create table "event_terms" ("id" uuid not null, "game_id" uuid not null, "chain_id" int not null, "vault_address" varchar(42) not null, "event_key" varchar(66) not null, "organizer_id" uuid not null, "organizer_address" varchar(42) not null, "entry_fee" bigint not null, "min_entrants" int not null, "min_attendees" int not null, "starts_at" timestamptz not null, "registration_closes_at" timestamptz not null, "result_deadline" timestamptz not null, "split" jsonb null, "status" varchar(16) not null default 'draft', "action" varchar(16) null, "action_signature_id" uuid null, "action_tx_hash" varchar(66) null, "action_payload" jsonb null, "create_tx_hash" varchar(66) null, "placements" jsonb null, "attendees" int null, "result_tx_hash" varchar(66) null, "final_at" timestamptz null, "cancel_tx_hash" varchar(66) null, "organizer_payout" varchar(78) null, "fee_taken" varchar(78) null, "organizer_tx_hash" varchar(66) null, "settled_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "event_terms_pkey" primary key ("id"));`);
    this.addSql(`create index "event_terms_status_settled_at_index" on "event_terms" ("status", "settled_at");`);
    this.addSql(`alter table "event_terms" add constraint "event_terms_game_id_chain_id_vault_address_unique" unique ("game_id", "chain_id", "vault_address");`);

    this.addSql(`create table "event_prizes" ("id" uuid not null, "terms_id" uuid not null, "funder_id" uuid not null, "funder_address" varchar(42) not null, "amount" bigint not null, "salt" varchar(66) not null, "state" varchar(16) not null default 'signing', "signature_id" uuid null, "tx_hash" varchar(66) null, "funded_at" timestamptz null, "returned" varchar(78) null, "return_tx_hash" varchar(66) null, "settled_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "event_prizes_pkey" primary key ("id"));`);
    this.addSql(`create index "event_prizes_funder_id_created_at_index" on "event_prizes" ("funder_id", "created_at");`);
    this.addSql(`create index "event_prizes_terms_id_state_index" on "event_prizes" ("terms_id", "state");`);

    this.addSql(`create table "event_entries" ("id" uuid not null, "terms_id" uuid not null, "user_id" uuid not null, "player_address" varchar(42) not null, "team_key" varchar(66) not null, "routed" boolean not null default false, "payout_chain_key" varchar(24) null, "payout_address" varchar(42) null, "attempt" int not null default 0, "state" varchar(16) not null default 'signing', "signature_id" uuid null, "tx_hash" varchar(66) null, "leave_signature_id" uuid null, "leave_tx_hash" varchar(66) null, "entered_at" timestamptz null, "left_at" timestamptz null, "payout" varchar(78) null, "payout_kind" varchar(8) null, "payout_tx_hash" varchar(66) null, "settled_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "event_entries_pkey" primary key ("id"));`);
    this.addSql(`create index "event_entries_state_index" on "event_entries" ("state");`);
    this.addSql(`create index "event_entries_terms_id_player_address_index" on "event_entries" ("terms_id", "player_address");`);
    this.addSql(`alter table "event_entries" add constraint "event_entries_terms_id_user_id_unique" unique ("terms_id", "user_id");`);

    this.addSql(`create table "anchor_batches" ("id" uuid not null, "game_id" uuid null, "kind" varchar(32) not null, "root" varchar(66) not null, "leaf_count" int not null, "leaves" jsonb not null, "status" varchar(16) not null default 'pending', "chain_id" int null, "contract" varchar(42) null, "tx_hash" varchar(66) null, "block_number" bigint null, "posted_at" timestamptz null, "attempts" int not null default 0, "last_error" varchar(500) null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "anchor_batches_pkey" primary key ("id"));`);
    this.addSql(`alter table "anchor_batches" add constraint "anchor_batches_root_unique" unique ("root");`);
    this.addSql(`create index "anchor_batches_status_created_at_index" on "anchor_batches" ("status", "created_at");`);

    this.addSql(`create table "anchor_leaves" ("id" uuid not null, "batch_id" uuid not null, "kind" varchar(32) not null, "participant_id" uuid null, "leaf" varchar(66) not null, "leaf_index" int not null, "values" jsonb not null, "salt" varchar(66) null, "created_at" timestamptz not null, constraint "anchor_leaves_pkey" primary key ("id"));`);
    this.addSql(`alter table "anchor_leaves" add constraint "anchor_leaves_leaf_unique" unique ("leaf");`);
    this.addSql(`alter table "anchor_leaves" add constraint "anchor_leaves_participant_id_unique" unique ("participant_id");`);
    this.addSql(`alter table "anchor_leaves" add constraint "anchor_leaves_batch_id_leaf_index_unique" unique ("batch_id", "leaf_index");`);

    this.addSql(`alter table "record_shares" add constraint "record_shares_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "profile_views" add constraint "profile_views_viewer_id_foreign" foreign key ("viewer_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "profile_views" add constraint "profile_views_viewed_id_foreign" foreign key ("viewed_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "practice_fills" add constraint "practice_fills_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "payout_destinations" add constraint "payout_destinations_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "gemini_links" add constraint "gemini_links_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "follows" add constraint "follows_follower_id_foreign" foreign key ("follower_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "follows" add constraint "follows_followee_id_foreign" foreign key ("followee_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "cctp_transfers" add constraint "cctp_transfers_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "cctp_fundings" add constraint "cctp_fundings_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "beta_invites" add constraint "beta_invites_invited_by_id_foreign" foreign key ("invited_by_id") references "users" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "athlete_records" add constraint "athlete_records_school_id_foreign" foreign key ("school_id") references "schools" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "athlete_records" add constraint "athlete_records_claimed_by_id_foreign" foreign key ("claimed_by_id") references "users" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "user_evm_txs" add constraint "user_evm_txs_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "user_evm_wallets" add constraint "user_evm_wallets_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "user_identifiers" add constraint "user_identifiers_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "user_signatures" add constraint "user_signatures_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "venues" add constraint "venues_created_by_id_foreign" foreign key ("created_by_id") references "users" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "games" add constraint "games_host_id_foreign" foreign key ("host_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "games" add constraint "games_venue_id_foreign" foreign key ("venue_id") references "venues" ("id") on update cascade on delete restrict;`);

    this.addSql(`alter table "posts" add constraint "posts_author_id_foreign" foreign key ("author_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "posts" add constraint "posts_game_id_foreign" foreign key ("game_id") references "games" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "posts" add constraint "posts_reply_to_id_foreign" foreign key ("reply_to_id") references "posts" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "post_likes" add constraint "post_likes_post_id_foreign" foreign key ("post_id") references "posts" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "post_likes" add constraint "post_likes_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "payments" add constraint "payments_payer_id_foreign" foreign key ("payer_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "payments" add constraint "payments_payee_id_foreign" foreign key ("payee_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "payments" add constraint "payments_game_id_foreign" foreign key ("game_id") references "games" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "notifications" add constraint "notifications_recipient_id_foreign" foreign key ("recipient_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "notifications" add constraint "notifications_actor_id_foreign" foreign key ("actor_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "notifications" add constraint "notifications_post_id_foreign" foreign key ("post_id") references "posts" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "notifications" add constraint "notifications_game_id_foreign" foreign key ("game_id") references "games" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "gateway_payouts" add constraint "gateway_payouts_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "gateway_payouts" add constraint "gateway_payouts_game_id_foreign" foreign key ("game_id") references "games" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "game_results" add constraint "game_results_game_id_foreign" foreign key ("game_id") references "games" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "game_results" add constraint "game_results_locked_by_id_foreign" foreign key ("locked_by_id") references "users" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "game_results" add constraint "game_results_recorded_by_id_foreign" foreign key ("recorded_by_id") references "users" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "game_participants" add constraint "game_participants_game_id_foreign" foreign key ("game_id") references "games" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "game_participants" add constraint "game_participants_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "result_seats" add constraint "result_seats_result_id_foreign" foreign key ("result_id") references "game_results" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "result_seats" add constraint "result_seats_participant_id_foreign" foreign key ("participant_id") references "game_participants" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "event_terms" add constraint "event_terms_game_id_foreign" foreign key ("game_id") references "games" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "event_terms" add constraint "event_terms_organizer_id_foreign" foreign key ("organizer_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "event_prizes" add constraint "event_prizes_terms_id_foreign" foreign key ("terms_id") references "event_terms" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "event_prizes" add constraint "event_prizes_funder_id_foreign" foreign key ("funder_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "event_entries" add constraint "event_entries_terms_id_foreign" foreign key ("terms_id") references "event_terms" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "event_entries" add constraint "event_entries_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "anchor_batches" add constraint "anchor_batches_game_id_foreign" foreign key ("game_id") references "games" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "anchor_leaves" add constraint "anchor_leaves_batch_id_foreign" foreign key ("batch_id") references "anchor_batches" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "anchor_leaves" add constraint "anchor_leaves_participant_id_foreign" foreign key ("participant_id") references "game_participants" ("id") on update cascade on delete cascade;`);
  }

}
