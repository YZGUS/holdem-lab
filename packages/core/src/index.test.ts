import { describe, expect, it } from 'vitest';
import { applyAction, createGame, evaluateHand, exportReplay, legalActions, potStructure, replayHand, type GameState, type PlayerAction } from './index';

function createTwoPlayerGame(seed: number, handNumber = 1, stacks: [number, number] = [2000, 2000]) {
  return createGame({
    seed,
    handNumber,
    players: [
      { id: 'p1', name: '一号', kind: 'HUMAN', stack: stacks[0] },
      { id: 'p2', name: '二号', kind: 'BOT', stack: stacks[1] },
    ],
  });
}

function act(state: GameState, action: PlayerAction) {
  const result = applyAction(state, action);
  expect(result.ok).toBe(true);
  return result.state;
}

describe('heads-up rules', () => {
  it('describes the ranks that make a pair or two pair', () => {
    expect(evaluateHand(['As', 'Ah', '9c', '6d', '3s']).description).toBe('一对 A');
    expect(evaluateHand(['Ks', 'Kh', 'Jc', 'Jd', '3s']).description).toBe('两对 K、J');
  });

  it('plays a deterministic checked hand through showdown without losing chips or duplicating cards', () => {
    let state = createTwoPlayerGame(42);
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
    let state = createTwoPlayerGame(7, 1, [1000, 150]);
    state = act(state, { type: 'RAISE', raiseTo: 100 });
    state = act(state, { type: 'ALL_IN' });
    const legal = legalActions(state, state.currentPlayerIndex!);
    expect(legal.callAmount).toBe(50);
    expect(legal.types).toEqual(['FOLD', 'CALL']);
  });

  it('settles a three-player all-in with a main pot and side pot', () => {
    let state = createGame({
      seed: 17,
      dealerIndex: 0,
      players: [
        { id: 'p1', name: '一号', kind: 'HUMAN', stack: 50 },
        { id: 'p2', name: '二号', kind: 'HUMAN', stack: 100 },
        { id: 'p3', name: '三号', kind: 'HUMAN', stack: 200 },
      ],
    });
    expect(state.currentPlayerIndex).toBe(0);
    state = act(state, { type: 'ALL_IN' });
    state = act(state, { type: 'ALL_IN' });
    state = act(state, { type: 'CALL' });

    expect(state.phase).toBe('FINISHED');
    expect(potStructure(state).map((pot) => pot.amount)).toEqual([150, 100]);
    expect(state.history.filter((event) => event.type === 'POT_AWARDED')).toHaveLength(2);
    expect(state.players.reduce((sum, player) => sum + player.stack, 0)).toBe(350);
  });

  it('rebuilds a finished hand exactly from its seed and action log', () => {
    let state = createTwoPlayerGame(42);
    state = act(state, { type: 'CALL' });
    state = act(state, { type: 'CHECK' });
    while (state.phase !== 'FINISHED') state = act(state, { type: 'CHECK' });

    const replayed = replayHand(exportReplay(state));
    expect(replayed.board).toEqual(state.board);
    expect(replayed.players.map((player) => player.stack)).toEqual(state.players.map((player) => player.stack));
    expect(replayed.winnerIds).toEqual(state.winnerIds);
    expect(replayed.actions).toEqual(state.actions);
  });

  it('returns the unmatched part of a bet before awarding an uncontested pot', () => {
    const state = act(createTwoPlayerGame(9), { type: 'FOLD' });
    expect(state.resultText).toBe('二号 赢得 20');
    expect(state.players.map((player) => player.stack)).toEqual([1990, 2010]);
    expect(state.history.some((event) => event.type === 'UNCALLED_RETURN' && event.amount === 10)).toBe(true);
  });

  it('runs the board automatically when blinds put every player all-in', () => {
    const state = createTwoPlayerGame(11, 1, [5, 10]);
    expect(state.phase).toBe('FINISHED');
    expect(state.board).toHaveLength(5);
    expect(state.players.reduce((sum, player) => sum + player.stack, 0)).toBe(15);
  });
});
