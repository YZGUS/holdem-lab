export type Suit = 's' | 'h' | 'd' | 'c';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export type Card = `${Rank}${Suit}`;
export type Phase = 'PRE_FLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'FINISHED';
export type ActionType = 'FOLD' | 'CHECK' | 'CALL' | 'RAISE' | 'ALL_IN';

export interface PlayerAction {
  type: ActionType;
  raiseTo?: number;
}

export interface PlayerState {
  id: string;
  name: string;
  kind: 'HUMAN' | 'BOT';
  stack: number;
  streetBet: number;
  handBet: number;
  folded: boolean;
  allIn: boolean;
  acted: boolean;
  lastActionBet: number | null;
  holeCards: Card[];
}

export interface HistoryEntry {
  index: number;
  phase: Phase;
  type: 'SYSTEM' | ActionType;
  playerId?: string;
  amount?: number;
  text: string;
}

export interface GameState {
  handId: string;
  version: number;
  phase: Phase;
  dealerIndex: number;
  currentPlayerIndex: number | null;
  smallBlind: number;
  bigBlind: number;
  currentBet: number;
  minRaiseIncrement: number;
  pot: number;
  board: Card[];
  deck: Card[];
  players: PlayerState[];
  history: HistoryEntry[];
  winnerIds: string[];
  resultText?: string;
}

export interface LegalActions {
  types: ActionType[];
  callAmount: number;
  minRaiseTo: number | null;
  maxRaiseTo: number;
}

export interface DecisionContext {
  handId: string;
  version: number;
  phase: Phase;
  playerId: string;
  holeCards: Card[];
  board: Card[];
  pot: number;
  players: Array<Pick<PlayerState, 'id' | 'name' | 'kind' | 'stack' | 'streetBet' | 'handBet' | 'folded' | 'allIn'>>;
  legalActions: LegalActions;
  recentHistory: HistoryEntry[];
}

export interface PlayerView extends Omit<DecisionContext, 'playerId'> {
  currentPlayerId: string | null;
  dealerId: string;
  winnerIds: string[];
  resultText?: string;
  opponentCards?: Card[];
}

export type ApplyResult =
  | { ok: true; state: GameState }
  | { ok: false; state: GameState; error: string };

const ranks: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const suits: Suit[] = ['s', 'h', 'd', 'c'];

function fullDeck(): Card[] {
  return suits.flatMap((suit) => ranks.map((rank) => `${rank}${suit}` as Card));
}

function seededRandom(seed: number) {
  let value = seed >>> 0 || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0x1_0000_0000;
  };
}

