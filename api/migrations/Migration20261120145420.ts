import { Migration } from '@mikro-orm/migrations';

export class Migration20261120145420 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "sponsorships" ("id" uuid not null, "sponsor_id" uuid not null, "kind" varchar(16) not null, "venue_id" uuid null, "season_id" uuid null, "status" varchar(16) not null default 'proposed', "offer" varchar(140) null, "starts_at" timestamptz null, "ended_at" timestamptz null, "created_by_id" uuid null, "created_at" timestamptz not null, constraint "sponsorships_pkey" primary key ("id"));`);
    this.addSql(`alter table "sponsorships" add constraint "sponsorships_sponsor_id_season_id_unique" unique ("sponsor_id", "season_id");`);
    this.addSql(`alter table "sponsorships" add constraint "sponsorships_sponsor_id_venue_id_unique" unique ("sponsor_id", "venue_id");`);

    this.addSql(`alter table "sponsorships" add constraint "sponsorships_sponsor_id_foreign" foreign key ("sponsor_id") references "organizations" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "sponsorships" add constraint "sponsorships_venue_id_foreign" foreign key ("venue_id") references "venues" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "sponsorships" add constraint "sponsorships_season_id_foreign" foreign key ("season_id") references "seasons" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "sponsorships" add constraint "sponsorships_created_by_id_foreign" foreign key ("created_by_id") references "users" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "seasons" add column "finals_id" uuid null;`);
    this.addSql(`alter table "seasons" add constraint "seasons_finals_id_foreign" foreign key ("finals_id") references "games" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "event_prizes" add column "sponsor_org_id" uuid null;`);
    this.addSql(`alter table "event_prizes" add constraint "event_prizes_sponsor_org_id_foreign" foreign key ("sponsor_org_id") references "organizations" ("id") on update cascade on delete set null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "sponsorships" cascade;`);

    this.addSql(`alter table "event_prizes" drop constraint "event_prizes_sponsor_org_id_foreign";`);

    this.addSql(`alter table "seasons" drop constraint "seasons_finals_id_foreign";`);

    this.addSql(`alter table "event_prizes" drop column "sponsor_org_id";`);

    this.addSql(`alter table "seasons" drop column "finals_id";`);
  }

}
