-- Aviso de WhatsApp esperando que Meta apruebe su plantilla. Solo agrega una columna opcional.
ALTER TABLE "AutomationJob" ADD COLUMN "templateWaitSince" TIMESTAMP(3);
