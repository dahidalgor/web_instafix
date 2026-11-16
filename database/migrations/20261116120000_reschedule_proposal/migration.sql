-- Propuesta de nuevo horario del técnico al cliente (WhatsApp con botones). Solo agrega
-- columnas opcionales.
ALTER TABLE "Appointment" ADD COLUMN "proposedStartsAt" TIMESTAMP(3);
ALTER TABLE "Appointment" ADD COLUMN "proposedById" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "proposalSentAt" TIMESTAMP(3);
ALTER TABLE "Appointment" ADD COLUMN "proposalExpiresAt" TIMESTAMP(3);
