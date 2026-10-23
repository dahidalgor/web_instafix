-- Sorteo: participaciones por visita (aditiva, con valor por defecto; no modifica datos existentes).
ALTER TABLE "Appointment" ADD COLUMN "giveawayEntries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CompletedJob" ADD COLUMN "giveawayEntries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_giveawayEntries_check" CHECK ("giveawayEntries" BETWEEN 0 AND 20);
ALTER TABLE "CompletedJob"
  ADD CONSTRAINT "CompletedJob_giveawayEntries_check" CHECK ("giveawayEntries" BETWEEN 0 AND 20);
