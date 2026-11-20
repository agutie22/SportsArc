import { Migration } from '@mikro-orm/migrations';

export class Migration20261120140327 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "users" add column "team_key" varchar(32) null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "users" drop column "team_key";`);
  }

}
