-- Nombre/dirección del lugar compartido por WhatsApp. La dirección escrita (address) ya no se
-- sobrescribe con la ubicación: ambas conviven.
ALTER TABLE "Appointment" ADD COLUMN "locationName" TEXT;
