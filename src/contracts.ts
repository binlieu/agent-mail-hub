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
  replyTo: identifier.optional()
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
