import { Migration } from '@mikro-orm/migrations';

export class Migration20261120143223 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "leagues" ("id" uuid not null, "org_id" uuid not null, "name" varchar(120) not null, "sport" varchar(24) not null, "format" varchar(40) null, "created_at" timestamptz not null, constraint "leagues_pkey" primary key ("id"));`);

    this.addSql(`create table "seasons" ("id" uuid not null, "league_id" uuid not null, "name" varchar(120) not null, "starts_on" date not null, "ends_on" date not null, "status" varchar(16) not null default 'draft', "roster_min" smallint not null default 3, "roster_max" smallint not null default 5, "teams_max" smallint null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "seasons_pkey" primary key ("id"));`);

    this.addSql(`create table "teams" ("id" uuid not null, "season_id" uuid not null, "name" varchar(60) not null, "captain_id" uuid null, "join_code" varchar(24) not null, "created_by_id" uuid null, "created_at" timestamptz not null, constraint "teams_pkey" primary key ("id"));`);
    this.addSql(`alter table "teams" add constraint "teams_join_code_unique" unique ("join_code");`);
    this.addSql(`alter table "teams" add constraint "teams_season_id_name_unique" unique ("season_id", "name");`);

    this.addSql(`create table "team_members" ("id" uuid not null, "team_id" uuid not null, "user_id" uuid not null, "added_by_id" uuid null, "created_at" timestamptz not null, constraint "team_members_pkey" primary key ("id"));`);
    this.addSql(`alter table "team_members" add constraint "team_members_team_id_user_id_unique" unique ("team_id", "user_id");`);

    this.addSql(`create table "registrations" ("id" uuid not null, "season_id" uuid not null, "user_id" uuid not null, "kind" varchar(16) not null, "team_id" uuid null, "note" varchar(200) null, "status" varchar(16) not null default 'waiting', "created_at" timestamptz not null, constraint "registrations_pkey" primary key ("id"));`);
    this.addSql(`alter table "registrations" add constraint "registrations_season_id_user_id_unique" unique ("season_id", "user_id");`);

    this.addSql(`alter table "leagues" add constraint "leagues_org_id_foreign" foreign key ("org_id") references "organizations" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "seasons" add constraint "seasons_league_id_foreign" foreign key ("league_id") references "leagues" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "teams" add constraint "teams_season_id_foreign" foreign key ("season_id") references "seasons" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "teams" add constraint "teams_captain_id_foreign" foreign key ("captain_id") references "users" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "teams" add constraint "teams_created_by_id_foreign" foreign key ("created_by_id") references "users" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "team_members" add constraint "team_members_team_id_foreign" foreign key ("team_id") references "teams" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "team_members" add constraint "team_members_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "team_members" add constraint "team_members_added_by_id_foreign" foreign key ("added_by_id") references "users" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "registrations" add constraint "registrations_season_id_foreign" foreign key ("season_id") references "seasons" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "registrations" add constraint "registrations_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "registrations" add constraint "registrations_team_id_foreign" foreign key ("team_id") references "teams" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "games" add column "season_id" uuid null, add column "home_team_id" uuid null, add column "away_team_id" uuid null;`);
    this.addSql(`alter table "games" add constraint "games_season_id_foreign" foreign key ("season_id") references "seasons" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "games" add constraint "games_home_team_id_foreign" foreign key ("home_team_id") references "teams" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "games" add constraint "games_away_team_id_foreign" foreign key ("away_team_id") references "teams" ("id") on update cascade on delete set null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "seasons" drop constraint "seasons_league_id_foreign";`);

    this.addSql(`alter table "teams" drop constraint "teams_season_id_foreign";`);

    this.addSql(`alter table "registrations" drop constraint "registrations_season_id_foreign";`);

    this.addSql(`alter table "games" drop constraint "games_season_id_foreign";`);

    this.addSql(`alter table "team_members" drop constraint "team_members_team_id_foreign";`);

    this.addSql(`alter table "registrations" drop constraint "registrations_team_id_foreign";`);

    this.addSql(`alter table "games" drop constraint "games_home_team_id_foreign";`);

    this.addSql(`alter table "games" drop constraint "games_away_team_id_foreign";`);

    this.addSql(`drop table if exists "leagues" cascade;`);

    this.addSql(`drop table if exists "seasons" cascade;`);

    this.addSql(`drop table if exists "teams" cascade;`);

    this.addSql(`drop table if exists "team_members" cascade;`);

    this.addSql(`drop table if exists "registrations" cascade;`);

    this.addSql(`alter table "games" drop column "season_id", drop column "home_team_id", drop column "away_team_id";`);
  }

}
