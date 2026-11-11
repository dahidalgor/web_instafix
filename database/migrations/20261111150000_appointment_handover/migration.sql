-- Pedido de reemplazo de técnico en una cita confirmada. Solo agrega columnas opcionales.
ALTER TABLE "Appointment" ADD COLUMN "handoverRequestedAt" TIMESTAMP(3);
ALTER TABLE "Appointment" ADD COLUMN "handoverRequestedById" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "handoverReason" TEXT;