function shuffledDeck(seed: number): Card[] {
  const deck = fullDeck();
  const random = seededRandom(seed);
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function addHistory(state: GameState, entry: Omit<HistoryEntry, 'index' | 'phase'>) {
  state.history.push({ ...entry, index: state.history.length, phase: state.phase });
}

function commit(player: PlayerState, amount: number): number {
  const paid = Math.min(player.stack, Math.max(0, amount));
  player.stack -= paid;
  player.streetBet += paid;
  player.handBet += paid;
  player.allIn = player.stack === 0;
  return paid;
}

function nextEligible(state: GameState, from: number): number | null {
  for (let step = 1; step <= state.players.length; step += 1) {
    const index = (from + step) % state.players.length;
    const player = state.players[index];
    if (!player.folded && !player.allIn) return index;
  }
  return null;
}

function nextPhase(phase: Phase): Phase {
  if (phase === 'PRE_FLOP') return 'FLOP';
  if (phase === 'FLOP') return 'TURN';
  if (phase === 'TURN') return 'RIVER';
  return 'SHOWDOWN';
}

function dealStreet(state: GameState, phase: Phase) {
  state.deck.shift();
  const count = phase === 'FLOP' ? 3 : 1;
  state.board.push(...state.deck.splice(0, count));
}

function activePlayers(state: GameState) {
  return state.players.filter((player) => !player.folded);
}

function settleUncontested(state: GameState) {
  const winner = activePlayers(state)[0];
  winner.stack += state.pot;
  state.winnerIds = [winner.id];
  state.resultText = `${winner.name} 赢得 ${state.pot}`;
  addHistory(state, { type: 'SYSTEM', text: state.resultText, amount: state.pot });
  state.pot = 0;
  state.phase = 'FINISHED';
  state.currentPlayerIndex = null;
}

function rankValue(card: Card) {
  return ranks.indexOf(card[0] as Rank) + 2;
}

function fiveCardScore(cards: Card[]): number[] {
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every((card) => card[1] === cards[0][1]);
  const unique = [...new Set(values)];
  if (unique[0] === 14) unique.push(1);
  let straightHigh = 0;
  for (let index = 0; index <= unique.length - 5; index += 1) {
    if (unique[index] - unique[index + 4] === 4) {
      straightHigh = unique[index];
      break;
    }
  }
  if (flush && straightHigh) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...values];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map(([value]) => value).sort((a, b) => b - a)];
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairs = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    return [2, ...pairs, groups.find(([, count]) => count === 1)![0]];
  }
  if (groups[0][1] === 2) return [1, groups[0][0], ...groups.slice(1).map(([value]) => value).sort((a, b) => b - a)];
  return [0, ...values];
}

