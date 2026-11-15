import { z } from 'zod';

/**
 * Automation definition (linear sequence). Drafts may be incomplete; publish validates
 * strictly and freezes a version with template versions pinned.
 * Deferred by design (see guide §10): branches, reply conditions, business-hour windows.
 */
export const TriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('list_joined'), list_id: z.string().uuid() }),
  z.object({ type: z.literal('contact_created') }),
  z.object({ type: z.literal('event'), event_name: z.string().min(1).max(100) }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

const StepId = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/, 'step id: letters, digits, _ or -');

export const StepSchema = z.discriminatedUnion('type', [
  z.object({
    id: StepId,
    type: z.literal('wait'),
    amount: z.number().int().positive().max(10_000),
    unit: z.enum(['minutes', 'hours', 'days']),
  }),
  z.object({ id: StepId, type: z.literal('email'), template_id: z.string().uuid() }),
]);
export type Step = z.infer<typeof StepSchema>;

export const DefinitionSchema = z.object({
  trigger: TriggerSchema.nullable().default(null),
  mailbox_id: z.string().uuid().nullable().default(null),
  /** marketing: requires opted-in consent + honours unsubscribes. transactional: account notices. */
  message_kind: z.enum(['marketing', 'transactional']).default('marketing'),
  /** once: a contact can enter this automation one time. after_exit: may re-enter after finishing. */
  reentry: z.enum(['once', 'after_exit']).default('once'),
  steps: z
    .array(StepSchema)
    .max(50)
    .default([])
    .refine((steps) => new Set(steps.map((s) => s.id)).size === steps.length, 'step ids must be unique'),
});
export type Definition = z.infer<typeof DefinitionSchema>;

export const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
export const waitMs = (s: Extract<Step, { type: 'wait' }>) => s.amount * UNIT_MS[s.unit];
