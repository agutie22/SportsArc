import { Migration } from '@mikro-orm/migrations';

export class Migration20261119154934 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "portfolio_snapshots" ("id" uuid not null, "user_id" uuid not null, "value_cents" int not null, "at" timestamptz not null, "created_at" timestamptz not null, constraint "portfolio_snapshots_pkey" primary key ("id"));`);
    this.addSql(`alter table "portfolio_snapshots" add constraint "portfolio_snapshots_user_id_at_unique" unique ("user_id", "at");`);

    this.addSql(`create table "picks_seen" ("id" uuid not null, "user_id" uuid not null, "seen_at" timestamptz not null, "updated_at" timestamptz not null, constraint "picks_seen_pkey" primary key ("id"));`);
    this.addSql(`alter table "picks_seen" add constraint "picks_seen_user_id_unique" unique ("user_id");`);

    this.addSql(`alter table "portfolio_snapshots" add constraint "portfolio_snapshots_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "picks_seen" add constraint "picks_seen_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "practice_fills" add column "side" varchar(4) not null default 'buy';`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "portfolio_snapshots" cascade;`);

    this.addSql(`drop table if exists "picks_seen" cascade;`);

    this.addSql(`alter table "practice_fills" drop column "side";`);
  }

}