function compareScores(a: number[], b: number[]) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function bestScore(cards: Card[]) {
  let best: number[] = [];
  for (let a = 0; a < cards.length - 4; a += 1)
    for (let b = a + 1; b < cards.length - 3; b += 1)
      for (let c = b + 1; c < cards.length - 2; c += 1)
        for (let d = c + 1; d < cards.length - 1; d += 1)
          for (let e = d + 1; e < cards.length; e += 1) {
            const score = fiveCardScore([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best.length || compareScores(score, best) > 0) best = score;
          }
  return best;
}

function showdown(state: GameState) {
  state.phase = 'SHOWDOWN';
  const contenders = activePlayers(state);
  const scores = contenders.map((player) => ({ player, score: bestScore([...player.holeCards, ...state.board]) }));
  scores.sort((a, b) => compareScores(b.score, a.score));
  const winners = scores.filter(({ score }) => compareScores(score, scores[0].score) === 0).map(({ player }) => player);
  const share = Math.floor(state.pot / winners.length);
  let remainder = state.pot % winners.length;
  const awardOrder = [...winners].sort((a, b) => {
    const ai = state.players.indexOf(a);
    const bi = state.players.indexOf(b);
    return ((ai - state.dealerIndex - 1 + state.players.length) % state.players.length) - ((bi - state.dealerIndex - 1 + state.players.length) % state.players.length);
  });
  awardOrder.forEach((winner) => {
    winner.stack += share + (remainder > 0 ? 1 : 0);
    remainder -= remainder > 0 ? 1 : 0;
  });
  state.winnerIds = winners.map(({ id }) => id);
  state.resultText = winners.length === 1 ? `${winners[0].name} 赢得 ${state.pot}` : `${winners.map(({ name }) => name).join('、')} 平分 ${state.pot}`;
  addHistory(state, { type: 'SYSTEM', text: state.resultText, amount: state.pot });
  state.pot = 0;
  state.phase = 'FINISHED';
  state.currentPlayerIndex = null;
}

function advanceOrShowdown(state: GameState) {
  const actionable = activePlayers(state).filter((player) => !player.allIn);
  const settled = actionable.every((player) => player.acted && player.streetBet === state.currentBet);
  if (!settled && actionable.length > 0) return false;
  if (state.phase === 'RIVER') {
    showdown(state);
    return true;
  }
  do {
    state.phase = nextPhase(state.phase);
    dealStreet(state, state.phase);
    addHistory(state, { type: 'SYSTEM', text: `进入 ${state.phase}` });
  } while (actionable.length <= 1 && state.phase !== 'RIVER');
  if (actionable.length <= 1) {
    showdown(state);
    return true;
  }
  state.players.forEach((player) => {
    player.streetBet = 0;
    player.acted = player.folded || player.allIn;
    player.lastActionBet = null;
  });
  state.currentBet = 0;
  state.minRaiseIncrement = state.bigBlind;
  state.currentPlayerIndex = nextEligible(state, state.dealerIndex);
  return true;
}

export function createHeadsUpGame(seed: number, handNumber = 1, stacks: [number, number] = [2000, 2000]): GameState {
  const deck = shuffledDeck(seed);
  const dealerIndex = (handNumber - 1) % 2;
  const players: PlayerState[] = [
    { id: 'hero', name: '你', kind: 'HUMAN', stack: stacks[0], streetBet: 0, handBet: 0, folded: false, allIn: false, acted: false, lastActionBet: null, holeCards: [] },
    { id: 'nova', name: 'Nova', kind: 'BOT', stack: stacks[1], streetBet: 0, handBet: 0, folded: false, allIn: false, acted: false, lastActionBet: null, holeCards: [] },
  ];
  for (let round = 0; round < 2; round += 1) {
    players.forEach((player) => player.holeCards.push(deck.shift()!));
  }
  const state: GameState = {
    handId: `hand-${handNumber}`,
    version: 1,
    phase: 'PRE_FLOP',
    dealerIndex,
    currentPlayerIndex: dealerIndex,
    smallBlind: 10,
    bigBlind: 20,
    currentBet: 20,
    minRaiseIncrement: 20,
    pot: 0,
    board: [],
    deck,
    players,
    history: [],
    winnerIds: [],
  };
  const smallBlindPlayer = players[dealerIndex];
  const bigBlindPlayer = players[(dealerIndex + 1) % 2];
  state.pot += commit(smallBlindPlayer, state.smallBlind);
  state.pot += commit(bigBlindPlayer, state.bigBlind);
  addHistory(state, { type: 'SYSTEM', text: `${smallBlindPlayer.name} 下小盲 ${smallBlindPlayer.streetBet}` });
  addHistory(state, { type: 'SYSTEM', text: `${bigBlindPlayer.name} 下大盲 ${bigBlindPlayer.streetBet}` });
  return state;
}

export function legalActions(state: GameState, playerIndex: number): LegalActions {
  const player = state.players[playerIndex];
  const empty: LegalActions = { types: [], callAmount: 0, minRaiseTo: null, maxRaiseTo: 0 };
  if (state.currentPlayerIndex !== playerIndex || state.phase === 'FINISHED' || player.folded || player.allIn) return empty;
  const callAmount = Math.min(player.stack, Math.max(0, state.currentBet - player.streetBet));
  const maxRaiseTo = player.streetBet + player.stack;
  const minRaiseTo = state.currentBet + state.minRaiseIncrement;
  const raiseReopened = player.lastActionBet === null || state.currentBet - player.lastActionBet >= state.minRaiseIncrement;
  const types: ActionType[] = ['FOLD'];
  types.push(callAmount === 0 ? 'CHECK' : 'CALL');
  if (maxRaiseTo > state.currentBet && raiseReopened) {
    types.push('ALL_IN');
    if (maxRaiseTo >= minRaiseTo) types.push('RAISE');
  } else if (player.stack > 0 && maxRaiseTo <= state.currentBet) {
    types.push('ALL_IN');
  }
  return { types, callAmount, minRaiseTo: types.includes('RAISE') ? minRaiseTo : null, maxRaiseTo };
}

export function applyAction(source: GameState, action: PlayerAction): ApplyResult {
  const state = JSON.parse(JSON.stringify(source)) as GameState;
  const playerIndex = state.currentPlayerIndex;
  if (playerIndex === null) return { ok: false, state: source, error: '当前没有玩家需要行动' };
  const player = state.players[playerIndex];
  const legal = legalActions(state, playerIndex);
  if (!legal.types.includes(action.type)) return { ok: false, state: source, error: '当前不能执行这个动作' };
  if (action.type === 'FOLD') {
    player.folded = true;
    player.acted = true;
    addHistory(state, { type: 'FOLD', playerId: player.id, text: `${player.name} 弃牌` });
  } else if (action.type === 'CHECK') {
    player.acted = true;
    addHistory(state, { type: 'CHECK', playerId: player.id, text: `${player.name} 过牌` });
  } else if (action.type === 'CALL') {
    const paid = commit(player, legal.callAmount);
    state.pot += paid;
    player.acted = true;
    addHistory(state, { type: 'CALL', playerId: player.id, amount: paid, text: `${player.name} 跟注 ${paid}` });
  } else {
    const raiseTo = action.type === 'ALL_IN' ? legal.maxRaiseTo : action.raiseTo;
    if (raiseTo === undefined || (action.type === 'RAISE' && (raiseTo < (legal.minRaiseTo ?? Infinity) || raiseTo > legal.maxRaiseTo))) {
      return { ok: false, state: source, error: `加注额应在 ${legal.minRaiseTo ?? legal.maxRaiseTo} 到 ${legal.maxRaiseTo} 之间` };
    }
    const previousBet = state.currentBet;
    const paid = commit(player, raiseTo - player.streetBet);
    state.pot += paid;
    if (player.streetBet > previousBet) {
      state.currentBet = player.streetBet;
      const increment = state.currentBet - previousBet;
      if (increment >= state.minRaiseIncrement) state.minRaiseIncrement = increment;
      state.players.forEach((other, index) => {
        if (index !== playerIndex && !other.folded && !other.allIn) other.acted = false;
      });
    }
    player.acted = true;
    addHistory(state, { type: action.type, playerId: player.id, amount: player.streetBet, text: `${player.name}${action.type === 'ALL_IN' ? ' 全下到 ' : ' 加注到 '}${player.streetBet}` });
  }
  player.lastActionBet = state.currentBet;

  if (activePlayers(state).length === 1) settleUncontested(state);
  else if (!advanceOrShowdown(state)) state.currentPlayerIndex = nextEligible(state, playerIndex);
  state.version += 1;
  return { ok: true, state };
}

export function decisionContext(state: GameState, playerId: string): DecisionContext {
  const playerIndex = state.players.findIndex((player) => player.id === playerId);
  if (playerIndex < 0) throw new Error('玩家不存在');
  return {
    handId: state.handId,
    version: state.version,
    phase: state.phase,
    playerId,
    holeCards: [...state.players[playerIndex].holeCards],
    board: [...state.board],
    pot: state.pot,
    players: state.players.map(({ holeCards: _hidden, acted: _acted, lastActionBet: _lastActionBet, ...player }) => player),
    legalActions: legalActions(state, playerIndex),
    recentHistory: state.history.slice(-12),
  };
}

export function playerView(state: GameState, playerId: string): PlayerView {
  const context = decisionContext(state, playerId);
  const opponent = state.players.find((player) => player.id !== playerId);
  return {
    handId: context.handId,
    version: context.version,
    phase: context.phase,
    holeCards: context.holeCards,
    board: context.board,
    pot: context.pot,
    players: context.players,
    legalActions: context.legalActions,
    recentHistory: context.recentHistory,
    currentPlayerId: state.currentPlayerIndex === null ? null : state.players[state.currentPlayerIndex].id,
    dealerId: state.players[state.dealerIndex].id,
    winnerIds: [...state.winnerIds],
    resultText: state.resultText,
    opponentCards: state.phase === 'FINISHED' && activePlayers(state).length > 1 ? [...opponent!.holeCards] : undefined,
  };
}
