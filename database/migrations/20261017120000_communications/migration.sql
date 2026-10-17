-- Aditiva: no elimina datos. EmailChallenge se conserva como historial.
-- Tolerante a bases locales donde alguna columna o tabla ya existía fuera de las migraciones.
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "source" TEXT,
  ADD COLUMN IF NOT EXISTS "contactEmail" TEXT;
UPDATE "Appointment" SET "source" = 'CAL_EMBED' WHERE "source" IS NULL;
ALTER TABLE "Appointment" ALTER COLUMN "source" SET DEFAULT 'CAL_EMBED',
  ALTER COLUMN "source" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "PhoneChallenge" (
  "id" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "userId" TEXT,
  "codeHash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "delivered" BOOLEAN NOT NULL DEFAULT false,
  "providerMessageId" TEXT,
  "firstName" TEXT,
  "lastName" TEXT,
  "name" TEXT,
  "email" TEXT,
  "passwordHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PhoneChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PhoneChallenge_purpose_check" CHECK ("purpose" IN ('PHONE_VERIFICATION', 'PASSWORD_RESET', 'PHONE_CHANGE'))
);
CREATE INDEX IF NOT EXISTS "PhoneChallenge_phone_createdAt_idx" ON "PhoneChallenge"("phone", "createdAt");
CREATE INDEX IF NOT EXISTS "PhoneChallenge_userId_createdAt_idx" ON "PhoneChallenge"("userId", "createdAt");

CREATE TABLE IF NOT EXISTS "AuthToken" (
  "tokenHash" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "email" TEXT,
  "channel" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("tokenHash"),
  CONSTRAINT "AuthToken_purpose_check" CHECK ("purpose" IN ('PASSWORD_RESET', 'EMAIL_VERIFICATION')),
  CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AuthToken_userId_purpose_createdAt_idx" ON "AuthToken"("userId", "purpose", "createdAt");

CREATE TABLE IF NOT EXISTS "Notification" (
  "id" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "appointmentId" TEXT,
  "recipient" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "providerMessageId" TEXT,
  "lastError" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Notification_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
CREATE INDEX IF NOT EXISTS "Notification_status_dueAt_idx" ON "Notification"("status", "dueAt");

CREATE TABLE IF NOT EXISTS "CommunicationLog" (
  "id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "recipient" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "error" TEXT,
  "appointmentId" TEXT,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommunicationLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CommunicationLog_createdAt_idx" ON "CommunicationLog"("createdAt");
CREATE INDEX IF NOT EXISTS "CommunicationLog_kind_createdAt_idx" ON "CommunicationLog"("kind", "createdAt");
