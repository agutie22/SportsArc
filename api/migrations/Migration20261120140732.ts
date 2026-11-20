import { Migration } from '@mikro-orm/migrations';

export class Migration20261120140732 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "org_invites" add column "user_id" uuid null;`);
    this.addSql(`alter table "org_invites" alter column "email" type varchar(254) using ("email"::varchar(254));`);
    this.addSql(`alter table "org_invites" alter column "email" drop not null;`);
    this.addSql(`alter table "org_invites" add constraint "org_invites_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "org_invites" add constraint "org_invites_org_id_user_id_unique" unique ("org_id", "user_id");`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "org_invites" drop constraint "org_invites_user_id_foreign";`);

    this.addSql(`alter table "org_invites" drop constraint "org_invites_org_id_user_id_unique";`);
    this.addSql(`alter table "org_invites" drop column "user_id";`);

    this.addSql(`alter table "org_invites" alter column "email" type varchar(254) using ("email"::varchar(254));`);
    this.addSql(`alter table "org_invites" alter column "email" set not null;`);
  }

}
