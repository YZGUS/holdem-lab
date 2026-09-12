import { z } from 'zod';
import type { HandReplay, PlayerView } from '@holdem/core';

export const PROTOCOL_VERSION = 1;

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('FOLD') }),
  z.object({ type: z.literal('CHECK') }),
  z.object({ type: z.literal('CALL') }),
  z.object({ type: z.literal('ALL_IN') }),
  z.object({ type: z.literal('RAISE'), raiseTo: z.number().int().nonnegative() }),
]);

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('HELLO'), protocolVersion: z.literal(PROTOCOL_VERSION), sessionToken: z.string().min(20).max(200).optional() }),
  z.object({ type: z.literal('LIST_ROOMS') }),
  z.object({
    type: z.literal('CREATE_ROOM'),
    roomName: z.string().trim().min(1).max(30),
    playerName: z.string().trim().min(1).max(16),
    maxPlayers: z.number().int().min(2).max(8),
    botCount: z.number().int().min(0).max(7),
    startingStack: z.number().int().min(200).max(100_000),
    smallBlind: z.number().int().min(1).max(10_000),
    bigBlind: z.number().int().min(2).max(20_000),
    turnSeconds: z.number().int().min(10).max(120),
  }),
  z.object({ type: z.literal('JOIN_ROOM'), roomId: z.string().min(4).max(12), playerName: z.string().trim().min(1).max(16) }),
  z.object({ type: z.literal('LEAVE_ROOM') }),
  z.object({ type: z.literal('START_GAME') }),
  z.object({
    type: z.literal('ACTION'),
    actionId: z.string().min(1).max(100),
    handId: z.string().min(1).max(100),
    expectedVersion: z.number().int().positive(),
    action: actionSchema,
  }),
  z.object({ type: z.literal('NEW_HAND') }),
  z.object({ type: z.literal('GET_REPLAY'), handId: z.string().min(1).max(100) }),
  z.object({
    type: z.literal('RUN_SIMULATION'),
    hands: z.number().int().min(1).max(1_000),
    playerCount: z.number().int().min(2).max(8),
    seed: z.number().int().nonnegative().max(0xffff_ffff),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type RoomStatus = 'WAITING' | 'PLAYING' | 'FINISHED';

export interface RoomPlayerView {
  id: string;
  name: string;
  kind: 'HUMAN' | 'BOT';
  seat: number;
  stack: number;
  connected: boolean;
}

export interface ReplaySummary {
  handId: string;
  handNumber: number;
  resultText: string;
  actionCount: number;
}

export interface RoomSummary {
  id: string;
  name: string;
  status: RoomStatus;
  playerCount: number;
  maxPlayers: number;
  botCount: number;
  smallBlind: number;
  bigBlind: number;
}

export interface RoomView extends RoomSummary {
  hostPlayerId: string;
  viewerPlayerId: string;
  startingStack: number;
  turnSeconds: number;
  turnDeadline: number | null;
  players: RoomPlayerView[];
  replays: ReplaySummary[];
}

export interface SessionView {
  token: string;
  playerId: string;
  name: string;
  roomId?: string;
}

export interface SimulationReport {
  hands: number;
  playerCount: number;
  seed: number;
  totalActions: number;
  averageActions: number;
  wins: Record<string, number>;
}

export type ServerMessage =
  | { type: 'WELCOME'; session: SessionView; resumed: boolean }
  | { type: 'LOBBY'; rooms: RoomSummary[] }
  | { type: 'ROOM'; room: RoomView; view?: PlayerView }
  | { type: 'REPLAY'; replay: HandReplay }
  | { type: 'SIMULATION_RESULT'; result: SimulationReport }
  | { type: 'ERROR'; message: string; view?: PlayerView };
