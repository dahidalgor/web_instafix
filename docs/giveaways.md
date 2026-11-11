# Sorteos para clientes

Los sorteos se guardan en la base de datos (`Giveaway`) y se manejan desde **Administración →
Sorteos**. No hay premios ni fechas escritos en el código.

## Reglas

- **Solo uno abierto a la vez.** Para crear otro, primero se cierra el abierto.
- **Abierto** = no se cerró a mano (`closedAt`) y no pasó el final del día del sorteo
  (`drawDate`, fecha de Ecuador). Pasado ese día se cierra solo.
- **Participaciones**: las marca el técnico al completar una visita («Participa por …»). Cada
  visita guarda `giveawayId` y `giveawayEntries`; el trabajo del cliente (`CompletedJob`) copia
  ambos.
- **Servicios que suman** (`eligibleOfferingIds`, opcional): al registrar uno de esos servicios,
  el panel técnico marca la participación solo (una por unidad). El técnico siempre puede
  ajustarla, hasta el máximo por visita del sorteo (`maxEntries`).
- **Sin sorteo abierto**, el panel técnico no muestra la casilla y la API rechaza
  participaciones.
- **Cliente**: «Mi cuenta» muestra sus participaciones y la regla del sorteo mientras siga
  abierto; al cerrarse, dejan de mostrarse (se conservan en la base de datos).

## Administración

| Acción              | Detalle                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nuevo sorteo        | Premio, día del sorteo, cómo se participa (lo ven técnicos y clientes), máximo por visita y servicios que suman.                                               |
| Participantes       | Agrupados por persona (cuenta o teléfono), con sus visitas; descarga en CSV.                                                                                   |
| Corregir una visita | Buscar una visita completada por nombre o teléfono y fijar sus participaciones. Solo con el sorteo abierto y nunca una visita que ya participa en otro sorteo. |
| Cerrar sorteo       | Deja de admitir participaciones y correcciones. Las registradas se conservan.                                                                                  |

Todo queda en la auditoría de administración (`GIVEAWAY_CREATED`, `GIVEAWAY_CLOSED`,
`GIVEAWAY_UPDATED`) y en la actividad de cada cita.

## API

| Método | Ruta                                          | Uso                                             |
| ------ | --------------------------------------------- | ----------------------------------------------- |
| GET    | `/api/v1/admin/giveaways`                     | Sorteos con totales                             |
| POST   | `/api/v1/admin/giveaways`                     | Crear (409 si ya hay uno abierto)               |
| GET    | `/api/v1/admin/giveaways/:id`                 | Participantes                                   |
| POST   | `/api/v1/admin/giveaways/:id/close`           | Cerrar                                          |
| GET    | `/api/v1/admin/giveaways/:id/visits?q=`       | Buscar visitas completadas                      |
| PATCH  | `/api/v1/admin/giveaways/:id/visits/:visitId` | Corregir participaciones                        |
| GET    | `/api/v1/staff/giveaway`                      | Sorteo abierto para el panel técnico (o `null`) |

## Historial

El sorteo de **GTA VI** (antes fijo en el código) pasó a la tabla con la migración
`20261111140000_giveaways`, cerrado al aplicarla y con todas sus participaciones enlazadas.
