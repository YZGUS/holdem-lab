import type { Card, GameEvent, TableView } from '@holdem/core';

export type PresentationEvent =
  | { key: string; type: 'DEAL_CARDS'; playerIds: string[] }
  | { key: string; type: 'REVEAL_BOARD'; cards: Array<{ card: Card; index: number }> }
  | { key: string; type: 'PLAYER_BET'; playerId: string; amount: number }
  | { key: string; type: 'PLAYER_FOLD'; playerId: string }
  | { key: string; type: 'PLAYER_CHECK'; playerId: string }
  | { key: string; type: 'CHIPS_RETURNED'; playerId: string; amount: number }
  | { key: string; type: 'POT_AWARDED'; playerId: string; amount: number };

function boardOffset(history: GameEvent[], eventIndex: number) {
  return history
    .filter((event) => event.index < eventIndex && event.type === 'STREET_DEALT')
    .reduce((count, event) => count + (event.cards?.length ?? 0), 0);
}

export function toPresentationEvents(events: GameEvent[], history: GameEvent[], table: TableView): PresentationEvent[] {
  return events.flatMap((event): PresentationEvent[] => {
    const key = `${table.handId}:${event.index}`;
    if (event.type === 'HAND_STARTED') {
      return [{ key, type: 'DEAL_CARDS', playerIds: table.players.filter((player) => player.inHand).map((player) => player.id) }];
    }
    if (event.type === 'STREET_DEALT' && event.cards?.length) {
      const offset = boardOffset(history, event.index);
      return [{ key, type: 'REVEAL_BOARD', cards: event.cards.map((card, index) => ({ card, index: offset + index })) }];
    }
    if (event.type === 'BLIND_POSTED' && event.playerId && event.amount) {
      return [{ key, type: 'PLAYER_BET', playerId: event.playerId, amount: event.amount }];
    }
    if (event.type === 'PLAYER_ACTION' && event.playerId && event.action) {
      if (event.action.type === 'FOLD') return [{ key, type: 'PLAYER_FOLD', playerId: event.playerId }];
      if (event.action.type === 'CHECK') return [{ key, type: 'PLAYER_CHECK', playerId: event.playerId }];
      if (event.amount) return [{ key, type: 'PLAYER_BET', playerId: event.playerId, amount: event.amount }];
    }
    if (event.type === 'UNCALLED_RETURN' && event.playerId && event.amount) {
      return [{ key, type: 'CHIPS_RETURNED', playerId: event.playerId, amount: event.amount }];
    }
    if (event.type === 'POT_AWARDED' && event.playerId && event.amount) {
      return [{ key, type: 'POT_AWARDED', playerId: event.playerId, amount: event.amount }];
    }
    return [];
  });
}
