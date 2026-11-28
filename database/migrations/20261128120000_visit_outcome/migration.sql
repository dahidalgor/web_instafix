-- Resultado de la visita y revisión de las visitas sin cobro (solo columnas nuevas).
ALTER TABLE "Appointment" ADD COLUMN "outcome" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "noChargeReason" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "noChargeNote" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "noChargeReviewedAt" TIMESTAMP(3);
ALTER TABLE "Appointment" ADD COLUMN "noChargeReviewedById" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "noChargeFlagged" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Appointment_outcome_noChargeReviewedAt_idx" ON "Appointment"("outcome", "noChargeReviewedAt");
