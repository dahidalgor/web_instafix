-- Reserva provisional: el horario se guarda en Instafix hasta que un técnico confirma.
-- Solo agrega columnas e índice (no borra ni cambia datos).
ALTER TABLE "Appointment" ADD COLUMN "holdStartedAt" TIMESTAMP(3);
ALTER TABLE "Appointment" ADD COLUMN "holdExpiresAt" TIMESTAMP(3);
ALTER TABLE "Appointment" ADD COLUMN "responseDueAt" TIMESTAMP(3);
ALTER TABLE "Appointment" ADD COLUMN "autoCancelReason" TEXT;
CREATE INDEX "Appointment_status_holdExpiresAt_idx" ON "Appointment"("status", "holdExpiresAt");
