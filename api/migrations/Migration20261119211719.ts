import { Migration } from '@mikro-orm/migrations';

export class Migration20261119211719 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "anchor_leaves" drop constraint "anchor_leaves_batch_id_foreign";`);

    this.addSql(`create table "anchor_records" ("id" uuid not null, "kind" varchar(32) not null, "hash" varchar(66) not null, "values" jsonb not null, "salt" varchar(66) null, "game_id" uuid null, "participant_id" uuid null, "status" varchar(16) not null default 'pending', "chain_id" int null, "contract" varchar(42) null, "tx_hash" varchar(66) null, "block_number" bigint null, "anchored_at" timestamptz null, "attempts" int not null default 0, "last_error" varchar(500) null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "anchor_records_pkey" primary key ("id"));`);
    this.addSql(`alter table "anchor_records" add constraint "anchor_records_hash_unique" unique ("hash");`);
    this.addSql(`alter table "anchor_records" add constraint "anchor_records_participant_id_unique" unique ("participant_id");`);
    this.addSql(`create index "anchor_records_status_created_at_index" on "anchor_records" ("status", "created_at");`);

    this.addSql(`alter table "anchor_records" add constraint "anchor_records_game_id_foreign" foreign key ("game_id") references "games" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "anchor_records" add constraint "anchor_records_participant_id_foreign" foreign key ("participant_id") references "game_participants" ("id") on update cascade on delete cascade;`);

    this.addSql(`drop table if exists "anchor_batches" cascade;`);

    this.addSql(`drop table if exists "anchor_leaves" cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`create table "anchor_batches" ("id" uuid not null, "kind" varchar(32) not null, "root" varchar(66) not null, "leaf_count" int4 not null, "leaves" jsonb not null, "status" varchar(16) not null default 'pending', "chain_id" int4 null, "contract" varchar(42) null, "tx_hash" varchar(66) null, "block_number" int8 null, "posted_at" timestamptz(6) null, "attempts" int4 not null default 0, "last_error" varchar(500) null, "created_at" timestamptz(6) not null, "updated_at" timestamptz(6) not null, "game_id" uuid null, constraint "anchor_batches_pkey" primary key ("id"));`);
    this.addSql(`alter table "anchor_batches" add constraint "anchor_batches_root_unique" unique ("root");`);
    this.addSql(`create index "anchor_batches_status_created_at_index" on "anchor_batches" ("status", "created_at");`);

    this.addSql(`create table "anchor_leaves" ("id" uuid not null, "batch_id" uuid not null, "kind" varchar(32) not null, "participant_id" uuid null, "leaf" varchar(66) not null, "leaf_index" int4 not null, "values" jsonb not null, "salt" varchar(66) null, "created_at" timestamptz(6) not null, constraint "anchor_leaves_pkey" primary key ("id"));`);
    this.addSql(`alter table "anchor_leaves" add constraint "anchor_leaves_batch_id_leaf_index_unique" unique ("batch_id", "leaf_index");`);
    this.addSql(`alter table "anchor_leaves" add constraint "anchor_leaves_leaf_unique" unique ("leaf");`);
    this.addSql(`alter table "anchor_leaves" add constraint "anchor_leaves_participant_id_unique" unique ("participant_id");`);

    this.addSql(`alter table "anchor_batches" add constraint "anchor_batches_game_id_foreign" foreign key ("game_id") references "games" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "anchor_leaves" add constraint "anchor_leaves_batch_id_foreign" foreign key ("batch_id") references "anchor_batches" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "anchor_leaves" add constraint "anchor_leaves_participant_id_foreign" foreign key ("participant_id") references "game_participants" ("id") on update cascade on delete cascade;`);

    this.addSql(`drop table if exists "anchor_records" cascade;`);
  }

}
