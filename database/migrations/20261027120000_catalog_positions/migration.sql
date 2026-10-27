-- Orden manual del catálogo (aditiva, con valor por defecto: el orden actual por nombre se
-- mantiene hasta que alguien reordene).
ALTER TABLE "Offering" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Equipment" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
