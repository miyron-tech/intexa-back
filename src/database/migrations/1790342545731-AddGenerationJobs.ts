import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGenerationJobs1790342545731 implements MigrationInterface {
  name = 'AddGenerationJobs1790342545731';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "generation_jobs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "service" character varying(40) NOT NULL, "preset" character varying(40) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'queued', "params" jsonb NOT NULL DEFAULT '{}', "prompt" text, "model" character varying(120), "outputs" jsonb NOT NULL DEFAULT '[]', "cost_usd" numeric(10,5) NOT NULL DEFAULT '0', "error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_6b6b705e0fed45c8440c1d7d637" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8424bd6b7d07ccd149c75fc0bc" ON "generation_jobs"  ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_550060b9bb835a0b7c3f8e51e0" ON "generation_jobs"  ("status") `,
    );
    await queryRunner.query(
      `ALTER TABLE "generation_jobs" ADD CONSTRAINT "FK_8424bd6b7d07ccd149c75fc0bc7" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "generation_jobs" DROP CONSTRAINT "FK_8424bd6b7d07ccd149c75fc0bc7"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_550060b9bb835a0b7c3f8e51e0"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8424bd6b7d07ccd149c75fc0bc"`,
    );
    await queryRunner.query(`DROP TABLE "generation_jobs"`);
  }
}
