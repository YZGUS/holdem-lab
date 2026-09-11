import { z } from 'zod';
import type { PlayerView } from '@holdem/core';

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('FOLD') }),
  z.object({ type: z.literal('CHECK') }),
  z.object({ type: z.literal('CALL') }),
  z.object({ type: z.literal('ALL_IN') }),
  z.object({ type: z.literal('RAISE'), raiseTo: z.number().int().nonnegative() }),
]);

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ACTION'),
    actionId: z.string().min(1).max(100),
    handId: z.string().min(1).max(100),
    expectedVersion: z.number().int().positive(),
    action: actionSchema,
  }),
  z.object({ type: z.literal('NEW_HAND') }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage =
  | { type: 'STATE'; view: PlayerView }
  | { type: 'ERROR'; message: string; view?: PlayerView };
