-- Seguridad y control de costos: reprogramaciones, eliminación lógica, presupuesto de WhatsApp,
-- límites por origen y números bloqueados. Solo añade columnas y tablas: no borra datos.
ALTER TABLE "Appointment" ADD COLUMN "locationSource" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "rescheduleCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Appointment" ADD COLUMN "originSessionKey" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "originIpHash" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Appointment" ADD COLUMN "deletedById" TEXT;
-- Ubicaciones ya recibidas: las que tienen coordenadas llegaron por WhatsApp o las pegó el equipo.
UPDATE "Appointment" SET "locationSource" = 'WHATSAPP' WHERE "locationReceivedAt" IS NOT NULL;
CREATE INDEX "Appointment_originSessionKey_createdAt_idx" ON "Appointment"("originSessionKey", "createdAt");
CREATE INDEX "Appointment_originIpHash_createdAt_idx" ON "Appointment"("originIpHash", "createdAt");
CREATE INDEX "Appointment_contactPhone_createdAt_idx" ON "Appointment"("contactPhone", "createdAt");

ALTER TABLE "AutomationJob" ADD COLUMN "originSessionKey" TEXT;
ALTER TABLE "AutomationJob" ADD COLUMN "originIpHash" TEXT;
ALTER TABLE "AutomationJob" ADD COLUMN "recipient" TEXT;
ALTER TABLE "AutomationJob" ADD COLUMN "suppressedReason" TEXT;
CREATE INDEX "AutomationJob_originSessionKey_startedAt_idx" ON "AutomationJob"("originSessionKey", "startedAt");
CREATE INDEX "AutomationJob_originIpHash_startedAt_idx" ON "AutomationJob"("originIpHash", "startedAt");
CREATE INDEX "AutomationJob_recipient_startedAt_idx" ON "AutomationJob"("recipient", "startedAt");

ALTER TABLE "PhoneChallenge" ADD COLUMN "ipHash" TEXT;
ALTER TABLE "PhoneChallenge" ADD COLUMN "sessionKey" TEXT;
CREATE INDEX "PhoneChallenge_ipHash_createdAt_idx" ON "PhoneChallenge"("ipHash", "createdAt");
CREATE INDEX "PhoneChallenge_sessionKey_createdAt_idx" ON "PhoneChallenge"("sessionKey", "createdAt");

CREATE TABLE "BlockedPhone" (
  "phone" TEXT NOT NULL,
  "reason" TEXT,
  "blockedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlockedPhone_pkey" PRIMARY KEY ("phone")
);

CREATE TABLE "RateEvent" (
  "id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RateEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RateEvent_scope_key_createdAt_idx" ON "RateEvent"("scope", "key", "createdAt");

CREATE TABLE "AdminAction" (
  "id" TEXT NOT NULL,
  "actorId" TEXT,
  "action" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "detail" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdminAction_createdAt_idx" ON "AdminAction"("createdAt");
