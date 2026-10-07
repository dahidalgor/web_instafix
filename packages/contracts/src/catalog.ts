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
      .array(
        z
          .object({
            type: z.enum(['image', 'video']),
            url: mediaUrl,
            thumbnail: mediaUrl.optional(),
            poster: mediaUrl.optional(),
            alt: z.string().max(200),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export type OfferingInput = z.infer<typeof offeringSchema>;
export type Offering = OfferingInput & {
  id: string;
  device: string;
  category: string;
  currency: string;
};
