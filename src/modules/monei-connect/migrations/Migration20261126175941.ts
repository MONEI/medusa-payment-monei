import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261126175941 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "monei_credential" drop constraint if exists "monei_credential_mode_unique";`,
    );
    this.addSql(
      `alter table if exists "monei_connect_state" drop constraint if exists "monei_connect_state_state_unique";`,
    );
    this.addSql(
      `create table if not exists "monei_connect_state" ("id" text not null, "state" text not null, "verifier" text not null, "redirect_uri" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "monei_connect_state_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_monei_connect_state_deleted_at" ON "monei_connect_state" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_monei_connect_state_state_unique" ON "monei_connect_state" ("state");`,
    );

    this.addSql(
      `create table if not exists "monei_credential" ("id" text not null, "mode" text check ("mode" in ('live', 'test')) not null, "account_id" text not null, "api_key" text not null, "signing_secret" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "monei_credential_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_monei_credential_deleted_at" ON "monei_credential" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_monei_credential_mode_unique" ON "monei_credential" ("mode");`,
    );

    this.addSql(
      `create table if not exists "monei_setting" ("id" text not null, "mode" text check ("mode" in ('live', 'test')) not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "monei_setting_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_monei_setting_deleted_at" ON "monei_setting" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "monei_connect_state" cascade;`);

    this.addSql(`drop table if exists "monei_credential" cascade;`);

    this.addSql(`drop table if exists "monei_setting" cascade;`);
  }
}
