import { z } from 'zod';
import { mediaItemSchema } from './catalog';

// «Quiénes somos» y «Cómo funciona» son secciones de Inicio (ver homeSections), no páginas.
export const publicPages = [
  'inicio',
  'servicios',
  'cuenta',
  'ajustes',
  'agenda',
  'garantia',
  'solicitud',
  'contacto',
] as const;
/** Enlaces antiguos o internos que abren Inicio y se desplazan a una de sus secciones. */
export const homeSections = ['quienes-somos', 'nuestro-trabajo', 'como'] as const;
/** Lo que mide Estadísticas: cada página y cada sección de Inicio a la que lleva un enlace. */
export const trackedPages = [...publicPages, ...homeSections] as const;
export type TrackedPage = (typeof trackedPages)[number];
/** Nombres tal como aparecen en la web (menú, pie y botones). */
export const pageLabels: Record<TrackedPage, string> = {
  inicio: 'Inicio',
  servicios: 'Servicios',
  cuenta: 'Mi cuenta',
  ajustes: 'Ajustes de la cuenta',
  agenda: 'Agendar cita',
  garantia: 'Políticas de garantía',
  solicitud: 'Asesoría',
  contacto: 'Contacto',
  'quienes-somos': 'Quiénes somos',
  'nuestro-trabajo': 'Nuestro trabajo',
  como: 'Cómo funciona',
};
export const slideSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    title: z.string().trim().min(3).max(150),
    description: z.string().trim().min(10).max(2000),
    detail: z.string().trim().max(100),
    symbol: z.string().max(4).default('✦'),
    media: z.array(mediaItemSchema).max(1),
    position: z.number().int().min(0).max(1000),
    published: z.boolean(),
  })
  .strict();
export type SiteSlide = z.infer<typeof slideSchema> & { id: string };

export const visitSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    page: z.enum(trackedPages),
    activeSeconds: z.number().int().min(0).max(14400),
  })
  .strict();
export type AnalyticsSummary = {
  days: number;
  visits: number;
  sessions: number;
  pages: { page: string; visits: number; averageSeconds: number }[];
};
