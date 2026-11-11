# Listas largas: carga por partes

Ninguna pantalla trae un historial completo de una vez. Las listas que crecen con el tiempo se
piden por páginas (`?page=N&pageSize=M`, respuesta `{ items, total, page, pageSize }`) y la web
muestra **«Cargar más»** con «Mostrando X de Y».

| Pantalla                         | Qué carga primero                                                                                                                                                                 | Ruta                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Administración → Citas           | 30 citas con los filtros elegidos. Estado, fecha, búsqueda (sin tildes, también por teléfono) y orden se aplican en el servidor; los contadores de cada estado vienen en `counts` | `GET /api/v1/admin/appointments`                        |
| Administración → Trabajos        | Solo las citas activas del cliente elegido                                                                                                                                        | `GET /api/v1/admin/appointments?userId=…&status=active` |
| Panel técnico → Hoy / Próximas   | Solo lo abierto (confirmadas, en servicio y completadas hoy)                                                                                                                      | `GET /api/v1/staff/appointments/me`                     |
| Panel técnico → Historial        | 20 visitas, la más reciente primero; solo al abrir la pestaña                                                                                                                     | `GET /api/v1/staff/appointments/history`                |
| Mi cuenta (cliente) → Próximas   | Las que siguen por delante (máx. 50)                                                                                                                                              | `GET /api/v1/my/appointments`                           |
| Mi cuenta → Historial            | 10 citas; solo al abrirlo                                                                                                                                                         | `GET /api/v1/my/appointments?scope=past`                |
| Mi cuenta → Servicios realizados | 10 servicios; solo al abrirlo                                                                                                                                                     | `GET /api/v1/my/jobs`                                   |
| Mi cuenta → encabezado y sorteo  | Números calculados en el servidor                                                                                                                                                 | `GET /api/v1/my/summary`                                |
| Sistema → WhatsApp               | Los 20 envíos y los 20 mensajes más recientes                                                                                                                                     | `GET /api/v1/admin/whatsapp/jobs`, `…/messages`         |
| Sistema → Correo                 | Los 20 envíos más recientes                                                                                                                                                       | `GET /api/v1/admin/email/logs`                          |
| Usuarios                         | 20 cuentas (ya existía)                                                                                                                                                           | `GET /api/v1/admin/accounts`                            |
| Sorteos → participantes          | 30 personas en pantalla                                                                                                                                                           | (en la web)                                             |
| Servicios (web pública)          | 12 tarjetas del filtro elegido; imágenes con carga diferida                                                                                                                       | (en la web)                                             |
| Estadísticas                     | Sesiones únicas contadas en PostgreSQL (`COUNT(DISTINCT)`), sin traerlas                                                                                                          | `GET /api/v1/admin/analytics`                           |

Valores fuera de rango se corrigen (`pageParams`): página 1–10 000, tamaño 5–100. En la web,
`usePaged` (`apps/web/src/lib/paged.ts`) y `LoadMore` (`components/ui/LoadMore.tsx`).
