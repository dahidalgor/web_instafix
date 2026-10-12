ALTER TABLE "User" ADD COLUMN "email" TEXT, ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE TABLE "EmailChallenge" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  "name" TEXT,
  "phone" TEXT,
  "passwordHash" TEXT,
  "userId" TEXT,
  CONSTRAINT "EmailChallenge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmailChallenge_email_purpose_createdAt_idx" ON "EmailChallenge"("email", "purpose", "createdAt");
