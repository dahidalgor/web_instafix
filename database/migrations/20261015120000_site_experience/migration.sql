ALTER TABLE "User" ADD COLUMN "firstName" TEXT, ADD COLUMN "lastName" TEXT;
ALTER TABLE "EmailChallenge" ADD COLUMN "firstName" TEXT, ADD COLUMN "lastName" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "offeringId" TEXT REFERENCES "Offering"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CompletedJob" ADD COLUMN "offeringId" TEXT REFERENCES "Offering"("id") ON DELETE SET NULL ON UPDATE CASCADE,
 ADD COLUMN "appointmentId" TEXT REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "CompletedJob_appointmentId_key" ON "CompletedJob"("appointmentId");
CREATE TABLE "BookingIntent" (
 "tokenHash" TEXT PRIMARY KEY, "userId" TEXT REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "expiresAt" TIMESTAMP(3) NOT NULL,
 "calUid" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "BookingIntent_calUid_key" ON "BookingIntent"("calUid");
CREATE INDEX "BookingIntent_expiresAt_idx" ON "BookingIntent"("expiresAt");
CREATE TABLE "SiteSlide" (
 "id" TEXT PRIMARY KEY, "label" TEXT NOT NULL, "title" TEXT NOT NULL, "description" TEXT NOT NULL,
 "detail" TEXT NOT NULL, "symbol" TEXT NOT NULL DEFAULT '✦', "media" JSONB NOT NULL DEFAULT '[]',
 "position" INTEGER NOT NULL DEFAULT 0, "published" BOOLEAN NOT NULL DEFAULT false,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "PageVisit" (
 "id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "page" TEXT NOT NULL,
 "activeSeconds" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "PageVisit_createdAt_page_idx" ON "PageVisit"("createdAt", "page");
INSERT INTO "SiteSlide" ("id","label","title","description","detail","symbol","position","published","updatedAt") VALUES ('initial-1','CONSOLAS','Que la próxima partida siga.','Mantenimiento y reparación de PlayStation 4, PlayStation 5 y otras consolas. Cuidamos el equipo que acompaña tus mejores partidas.','PlayStation · Consolas','✚',0,true,CURRENT_TIMESTAMP);
INSERT INTO "SiteSlide" ("id","label","title","description","detail","symbol","position","published","updatedAt") VALUES ('initial-2','PC Y LAPTOPS','Vuelve a lo que te mueve.','Atención para las computadoras con las que trabajas, estudias y creas. El primer paso es entender qué le sucede a tu equipo.','Computadoras · Hardware','▱',1,true,CURRENT_TIMESTAMP);
INSERT INTO "SiteSlide" ("id","label","title","description","detail","symbol","position","published","updatedAt") VALUES ('initial-3','A DOMICILIO','Más cerca de ti.','Llevamos el servicio técnico hasta tu hogar. Coordinamos contigo por WhatsApp y confirmamos la cita después de recibir tu ubicación y validar disponibilidad.','Atención · Cercanía','⌂',2,true,CURRENT_TIMESTAMP);
