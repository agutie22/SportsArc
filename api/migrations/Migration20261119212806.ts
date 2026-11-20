import { Migration } from '@mikro-orm/migrations';

export class Migration20261119212806 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "anchor_records" drop constraint "anchor_records_participant_id_unique";`);

    // Every record so far is a seat's attendance (checkin.v1 or noshow.v1).
    this.addSql(`alter table "anchor_records" add column "slot" varchar(120) null;`);
    this.addSql(`update "anchor_records" set "slot" = 'attendance:' || "participant_id" where "participant_id" is not null;`);
    this.addSql(`update "anchor_records" set "slot" = 'orphan:' || "id" where "slot" is null;`);
    this.addSql(`alter table "anchor_records" alter column "slot" set not null;`);
    this.addSql(`alter table "anchor_records" add constraint "anchor_records_slot_unique" unique ("slot");`);
    this.addSql(`create index "anchor_records_participant_id_index" on "anchor_records" ("participant_id");`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "anchor_records" drop constraint "anchor_records_slot_unique";`);
    this.addSql(`drop index "anchor_records_participant_id_index";`);
    this.addSql(`alter table "anchor_records" drop column "slot";`);

    this.addSql(`alter table "anchor_records" add constraint "anchor_records_participant_id_unique" unique ("participant_id");`);
  }

}
