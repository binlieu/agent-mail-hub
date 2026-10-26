import { z } from 'zod';

export const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const identifier = z.string().uuid();
export const pageSchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});
export const agentSchema = z.object({
  name: slug,
  project: slug.default('default'),
  provider: z.string().trim().max(80).default('unspecified'),
  model: z.string().trim().max(120).default('unspecified'),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(20).default([])
}).strict();
export const messageSchema = z.object({
  to: z.union([slug, z.literal('@human')]),
  body: z.string().trim().min(1).max(16000),
  kind: z.enum(['message', 'question']).default('message'),
  idempotencyKey: z.string().min(1).max(100),
  replyTo: identifier.optional(),
  evidenceIds: z.array(identifier).max(10).refine(ids => new Set(ids).size === ids.length, 'Evidence IDs must be unique').optional()
}).strict();
export const humanMessageSchema = messageSchema.extend({ project: slug });
export const heartbeatSchema = z.object({
  sessionId: identifier,
  host: z.string().trim().min(1).max(100).default('custom'),
  connected: z.boolean().default(true)
}).strict();
export type NewAgent = z.infer<typeof agentSchema>;
export type NewMessage = z.infer<typeof messageSchema>;
export type Page = z.infer<typeof pageSchema>;
export type Actor = { role: 'admin' } | { role: 'agent'; name: string; project: string };
export type AgentCredentials = { version: 1; instanceId: string; url: string; name: string; project: string; token: string };

export class HubError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function requireAdmin(actor: Actor): void {
  if (actor.role !== 'admin') throw new HubError(403, 'Administrator access required');
}

export const evidenceIdsSchema = z.array(identifier).max(10).refine(ids => new Set(ids).size === ids.length, 'Evidence IDs must be unique');
export const evidenceSchema = z.object({
  filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/),
  mediaType: z.enum(['text/plain', 'text/markdown', 'application/json', 'application/octet-stream', 'image/png', 'image/jpeg']).default('text/plain'),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  content: z.string().min(1).max(87384),
  sourceRef: z.string().trim().min(1).max(2000),
  idempotencyKey: z.string().min(1).max(100)
}).strict();
export const evidenceReviewSchema = z.object({
  observedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['received', 'reviewed', 'rejected']),
  note: z.string().trim().min(1).max(4000)
}).strict();
export const handoffSchema = z.object({
  to: slug,
  objective: z.string().trim().min(1).max(2000),
  context: z.string().trim().min(1).max(8000),
  completed: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
  remaining: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  nextSteps: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  workspaceRef: z.string().trim().min(1).max(2000),
  evidenceIds: evidenceIdsSchema.min(1),
  idempotencyKey: z.string().min(1).max(100)
}).strict();
export const handoffUpdateSchema = z.object({
  state: z.enum(['accepted', 'declined', 'completed']),
  note: z.string().trim().min(1).max(4000),
  evidenceIds: evidenceIdsSchema.default([]),
  idempotencyKey: z.string().min(1).max(100)
}).strict();
export type NewEvidence = z.infer<typeof evidenceSchema>;
export type EvidenceReview = z.infer<typeof evidenceReviewSchema>;
export type NewHandoff = z.infer<typeof handoffSchema>;
export type HandoffUpdate = z.infer<typeof handoffUpdateSchema>;
