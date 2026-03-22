import { z } from "zod";

export const chatRequestSchema = z.object({
  input: z.union([z.string().min(1), z.array(z.unknown())]),
  sessionId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  skillNames: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  toolChoice: z.unknown().optional(),
});

export const memoryFeedbackSchema = z.object({
  content: z.string().min(1),
  category: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
});

export const memoryListQuerySchema = z.object({
  sessionId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const chainRequestSchema = z.object({
  input: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  skillChain: z.array(z.string().min(1)).min(1).max(8),
  metadata: z.record(z.string(), z.unknown()).optional(),
  plannerHint: z.string().min(1).optional(),
  summarizerHint: z.string().min(1).optional(),
  toolChoice: z.unknown().optional(),
});

export type ChatRequestInput = z.infer<typeof chatRequestSchema>;
export type ChainRequestInput = z.infer<typeof chainRequestSchema>;
