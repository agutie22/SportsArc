import { Migration } from '@mikro-orm/migrations';

export class Migration20261120144533 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "seasons" add column "final_at" timestamptz null;`);

    this.addSql(`alter table "anchor_records" add column "season_id" uuid null, add column "user_id" uuid null;`);
    this.addSql(`alter table "anchor_records" add constraint "anchor_records_season_id_foreign" foreign key ("season_id") references "seasons" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "anchor_records" add constraint "anchor_records_user_id_foreign" foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;`);
    this.addSql(`create index "anchor_records_user_id_index" on "anchor_records" ("user_id");`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "anchor_records" drop constraint "anchor_records_season_id_foreign";`);
    this.addSql(`alter table "anchor_records" drop constraint "anchor_records_user_id_foreign";`);

    this.addSql(`drop index "anchor_records_user_id_index";`);
    this.addSql(`alter table "anchor_records" drop column "season_id", drop column "user_id";`);

    this.addSql(`alter table "seasons" drop column "final_at";`);
  }

}
