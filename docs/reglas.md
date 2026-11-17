# Instafix

## Plantillas de WhatsApp (Bird / Meta)

- **Nunca** crear una versión nueva ni enviar a revisión una plantilla que ya se está usando en producción: mientras Meta la revisa, Bird deja de enviar también la versión aprobada y los avisos se cortan (pasó el 16-11-2026).
- Para cambiar una plantilla en uso, crear otra con el siguiente sufijo (`appointment_requested_v2`, `_v3`…), esperar a que Meta la apruebe y recién entonces cambiar su slug en `BIRD_TEMPLATES` (`apps/api/src/whatsapp/bird/bird.provider.ts`) y desplegar.
- No crear ni enviar plantillas a Bird sin la aprobación explícita del usuario y sin mostrarle antes el texto final.
- Procedimiento completo: `docs/whatsapp-setup.md` → «Regla: nunca editar una plantilla en uso».
