import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { AccountController } from '../account/account.controller';
import { SecurityController } from '../account/security.controller';
import { AppModule } from '../app.module';
import { AuthController } from '../auth/auth.controller';
import { VerificationService } from '../auth/verification.service';
import { WhatsAppAdminController } from '../whatsapp/admin.controller';
import { WhatsAppOnboardingService } from '../whatsapp/onboarding.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { WhatsAppWorker } from '../whatsapp/worker';

// La API se ejecuta con tsx (esbuild), que no emite design:paramtypes. Sin @Inject explícito
// Nest inyecta undefined sin avisar: esta prueba arranca el módulo real y lo detecta.
test('every constructor dependency is injected when running under tsx', async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const checks: [unknown, string][] = [
      [app.get(AuthController), 'verification'],
      [app.get(SecurityController), 'verification'],
      [app.get(VerificationService), 'provider'],
      [app.get(WhatsAppWorker), 'whatsapp'],
      [app.get(WhatsAppService), 'bridge'],
      [app.get(WhatsAppOnboardingService), 'bridge'],
      [app.get(WhatsAppAdminController), 'onboarding'],
    ];
    for (const [instance, key] of checks)
      assert.ok(
        (instance as Record<string, unknown>)[key],
        `${(instance as object).constructor.name}.${key}`,
      );
    assert.ok(app.get(AccountController));
  } finally {
    await app.close();
  }
});
