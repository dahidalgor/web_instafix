-- WhatsApp: WasapFlow → Bird. Nombres neutrales sin perder historial.

-- Envíos automáticos: id del mensaje en el proveedor + proveedor.
ALTER TABLE "AutomationJob" RENAME COLUMN "providerId" TO "providerMessageId";
ALTER INDEX "AutomationJob_providerId_key" RENAME TO "AutomationJob_providerMessageId_key";
ALTER TABLE "AutomationJob" ADD COLUMN "provider" TEXT;
UPDATE "AutomationJob" SET "provider" = 'WASAPFLOW' WHERE "providerMessageId" IS NOT NULL;
-- Estados de entrega normalizados (sent → SENT…).
UPDATE "AutomationJob" SET "deliveryStatus" = upper("deliveryStatus") WHERE "deliveryStatus" IS NOT NULL;

-- Historial de chat.
ALTER TABLE "WhatsAppMessage" RENAME COLUMN "wabaId" TO "accountId";
ALTER TABLE "WhatsAppMessage" RENAME COLUMN "messageId" TO "providerMessageId";
ALTER TABLE "WhatsAppMessage" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'BIRD';
UPDATE "WhatsAppMessage" SET "provider" = 'WASAPFLOW';
ALTER INDEX "WhatsAppMessage_wabaId_phone_source_occurredAt_idx" RENAME TO "WhatsAppMessage_accountId_phone_source_occurredAt_idx";
CREATE INDEX "WhatsAppMessage_occurredAt_idx" ON "WhatsAppMessage"("occurredAt");

-- Contactos sincronizados por WasapFlow: se conservan como historial.
ALTER TABLE "WhatsAppContact" RENAME COLUMN "wabaId" TO "accountId";

-- Bandeja de webhooks: neutral. Lo pendiente de WasapFlow ya no se procesará.
ALTER TABLE "BridgeWebhook" RENAME TO "WhatsAppWebhook";
ALTER INDEX "BridgeWebhook_pkey" RENAME TO "WhatsAppWebhook_pkey";
ALTER INDEX "BridgeWebhook_status_createdAt_idx" RENAME TO "WhatsAppWebhook_status_createdAt_idx";
ALTER TABLE "WhatsAppWebhook" RENAME COLUMN "wabaId" TO "accountId";
ALTER TABLE "WhatsAppWebhook" ALTER COLUMN "accountId" DROP NOT NULL;
ALTER TABLE "WhatsAppWebhook" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'BIRD';
UPDATE "WhatsAppWebhook" SET "provider" = 'WASAPFLOW';
UPDATE "WhatsAppWebhook" SET "status" = 'DISCARDED' WHERE "status" IN ('PENDING', 'PROCESSING', 'REVIEW');

-- Estado del popup de conexión de WasapFlow (no es historial de mensajes). Bird se conecta
-- una sola vez desde su panel.
DROP TABLE "WhatsAppConnection";
