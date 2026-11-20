import { Migration } from '@mikro-orm/migrations';

export class Migration20261120152943 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "tryouts" ("id" uuid not null, "org_id" uuid not null, "game_id" uuid not null, "name" varchar(120) not null, "camp_spots" smallint not null default 3, "created_by_id" uuid null, "created_at" timestamptz not null, constraint "tryouts_pkey" primary key ("id"));`);
    this.addSql(`alter table "tryouts" add constraint "tryouts_game_id_unique" unique ("game_id");`);

    this.addSql(`create table "tryout_marks" ("id" uuid not null, "tryout_id" uuid not null, "user_id" uuid not null, "kind" varchar(16) not null, "season_id" uuid null, "by_id" uuid null, "created_at" timestamptz not null, constraint "tryout_marks_pkey" primary key ("id"));`);
    this.addSql(`alter table "tryout_marks" add constraint "tryout_marks_tryout_id_user_id_kind_unique" unique ("tryout_id", "user_id", "kind");`);

    this.addSql(`alter table "tryouts" add constraint "tryouts_org_id_foreign" foreign key ("org_id") references "organizations" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "tryouts" add constraint "tryouts_game_id_foreign" foreign key ("game_id") references "games" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "tryouts" add constraint "tryouts_created_by_id_foreign" foreign key ("created_by_id") references "users" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "tryout_marks" add constraint "tryout_marks_tryout_id_foreign" foreign key ("tryout_id") references "tryouts" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "tryout_marks" add constraint "tryout_marks_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "tryout_marks" add constraint "tryout_marks_season_id_foreign" foreign key ("season_id") references "seasons" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "tryout_marks" add constraint "tryout_marks_by_id_foreign" foreign key ("by_id") references "users" ("id") on update cascade on delete set null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "tryout_marks" drop constraint "tryout_marks_tryout_id_foreign";`);

    this.addSql(`drop table if exists "tryouts" cascade;`);

    this.addSql(`drop table if exists "tryout_marks" cascade;`);
  }

}
