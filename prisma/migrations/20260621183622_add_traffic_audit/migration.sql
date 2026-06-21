-- AlterTable
ALTER TABLE "users"
    ADD COLUMN "is_audit_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "traffic_logs"
(
    "id"                BIGSERIAL    NOT NULL,
    "user_id"           BIGINT       NOT NULL,
    "node_uuid"         UUID         NOT NULL,
    "destination"       VARCHAR(253) NOT NULL,
    "destination_type"  VARCHAR(10)  NOT NULL,
    "network"           VARCHAR(3)   NOT NULL,
    "port"              INTEGER      NOT NULL,
    "requested_at"      TIMESTAMPTZ(3) NOT NULL,
    "client_identifier" VARCHAR(255) NOT NULL,
    "event_id"          UUID         NOT NULL,
    "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traffic_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "traffic_logs_event_id_key"
    ON "traffic_logs" ("event_id");

-- CreateIndex
CREATE INDEX "traffic_logs_user_id_requested_at_idx"
    ON "traffic_logs" ("user_id", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "traffic_logs_destination_requested_at_idx"
    ON "traffic_logs" ("destination", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "traffic_logs_requested_at_idx"
    ON "traffic_logs" ("requested_at");

-- AddForeignKey
ALTER TABLE "traffic_logs"
    ADD CONSTRAINT "traffic_logs_user_id_fkey"
        FOREIGN KEY ("user_id")
            REFERENCES "users" ("t_id")
            ON DELETE CASCADE
            ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traffic_logs"
    ADD CONSTRAINT "traffic_logs_node_uuid_fkey"
        FOREIGN KEY ("node_uuid")
            REFERENCES "nodes" ("uuid")
            ON DELETE CASCADE
            ON UPDATE CASCADE;