-- Idempotencia de crear/reprogramar/cancelar citas y bloqueo de operaciones simultáneas.
CREATE TABLE "IdempotencyRecord" (
  "key" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "response" JSONB,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");
