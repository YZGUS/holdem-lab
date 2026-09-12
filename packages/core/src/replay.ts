import { applyAction, createGame, foldPlayer } from './engine.js';
import type { GameState, HandReplay } from './types.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function exportReplay(state: GameState): HandReplay {
  return {
    schemaVersion: 1,
    handId: state.handId,
    setup: clone(state.setup),
    actions: clone(state.actions),
    resultText: state.resultText,
    winnerIds: [...state.winnerIds],
  };
}

export function replayHand(replay: HandReplay, actionCount = replay.actions.length): GameState {
  if (replay.schemaVersion !== 1) throw new Error('不支持的回放版本');
  let state = createGame({ ...clone(replay.setup), players: clone(replay.setup.players) });
  for (const recorded of replay.actions.slice(0, Math.max(0, actionCount))) {
    const current = state.currentPlayerIndex === null ? null : state.players[state.currentPlayerIndex];
    const result = current?.id === recorded.playerId
      ? applyAction(state, recorded.action)
      : recorded.action.type === 'FOLD'
        ? foldPlayer(state, recorded.playerId)
        : { ok: false as const, state, error: `动作顺序无效：${recorded.playerId}` };
    if (!result.ok) throw new Error(`回放动作无效：${result.error}`);
    state = result.state;
  }
  return state;
}
