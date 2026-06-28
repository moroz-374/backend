-- AlterTable
ALTER TABLE "users"
    ADD COLUMN "is_audit_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "audit_enabled_at" TIMESTAMPTZ(3);
