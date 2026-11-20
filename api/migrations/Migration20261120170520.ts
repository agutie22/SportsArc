import { Migration } from '@mikro-orm/migrations';

export class Migration20261120170520 extends Migration {

  override async up(): Promise<void> {
    // The record moves to SportsArcRecord with plain kind names ("checkin",
    // not "checkin.v1"), so every entry's hash changes. The old rows are
    // dropped, not copied: the record job rebuilds every entry from the
    // games, seats and seasons, with fresh salts, and writes each one to the
    // new contract. The old entries stay on the old contract.
    this.addSql(`create table "record_entries" ("id" uuid not null, "kind" varchar(32) not null, "slot" varchar(120) not null, "hash" varchar(66) not null, "values" jsonb not null, "salt" varchar(66) null, "game_id" uuid null, "participant_id" uuid null, "season_id" uuid null, "user_id" uuid null, "status" varchar(16) not null default 'pending', "chain_id" int null, "contract" varchar(42) null, "tx_hash" varchar(66) null, "block_number" bigint null, "written_at" timestamptz null, "attempts" int not null default 0, "last_error" varchar(500) null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "record_entries_pkey" primary key ("id"));`);
    this.addSql(`alter table "record_entries" add constraint "record_entries_slot_unique" unique ("slot");`);
    this.addSql(`alter table "record_entries" add constraint "record_entries_hash_unique" unique ("hash");`);
    this.addSql(`create index "record_entries_participant_id_index" on "record_entries" ("participant_id");`);
    this.addSql(`create index "record_entries_user_id_index" on "record_entries" ("user_id");`);
    this.addSql(`create index "record_entries_status_created_at_index" on "record_entries" ("status", "created_at");`);

    this.addSql(`alter table "record_entries" add constraint "record_entries_game_id_foreign" foreign key ("game_id") references "games" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "record_entries" add constraint "record_entries_participant_id_foreign" foreign key ("participant_id") references "game_participants" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "record_entries" add constraint "record_entries_season_id_foreign" foreign key ("season_id") references "seasons" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "record_entries" add constraint "record_entries_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`drop table if exists "anchor_records" cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`create table "anchor_records" ("id" uuid not null, "kind" varchar(32) not null, "hash" varchar(66) not null, "values" jsonb not null, "salt" varchar(66) null, "game_id" uuid null, "participant_id" uuid null, "status" varchar(16) not null default 'pending', "chain_id" int4 null, "contract" varchar(42) null, "tx_hash" varchar(66) null, "block_number" int8 null, "anchored_at" timestamptz(6) null, "attempts" int4 not null default 0, "last_error" varchar(500) null, "created_at" timestamptz(6) not null, "updated_at" timestamptz(6) not null, "slot" varchar(120) not null, "season_id" uuid null, "user_id" uuid null, constraint "anchor_records_pkey" primary key ("id"));`);
    this.addSql(`alter table "anchor_records" add constraint "anchor_records_hash_unique" unique ("hash");`);
    this.addSql(`create index "anchor_records_participant_id_index" on "anchor_records" ("participant_id");`);
    this.addSql(`alter table "anchor_records" add constraint "anchor_records_slot_unique" unique ("slot");`);
    this.addSql(`create index "anchor_records_status_created_at_index" on "anchor_records" ("status", "created_at");`);
    this.addSql(`create index "anchor_records_user_id_index" on "anchor_records" ("user_id");`);

    this.addSql(`alter table "anchor_records" add constraint "anchor_records_game_id_foreign" foreign key ("game_id") references "games" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "anchor_records" add constraint "anchor_records_participant_id_foreign" foreign key ("participant_id") references "game_participants" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "anchor_records" add constraint "anchor_records_season_id_foreign" foreign key ("season_id") references "seasons" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "anchor_records" add constraint "anchor_records_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`drop table if exists "record_entries" cascade;`);
  }

}
