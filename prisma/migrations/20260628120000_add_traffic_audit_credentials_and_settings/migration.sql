-- AlterTable
ALTER TABLE "remnawave_settings"
    ADD COLUMN "traffic_audit_settings" JSONB;

-- CreateTable
CREATE TABLE "traffic_audit_credentials" (
    "credential_id" VARCHAR(64) NOT NULL,
    "secret_hash" CHAR(64) NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "node_uuid" UUID,

    CONSTRAINT "traffic_audit_credentials_pkey" PRIMARY KEY ("credential_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "traffic_audit_credentials_node_uuid_key"
    ON "traffic_audit_credentials"("node_uuid");

-- AddForeignKey
ALTER TABLE "traffic_audit_credentials"
    ADD CONSTRAINT "traffic_audit_credentials_node_uuid_fkey"
    FOREIGN KEY ("node_uuid") REFERENCES "nodes"("uuid")
    ON DELETE CASCADE ON UPDATE CASCADE;
