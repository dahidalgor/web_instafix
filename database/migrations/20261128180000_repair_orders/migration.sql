-- Trabajos de taller (equipos que el técnico se lleva desde una visita). Solo tablas y columnas nuevas.
CREATE TABLE "RepairOrder" (
    "id" TEXT NOT NULL,
    "code" SERIAL NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "reportedFault" TEXT NOT NULL,
    "intakeCondition" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "receivedById" TEXT,
    "quoteMinor" INTEGER,
    "quoteNote" TEXT,
    "quotedAt" TIMESTAMP(3),
    "quoteAnswer" TEXT,
    "quoteAnsweredVia" TEXT,
    "quoteAnsweredAt" TIMESTAMP(3),
    "finalMinor" INTEGER,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RepairOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RepairOrder_code_key" ON "RepairOrder"("code");
CREATE INDEX "RepairOrder_status_createdAt_idx" ON "RepairOrder"("status", "createdAt");
CREATE INDEX "RepairOrder_appointmentId_idx" ON "RepairOrder"("appointmentId");
ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AutomationJob" ADD COLUMN "repairOrderId" TEXT;
