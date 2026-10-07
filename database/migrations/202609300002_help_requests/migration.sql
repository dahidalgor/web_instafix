CREATE TABLE "HelpRequest" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "device" TEXT NOT NULL,
  "problem" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDIENTE_ASESORIA',
  "consentAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HelpRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HelpRequest_reference_key" ON "HelpRequest"("reference");
CREATE INDEX "HelpRequest_status_createdAt_idx" ON "HelpRequest"("status", "createdAt");
