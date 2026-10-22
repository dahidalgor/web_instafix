-- Cuentas eliminadas desde administración: se anonimizan (sin teléfono, correo ni contraseña
-- utilizables) y dejan de listarse; las citas y trabajos conservan su historial.
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);
-- Equipos desactivados: sus servicios dejan de aparecer en la página pública.
ALTER TABLE "Equipment" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
