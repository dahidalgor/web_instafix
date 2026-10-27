import { z } from 'zod';
const mediaUrl = z
  .string()
  .max(2000)
  .refine(
    (value) =>
      /^\/api\/v1\/media\/[a-f0-9-]{36}(?:-small|-poster)?\.(webp|mp4)$/.test(value) ||
      (() => {
        try {
          return new URL(value).protocol === 'https:';
        } catch {
          return false;
        }
      })(),
    'Usa un archivo subido o una URL HTTPS',
  );
export const mediaItemSchema = z
  .object({
    type: z.enum(['image', 'video']),
    url: mediaUrl,
    thumbnail: mediaUrl.optional(),
    poster: mediaUrl.optional(),
    alt: z.string().max(200),
  })
  .strict();
export type MediaItem = z.infer<typeof mediaItemSchema>;

export const MAX_VIDEOS = 2;
export const videoLimitMessage = `Cada servicio admite como máximo ${MAX_VIDEOS} videos.`;
export const videoSpacingMessage = 'Los videos deben estar separados por al menos una imagen.';
/** Regla del carrusel compartida por el panel y la API (la API es la autoridad). */
export function mediaProblem(media: { type: 'image' | 'video' }[]): string | null {
  if (media.filter((item) => item.type === 'video').length > MAX_VIDEOS) return videoLimitMessage;
  for (let i = 1; i < media.length; i++)
    if (media[i].type === 'video' && media[i - 1].type === 'video') return videoSpacingMessage;
  return null;
}

/** Portada: una sola imagen, independiente de la galería. */
export const coverSchema = z
  .object({ url: mediaUrl, thumbnail: mediaUrl.optional(), alt: z.string().max(200) })
  .strict()
  .refine((cover) => !/\.mp4$/.test(cover.url), 'La portada debe ser una imagen');
export type ServiceCover = z.infer<typeof coverSchema>;

export const offeringSchema = z
  .object({
    equipmentId: z.string().min(1),
    title: z.string().trim().min(3).max(150),
    description: z.string().trim().min(10).max(5000),
    priceMinor: z.number().int().min(0).max(10000000),
    durationMinutes: z.number().int().min(1).max(1440),
    warrantyDays: z.number().int().min(0).max(3650),
    availability: z.enum(['AVAILABLE', 'UNAVAILABLE', 'COMING_SOON']),
    media: z
      .array(mediaItemSchema)
      .max(12)
      .superRefine((media, ctx) => {
        const problem = mediaProblem(media);
        if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
      }),
    cover: coverSchema.nullable().optional(),
  })
  .strict();
export type OfferingInput = z.infer<typeof offeringSchema>;
export type Offering = OfferingInput & {
  cover?: ServiceCover | null;
  id: string;
  device: string;
  category: string;
  currency: string;
  /** Orden dentro de su equipo (lo fija Administración arrastrando). */
  position?: number;
};

/** Imagen que representa al servicio: portada propia o, en servicios antiguos, la primera foto. */
export function serviceCover(offering: Pick<Offering, 'cover' | 'media'>) {
  if (offering.cover) return offering.cover;
  const image = offering.media.find((item) => item.type === 'image');
  return image ? { url: image.url, thumbnail: image.thumbnail, alt: image.alt } : null;
}

/** Nivel superior del catálogo: categoría → equipo → servicio. */
const catalogName = z.string().trim().min(2, 'Mínimo 2 caracteres').max(80, 'Máximo 80 caracteres');
export const categoryInputSchema = z
  .object({ name: catalogName, position: z.number().int().min(0).max(1000).optional() })
  .strict();
export const categoryUpdateSchema = categoryInputSchema.partial().strict();
export const equipmentInputSchema = z
  .object({ name: catalogName, categoryId: z.string().min(1, 'Elige una categoría') })
  .strict();
export const equipmentUpdateSchema = equipmentInputSchema
  .partial()
  .extend({ active: z.boolean().optional() })
  .strict();
export type ServiceCategory = { id: string; name: string; position: number };
export type CatalogEquipment = {
  id: string;
  name: string;
  categoryId: string;
  category: string;
  /** Solo en administración: un equipo desactivado no se publica. */
  active?: boolean;
  /** Orden dentro de su categoría. */
  position?: number;
};
/** Nuevo orden completo de una lista (todos sus elementos, sin repetir). */
export const reorderSchema = z
  .object({ ids: z.array(z.string().min(1).max(100)).min(1).max(500) })
  .strict();
