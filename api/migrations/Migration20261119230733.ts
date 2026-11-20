import { Migration } from '@mikro-orm/migrations';

export class Migration20261119230733 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "roster_checks" ("id" uuid not null, "game_id" uuid not null, "confirmed_by_id" uuid null, "first_confirmed_at" timestamptz not null, "confirmed_at" timestamptz not null, "created_at" timestamptz not null, constraint "roster_checks_pkey" primary key ("id"));`);
    this.addSql(`alter table "roster_checks" add constraint "roster_checks_game_id_unique" unique ("game_id");`);

    this.addSql(`alter table "roster_checks" add constraint "roster_checks_game_id_foreign" foreign key ("game_id") references "games" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "roster_checks" add constraint "roster_checks_confirmed_by_id_foreign" foreign key ("confirmed_by_id") references "users" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "game_participants" add column "host_present" boolean null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "roster_checks" cascade;`);

    this.addSql(`alter table "game_participants" drop column "host_present";`);
  }

}
