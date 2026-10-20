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
    page: z.enum(publicPages),
    activeSeconds: z.number().int().min(0).max(14400),
  })
  .strict();
export type AnalyticsSummary = {
  days: number;
  visits: number;
  sessions: number;
  pages: { page: string; visits: number; averageSeconds: number }[];
};
