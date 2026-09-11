import { describe, expect, it } from 'vitest';
import { applyAction, createHeadsUpGame, legalActions, type GameState, type PlayerAction } from './index';

function act(state: GameState, action: PlayerAction) {
  const result = applyAction(state, action);
  expect(result.ok).toBe(true);
  return result.state;
}

describe('heads-up rules', () => {
  it('plays a deterministic checked hand through showdown without losing chips or duplicating cards', () => {
    let state = createHeadsUpGame(42);
    state = act(state, { type: 'CALL' });
    state = act(state, { type: 'CHECK' });
    for (let street = 0; street < 3; street += 1) {
      state = act(state, { type: 'CHECK' });
      state = act(state, { type: 'CHECK' });
    }
    const dealt = [...state.board, ...state.players.flatMap((player) => player.holeCards), ...state.deck];
    expect(state.phase).toBe('FINISHED');
    expect(state.board).toHaveLength(5);
    expect(state.players.reduce((sum, player) => sum + player.stack, 0)).toBe(4000);
    expect(new Set(dealt).size).toBe(dealt.length);
  });

  it('does not reopen a full raise after a short all-in', () => {
    let state = createHeadsUpGame(7, 1, [1000, 150]);
    state = act(state, { type: 'RAISE', raiseTo: 100 });
    state = act(state, { type: 'ALL_IN' });
    const legal = legalActions(state, state.currentPlayerIndex!);
    expect(legal.callAmount).toBe(50);
    expect(legal.types).toEqual(['FOLD', 'CALL']);
  });
});
