-- Reserva propia de InstaFix mediante Cal.com API v2.
-- Solo añade estados, columnas e índices; no elimina ni reescribe datos existentes.
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'CREATING';
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'FAILED';
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'RESCHEDULED';
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'NO_SHOW';

ALTER TABLE "Appointment"
  ADD COLUMN "contactEmail" TEXT,
  ADD COLUMN "customerRequest" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'CAL_EMBED',
  ADD COLUMN "bookingKey" TEXT,
  ADD COLUMN "bookingError" TEXT,
  ADD COLUMN "cancellationReason" TEXT,
  ADD COLUMN "calSyncedAt" TIMESTAMP(3),
  ADD COLUMN "rescheduledFromId" TEXT;

-- Las reservas anteriores guardaban la descripción del cliente (campo «servicio») en title.
UPDATE "Appointment" SET "customerRequest" = "title" WHERE "calUid" IS NOT NULL;
UPDATE "Appointment" SET "source" = 'ADMIN' WHERE "calUid" IS NULL;

CREATE UNIQUE INDEX "Appointment_bookingKey_key" ON "Appointment"("bookingKey");
CREATE UNIQUE INDEX "Appointment_rescheduledFromId_key" ON "Appointment"("rescheduledFromId");
CREATE INDEX "Appointment_status_createdAt_idx" ON "Appointment"("status", "createdAt");
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_rescheduledFromId_fkey"
  FOREIGN KEY ("rescheduledFromId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AppointmentEvent" (
  "id" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "AppointmentEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AppointmentEvent_dedupeKey_key" ON "AppointmentEvent"("dedupeKey");
CREATE INDEX "AppointmentEvent_processedAt_occurredAt_idx" ON "AppointmentEvent"("processedAt", "occurredAt");
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
