import { Migration } from '@mikro-orm/migrations';

export class Migration20261120140119 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "organizations" ("id" uuid not null, "slug" varchar(60) not null, "name" varchar(120) not null, "kind" varchar(16) not null, "city" varchar(120) null, "website" varchar(255) null, "bio" varchar(500) null, "verified_at" timestamptz null, "signer_id" uuid null, "created_by_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "organizations_pkey" primary key ("id"));`);
    this.addSql(`alter table "organizations" add constraint "organizations_slug_unique" unique ("slug");`);

    this.addSql(`create table "org_members" ("id" uuid not null, "org_id" uuid not null, "user_id" uuid not null, "role" varchar(16) not null, "added_by_id" uuid null, "created_at" timestamptz not null, constraint "org_members_pkey" primary key ("id"));`);
    this.addSql(`alter table "org_members" add constraint "org_members_org_id_user_id_unique" unique ("org_id", "user_id");`);

    this.addSql(`create table "org_invites" ("id" uuid not null, "org_id" uuid not null, "email" varchar(254) not null, "role" varchar(16) not null, "invited_by_id" uuid null, "created_at" timestamptz not null, constraint "org_invites_pkey" primary key ("id"));`);
    this.addSql(`alter table "org_invites" add constraint "org_invites_org_id_email_unique" unique ("org_id", "email");`);

    this.addSql(`alter table "organizations" add constraint "organizations_signer_id_foreign" foreign key ("signer_id") references "users" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "organizations" add constraint "organizations_created_by_id_foreign" foreign key ("created_by_id") references "users" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "org_members" add constraint "org_members_org_id_foreign" foreign key ("org_id") references "organizations" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "org_members" add constraint "org_members_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "org_members" add constraint "org_members_added_by_id_foreign" foreign key ("added_by_id") references "users" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "org_invites" add constraint "org_invites_org_id_foreign" foreign key ("org_id") references "organizations" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "org_invites" add constraint "org_invites_invited_by_id_foreign" foreign key ("invited_by_id") references "users" ("id") on update cascade on delete set null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "org_members" drop constraint "org_members_org_id_foreign";`);

    this.addSql(`alter table "org_invites" drop constraint "org_invites_org_id_foreign";`);

    this.addSql(`drop table if exists "organizations" cascade;`);

    this.addSql(`drop table if exists "org_members" cascade;`);

    this.addSql(`drop table if exists "org_invites" cascade;`);
  }

}
