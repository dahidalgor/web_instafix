# Organización y mantenimiento del código

## Estructura de la web

```text
apps/web/src/
├── main.tsx                  # Montaje React y selección del acceso administrativo
├── app/                      # Navegación y composición de páginas
├── components/layout/        # Elementos compartidos, como la marca
├── features/
│   ├── home/                 # Presentación inicial
│   ├── about/                # Quiénes somos y slideshow servido por la API
│   ├── catalog/              # Servicios, fichas y disponibilidad
│   ├── account/              # Acceso, citas e historial del cliente
│   ├── booking/              # Calendario Cal.com
│   ├── contact/              # Página pública de contacto
│   ├── analytics/            # Tiempo visible y visitas sin identidad
│   ├── help/                 # Solicitud de asesoría
│   ├── how-it-works/         # Pasos, ilustraciones y animación por scroll
│   ├── media/                # Carrusel, editor y transporte de archivos
│   ├── admin/                # Un componente por pestaña administrativa
│   └── warranty/             # Políticas públicas
├── lib/                      # Cliente HTTP y formato monetario
└── styles/                   # Base, controles, layout, tipografía, tema y accesibilidad
```

Cada funcionalidad reúne sus componentes, datos y CSS. `Admin.tsx` coordina sesión y estado compartido; los formularios viven en `AdminServices`, `AdminEquipment`, `AdminJobs`, `AdminWarranty` y `AdminAppointments`. Las peticiones con progreso de archivos se aíslan en `media/upload-media.ts`.

## Estilos

`styles/index.css` es el único punto de entrada. Declara explícitamente el orden: base, estilos compartidos, funcionalidades, tipografía, tema y accesibilidad. Evitar imports CSS dispersos en componentes porque su orden puede cambiar con la carga diferida.

- Cambios de una página: editar el CSS de su carpeta `features`.
- Controles reutilizables: `styles/controls.css` y `styles/forms.css`.
- Colores, fuentes y valores compartidos: `styles/base.css`.
- Modo oscuro: `styles/theme.css`.
- Tamaños de títulos: `styles/typography.css`.
- Movimiento reducido: `styles/accessibility.css`.

Los estados se expresan con clases o atributos; el JSX no declara estilos visuales inline. Los ajustes de cada breakpoint están agrupados al final del archivo correspondiente. No añadir una nueva hoja de "correcciones" para sobrescribir otra: modificar la regla responsable.

## Estructura de la API

`main.ts` configura y arranca Nest. `app.module.ts` registra los controladores. Los módulos de responsabilidad son `auth`, `account`, `catalog`, `appointments`, `jobs`, `warranties`, `requests`, `media` y `health`.

- `config/environment.ts` carga el entorno y centraliza los orígenes admitidos.
- `database/client.ts` comparte un cliente Prisma entre controladores.
- `auth/session.ts` verifica origen, sesión y permisos. La cuenta del cliente se obtiene siempre de la sesión.
- `media/media.controller.ts` autoriza las subidas y sirve archivos locales; `media-processor.ts` valida y convierte; `media-storage.ts` guarda en disco o R2.
- `whatsapp/` contiene el módulo de WasapFlow, onboarding Coexistence, cola y recepción; `integrations/` mantiene Cal.com y la verificación de firmas. Consulta [la guía](whatsapp-setup.md).
- `booking/` genera referencias de cuenta para Cal; `site/` administra diapositivas; `analytics/` recibe y agrega métricas públicas.
- `scripts/` contiene tareas manuales para crear el administrador y cargar el catálogo.
- `tests/` contiene las pruebas unitarias y de integración.

La API utiliza el prefijo `/api/v1`. Los cambios de estructura de PostgreSQL se aplican con migraciones incrementales; consultar [las novedades del sitio](site-experience.md).

## Contratos compartidos

`packages/contracts/src` separa los esquemas de catálogo, cuentas, autenticación, citas y solicitudes. `index.ts` conserva los exports públicos para que web y API compartan las mismas validaciones.

## Rutina de trabajo

```sh
pnpm format              # Formatear código, CSS y documentación
pnpm format:check        # Verificar sin modificar archivos
pnpm imports:organize    # Ordenar imports y eliminar los no utilizados
pnpm build              # Comprobar tipos y compilar web/API
pnpm test               # Pruebas que no escriben en PostgreSQL
```

Con la API local encendida y una base de desarrollo configurada:

```sh
INSTAFIX_INTEGRATION=1 pnpm --filter @instafix/api exec tsx --test src/tests/appointments.integration.test.ts src/tests/media.integration.test.ts
```

Las pruebas de integración crean datos temporales identificados y los retiran al terminar. No ejecutarlas contra producción. La configuración local sigue en `.env`, excluida del repositorio y de la imagen Docker.

Comentar los motivos de una decisión, los límites de seguridad y las integraciones externas. Evitar comentarios que solo repitan lo que ya dice el código.
