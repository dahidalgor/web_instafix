CREATE TYPE "AppointmentStatus" AS ENUM ('PENDING_LOCATION', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TABLE "Appointment" (
 "id" TEXT NOT NULL,
 "userId" TEXT NOT NULL,
 "title" TEXT NOT NULL,
 "device" TEXT NOT NULL,
 "startsAt" TIMESTAMP(3) NOT NULL,
 "endsAt" TIMESTAMP(3) NOT NULL,
 "timeZone" TEXT NOT NULL DEFAULT 'America/Guayaquil',
 "address" TEXT NOT NULL,
 "technician" TEXT NOT NULL,
 "status" "AppointmentStatus" NOT NULL DEFAULT 'PENDING_LOCATION',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "Appointment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "Appointment_dates_check" CHECK ("endsAt" > "startsAt")
);
CREATE INDEX "Appointment_userId_startsAt_idx" ON "Appointment"("userId", "startsAt");
