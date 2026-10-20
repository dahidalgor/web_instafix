-- Categorías de servicio: nivel superior a equipo (Categoría → Equipo → Servicio).
CREATE TABLE "ServiceCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ServiceCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ServiceCategory_name_key" ON "ServiceCategory"("name");

-- Las categorías de texto que ya tenían los equipos pasan a ser registros.
-- «Consolas» se renombra a «Consolas de Videojuegos» (se puede cambiar en administración).
INSERT INTO "ServiceCategory" ("id", "name", "position")
SELECT md5('category:' || name), name, (row_number() OVER (ORDER BY name))::int - 1
FROM (
  SELECT DISTINCT CASE WHEN trim("category") = 'Consolas' THEN 'Consolas de Videojuegos' ELSE trim("category") END AS name
  FROM "Equipment"
) AS existing;

ALTER TABLE "Equipment" ADD COLUMN "categoryId" TEXT;
UPDATE "Equipment" AS e
SET "categoryId" = c."id"
FROM "ServiceCategory" AS c
WHERE c."name" = CASE WHEN trim(e."category") = 'Consolas' THEN 'Consolas de Videojuegos' ELSE trim(e."category") END;
ALTER TABLE "Equipment" ALTER COLUMN "categoryId" SET NOT NULL;
ALTER TABLE "Equipment" DROP COLUMN "category";
CREATE INDEX "Equipment_categoryId_idx" ON "Equipment"("categoryId");
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ServiceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Copia del nombre de categoría en los servicios (se muestra en el catálogo público).
UPDATE "Offering" AS o
SET "category" = c."name"
FROM "Equipment" AS e
JOIN "ServiceCategory" AS c ON c."id" = e."categoryId"
WHERE o."equipmentId" = e."id";
UPDATE "Offering" SET "category" = 'Consolas de Videojuegos' WHERE "equipmentId" IS NULL AND trim("category") = 'Consolas';
