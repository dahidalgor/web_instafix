-- Equipo técnico, asignación de citas, servicios realizados, auditoría y portada de servicios.
-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'TECHNICIAN';

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "assignedTechnicianId" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedById" TEXT,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedById" TEXT,
ADD COLUMN     "technicianNotes" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Offering" ADD COLUMN     "cover" JSONB;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "AppointmentService" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "offeringId" TEXT,
    "nameSnapshot" TEXT NOT NULL,
    "deviceSnapshot" TEXT NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "totalMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "warrantyDaysSnapshot" INTEGER NOT NULL DEFAULT 0,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentActivity" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppointmentService_offeringId_idx" ON "AppointmentService"("offeringId");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentService_appointmentId_offeringId_key" ON "AppointmentService"("appointmentId", "offeringId");

-- CreateIndex
CREATE INDEX "AppointmentActivity_appointmentId_createdAt_idx" ON "AppointmentActivity"("appointmentId", "createdAt");

-- CreateIndex
CREATE INDEX "Appointment_assignedTechnicianId_startsAt_idx" ON "Appointment"("assignedTechnicianId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_status_startsAt_idx" ON "Appointment"("status", "startsAt");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_assignedTechnicianId_fkey" FOREIGN KEY ("assignedTechnicianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentService" ADD CONSTRAINT "AppointmentService_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentService" ADD CONSTRAINT "AppointmentService_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentService" ADD CONSTRAINT "AppointmentService_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentActivity" ADD CONSTRAINT "AppointmentActivity_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentActivity" ADD CONSTRAINT "AppointmentActivity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Integridad de los servicios realizados: cantidades positivas y total coherente.
ALTER TABLE "AppointmentService"
  ADD CONSTRAINT "AppointmentService_quantity_check" CHECK ("quantity" BETWEEN 1 AND 100),
  ADD CONSTRAINT "AppointmentService_price_check" CHECK ("unitPriceMinor" >= 0),
  ADD CONSTRAINT "AppointmentService_total_check" CHECK ("totalMinor" = "unitPriceMinor" * "quantity");
