-- Sorteos guardados en la base de datos (antes, un único sorteo fijo en el código).
-- Aditiva: tabla nueva y columnas opcionales. El sorteo de GTA VI pasa a la tabla, cerrado, y
-- sus participaciones quedan enlazadas a él (no se borra ni se cambia ninguna participación).
CREATE TABLE "Giveaway" (
    "id" TEXT NOT NULL,
    "prize" TEXT NOT NULL,
    "drawDate" TEXT NOT NULL,
    "entryRule" TEXT NOT NULL,
    "maxEntries" INTEGER NOT NULL DEFAULT 20,
    "eligibleOfferingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "Giveaway_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Appointment" ADD COLUMN "giveawayId" TEXT;
ALTER TABLE "CompletedJob" ADD COLUMN "giveawayId" TEXT;
CREATE INDEX "Appointment_giveawayId_status_idx" ON "Appointment"("giveawayId", "status");
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_giveawayId_fkey" FOREIGN KEY ("giveawayId") REFERENCES "Giveaway"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CompletedJob" ADD CONSTRAINT "CompletedJob_giveawayId_fkey" FOREIGN KEY ("giveawayId") REFERENCES "Giveaway"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Sorteo de GTA VI: cerrado al aplicar esta migración.
INSERT INTO "Giveaway" ("id", "prize", "drawDate", "entryRule", "maxEntries", "closedAt")
VALUES (
    'gta-vi-2026',
    'GTA VI',
    '2026-11-18',
    'Una participación por cada mando DualSense con par de joysticks magnéticos.',
    20,
    CURRENT_TIMESTAMP
);
UPDATE "Appointment" SET "giveawayId" = 'gta-vi-2026' WHERE "giveawayEntries" > 0;
UPDATE "CompletedJob" SET "giveawayId" = 'gta-vi-2026' WHERE "giveawayEntries" > 0;
