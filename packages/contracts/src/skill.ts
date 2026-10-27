import { z } from 'zod';

export const skillMediaTypeSchema = z.enum(['video', 'image', 'text', 'audio', 'general']);
export type SkillMediaType = z.infer<typeof skillMediaTypeSchema>;

export const skillReferenceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/),
  version: z.string().min(1).max(80),
  name: z.string().min(1).max(120).optional(),
});
export type SkillReference = z.infer<typeof skillReferenceSchema>;

export const skillSourceSchema = z.object({
  kind: z.enum(['catalog', 'github']),
  repository: z.string().url(),
  ref: z.string().min(1).max(200).optional(),
  subdir: z.string().max(500).optional(),
  commit: z.string().regex(/^[a-f0-9]{7,64}$/).optional(),
  license: z.string().max(120).optional(),
});
export type SkillSource = z.infer<typeof skillSourceSchema>;

export const skillSummarySchema = z.object({
  id: skillReferenceSchema.shape.id,
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  version: z.string().min(1).max(80),
  category: z.string().min(1).max(80),
  author: z.string().min(1).max(120),
  mediaType: skillMediaTypeSchema,
  installed: z.boolean(),
  favorite: z.boolean(),
  featured: z.boolean().default(false),
  uses: z.number().int().nonnegative().default(0),
  coverUrl: z.string().max(1000).optional(),
  source: skillSourceSchema,
  updatedAt: z.string().datetime(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

export const skillDetailSchema = skillSummarySchema.extend({
  instructions: z.string().max(65_536).optional(),
  usageScenario: z.string().max(2000).optional(),
  inputs: z.string().max(2000).optional(),
  output: z.string().max(2000).optional(),
  files: z.array(z.string().max(500)).max(500).default([]),
  hasScripts: z.boolean().default(false),
});
export type SkillDetail = z.infer<typeof skillDetailSchema>;

export const skillInstallCandidateSchema = z.object({
  candidateId: z.string().min(1).max(500),
  subdir: z.string().max(500),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  version: z.string().min(1).max(80),
  files: z.array(z.string().max(500)).max(500),
  hasScripts: z.boolean(),
  license: z.string().max(120).optional(),
});
export type SkillInstallCandidate = z.infer<typeof skillInstallCandidateSchema>;

export const skillListResultSchema = z.object({
  items: z.array(skillSummarySchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
});
export type SkillListResult = z.infer<typeof skillListResultSchema>;
