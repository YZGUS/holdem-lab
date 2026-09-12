import type { RoomPresence, RoomStatus } from '@holdem/protocol';

export interface RoomLifecyclePlayer {
  id: string;
  kind: 'HUMAN' | 'BOT';
  connected: boolean;
  presence: RoomPresence;
  stack: number;
}

export interface RoomLifecycleState {
  status: RoomStatus;
  turnDeadline: number | null;
  inactiveSince: number | null;
  pauseReason: 'NO_ONLINE_HUMAN' | 'NOT_ENOUGH_PLAYERS' | null;
  players: RoomLifecyclePlayer[];
  game?: {
    phase: string;
  };
}

export type RoomLifecycleEvent =
  | { type: 'PLAYER_CONNECTED'; playerId: string }
  | { type: 'PLAYER_DISCONNECTED'; playerId: string }
  | { type: 'PLAYER_LEFT_TABLE'; playerId: string }
  | { type: 'PLAYER_RETURNED'; playerId: string };

export interface RoomTransition {
  previousStatus: RoomStatus;
  status: RoomStatus;
  paused: boolean;
  resumed: boolean;
}

export class RoomEngine {
  constructor(readonly idleTimeoutMs = 10 * 60 * 1000) {}

  apply(room: RoomLifecycleState, event: RoomLifecycleEvent, now = Date.now()): RoomTransition {
    const player = room.players.find((item) => item.id === event.playerId && item.kind === 'HUMAN');
    if (!player) throw new Error('真人玩家不在房间中');

    if (event.type === 'PLAYER_CONNECTED') player.connected = true;
    if (event.type === 'PLAYER_DISCONNECTED') player.connected = false;
    if (event.type === 'PLAYER_LEFT_TABLE') player.presence = 'AWAY';
    if (event.type === 'PLAYER_RETURNED') {
      player.presence = 'AT_TABLE';
      player.connected = true;
    }
    return this.reconcile(room, now);
  }

  reconcile(room: RoomLifecycleState, now = Date.now()): RoomTransition {
    const previousStatus = room.status;
    const hasOnlinePlayer = room.players.some((player) => player.kind === 'HUMAN' && player.connected && player.presence === 'AT_TABLE');
    const eligiblePlayers = room.players.filter((player) => player.stack > 0 && (player.kind === 'BOT' || player.presence === 'AT_TABLE'));
    const handInProgress = Boolean(room.game && room.game.phase !== 'FINISHED');

    if (!hasOnlinePlayer) {
      room.inactiveSince ??= now;
      room.turnDeadline = null;
      if (room.status === 'PLAYING' || room.status === 'PAUSED') {
        room.status = 'PAUSED';
        room.pauseReason = 'NO_ONLINE_HUMAN';
      }
    } else {
      room.inactiveSince = null;
      if (room.status === 'PLAYING' || room.status === 'PAUSED') {
        if (handInProgress || eligiblePlayers.length >= 2) {
          room.status = 'PLAYING';
          room.pauseReason = null;
        } else {
          room.status = 'PAUSED';
          room.pauseReason = 'NOT_ENOUGH_PLAYERS';
          room.turnDeadline = null;
        }
      }
    }

    return {
      previousStatus,
      status: room.status,
      paused: previousStatus === 'PLAYING' && room.status === 'PAUSED',
      resumed: previousStatus === 'PAUSED' && room.status === 'PLAYING',
    };
  }

  isAtTable(room: RoomLifecycleState, playerId: string) {
    return room.players.some((player) => player.id === playerId && player.kind === 'HUMAN' && player.presence === 'AT_TABLE');
  }

  shouldExpire(room: RoomLifecycleState, now = Date.now()) {
    return room.inactiveSince !== null && now - room.inactiveSince >= this.idleTimeoutMs;
  }

  expiresAt(room: RoomLifecycleState) {
    return room.inactiveSince === null ? null : room.inactiveSince + this.idleTimeoutMs;
  }
}
