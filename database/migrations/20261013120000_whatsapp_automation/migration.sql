ALTER TABLE "Appointment" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "Appointment"
  ADD COLUMN "contactName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "contactPhone" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "whatsappConsentAt" TIMESTAMP(3),
  ADD COLUMN "calUid" TEXT,
  ADD COLUMN "calStatus" TEXT,
  ADD COLUMN "locationLatitude" DOUBLE PRECISION,
  ADD COLUMN "locationLongitude" DOUBLE PRECISION,
  ADD COLUMN "locationReceivedAt" TIMESTAMP(3),
  ADD COLUMN "locationRequestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "automationIssue" TEXT,
  ADD COLUMN "automationRevision" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "Appointment_calUid_key" ON "Appointment"("calUid");
CREATE INDEX "Appointment_contactPhone_status_idx" ON "Appointment"("contactPhone", "status");
UPDATE "Appointment" a SET "contactName" = u."name", "contactPhone" = u."phone" FROM "User" u WHERE a."userId" = u."id";
CREATE TABLE "AutomationJob" (
  "id" TEXT PRIMARY KEY,
  "dedupeKey" TEXT NOT NULL UNIQUE,
  "appointmentId" TEXT NOT NULL REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "revision" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "dueAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "providerId" TEXT UNIQUE,
  "deliveryStatus" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "AutomationJob_status_dueAt_idx" ON "AutomationJob"("status", "dueAt");
CREATE TABLE "IntegrationEvent" (
  "id" TEXT PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "outcome" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "IntegrationEvent_provider_sourceId_occurredAt_idx" ON "IntegrationEvent"("provider", "sourceId", "occurredAt");
