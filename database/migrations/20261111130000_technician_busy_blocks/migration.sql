-- Horarios ocupados de los técnicos. Tabla nueva: no cambia ni borra datos existentes.
CREATE TABLE "TechnicianBusyBlock" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "weekday" INTEGER,
    "date" TEXT,
    "validFrom" TEXT,
    "validUntil" TEXT,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TechnicianBusyBlock_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TechnicianBusyBlock_userId_idx" ON "TechnicianBusyBlock"("userId");
ALTER TABLE "TechnicianBusyBlock" ADD CONSTRAINT "TechnicianBusyBlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
