import { z } from 'zod';
import type { TenantConfig } from '@municipal-assistant/shared';

/** Egy forrás-leíró validációja (melyik adapter, milyen options). */
export const sourceDescriptorSchema = z.object({
  adapter: z.string().min(1),
  options: z.record(z.unknown()).default({}),
});

/** A teljes TenantConfig zod-sémája. A merge UTÁN, kész configon validál. */
export const tenantConfigSchema = z.object({
  tenantId: z.string().min(1),
  displayName: z.string().min(1),
  locale: z.string().min(1),

  branding: z.object({
    logoUrl: z.string().url().optional(),
    primaryColor: z.string().optional(),
    welcomeMessage: z.string().min(1),
    disclaimer: z.string().min(1),
  }),

  embed: z.object({
    allowedOrigins: z.array(z.string()).default([]),
  }),

  categories: z.record(z.string()).refine((c) => Object.keys(c).length > 0, {
    message: 'Legalább egy kategória szükséges',
  }),

  sources: z.array(sourceDescriptorSchema),

  rag: z.object({
    topK: z.number().int().positive(),
    minScore: z.number().min(0).max(1),
    embeddingModel: z.string().min(1),
    chatModel: z.string().min(1),
    systemPromptTemplate: z.string().min(1),
  }),

  limits: z.object({
    maxQuestionChars: z.number().int().positive(),
    requestsPerMinutePerIp: z.number().int().positive(),
  }),
});

// Fordításidejű garancia, hogy a séma kimenete megfelel a shared típusnak.
type SchemaOutput = z.infer<typeof tenantConfigSchema>;
const _typeCheck: TenantConfig = {} as SchemaOutput;
void _typeCheck;
