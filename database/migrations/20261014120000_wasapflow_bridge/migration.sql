CREATE TABLE "WhatsAppConnection" (
 "id" TEXT PRIMARY KEY DEFAULT 'main', "wabaId" TEXT, "connectionMode" TEXT,
 "connectedAt" TIMESTAMP(3), "stateHash" TEXT, "stateUserId" TEXT, "stateExpiresAt" TIMESTAMP(3)
);
CREATE TABLE "BridgeWebhook" (
 "id" TEXT PRIMARY KEY, "wabaId" TEXT NOT NULL, "event" TEXT NOT NULL,
 "payload" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "processedAt" TIMESTAMP(3)
);
CREATE INDEX "BridgeWebhook_status_createdAt_idx" ON "BridgeWebhook"("status", "createdAt");
CREATE TABLE "WhatsAppMessage" (
 "wabaId" TEXT NOT NULL, "messageId" TEXT NOT NULL, "phone" TEXT, "bsuid" TEXT,
 "direction" TEXT NOT NULL, "source" TEXT NOT NULL, "type" TEXT NOT NULL, "text" TEXT,
 "occurredAt" TIMESTAMP(3) NOT NULL, "content" JSONB NOT NULL,
 PRIMARY KEY ("wabaId", "messageId")
);
CREATE INDEX "WhatsAppMessage_wabaId_phone_source_occurredAt_idx" ON "WhatsAppMessage"("wabaId", "phone", "source", "occurredAt");
CREATE TABLE "WhatsAppContact" (
 "wabaId" TEXT NOT NULL, "phone" TEXT NOT NULL, "name" TEXT, "removed" BOOLEAN NOT NULL DEFAULT false,
 "occurredAt" TIMESTAMP(3) NOT NULL, PRIMARY KEY ("wabaId", "phone")
);
