import { compareScores, evaluateHand } from './evaluator.js';
import type {
  ApplyResult, Card, CreateGameOptions, DecisionContext, GameEvent, GameState, LegalActions,
  Phase, PlayerAction, PlayerState, PlayerView, PotSummary, Rank, Suit, TableView,
} from './types.js';

const ranks: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const suits: Suit[] = ['s', 'h', 'd', 'c'];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

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
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
}

function addEvent(state: GameState, event: Omit<GameEvent, 'index' | 'phase'>) {
  state.history.push({ ...event, index: state.history.length, phase: state.phase });
}

function commit(player: PlayerState, amount: number) {
  const paid = Math.min(player.stack, Math.max(0, amount));
  player.stack -= paid;
  player.streetBet += paid;
  player.handBet += paid;
  player.allIn = player.inHand && player.stack === 0;
  return paid;
}

function activePlayers(state: GameState) {
  return state.players.filter((player) => player.inHand && !player.folded);
}

function nextActiveIndex(state: Pick<GameState, 'players'>, from: number, actionableOnly = false): number | null {
  for (let step = 1; step <= state.players.length; step += 1) {
    const index = (from + step) % state.players.length;
    const player = state.players[index];
    if (player.inHand && !player.folded && (!actionableOnly || !player.allIn)) return index;
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
  const cards = state.deck.splice(0, count);
  state.board.push(...cards);
  addEvent(state, { type: 'STREET_DEALT', cards: [...cards], text: `进入 ${phase}` });
}

export function potStructure(state: Pick<GameState, 'players'>): PotSummary[] {
  const levels = [...new Set(state.players.map((player) => player.handBet).filter((amount) => amount > 0))].sort((a, b) => a - b);
  let previous = 0;
  return levels.map((level) => {
    const contributors = state.players.filter((player) => player.handBet >= level);
    const pot: PotSummary = {
      amount: (level - previous) * contributors.length,
      eligiblePlayerIds: contributors.filter((player) => player.inHand && !player.folded).map((player) => player.id),
    };
    previous = level;
    return pot;
  }).filter((pot) => pot.amount > 0);
}

function seatOrderAfterDealer(state: GameState, playerIds: string[]) {
  return [...playerIds].sort((left, right) => {
    const leftIndex = state.players.findIndex((player) => player.id === left);
    const rightIndex = state.players.findIndex((player) => player.id === right);
    return ((leftIndex - state.dealerIndex - 1 + state.players.length) % state.players.length)
      - ((rightIndex - state.dealerIndex - 1 + state.players.length) % state.players.length);
  });
}

function returnUncalledBet(state: GameState) {
  const ordered = [...state.players].sort((left, right) => right.handBet - left.handBet);
  if (ordered.length < 2 || ordered[0].handBet <= ordered[1].handBet) return;
  const player = ordered[0];
  const amount = ordered[0].handBet - ordered[1].handBet;
  player.handBet -= amount;
  player.streetBet = Math.max(0, player.streetBet - amount);
  player.stack += amount;
  player.allIn = false;
  state.pot -= amount;
  addEvent(state, { type: 'UNCALLED_RETURN', playerId: player.id, amount, text: `${player.name} 收回未被跟注的 ${amount}` });
}

function settleUncontested(state: GameState) {
  returnUncalledBet(state);
  const winner = activePlayers(state)[0];
  const amount = state.pot;
  winner.stack += amount;
  state.winnerIds = [winner.id];
  state.resultText = `${winner.name} 赢得 ${amount}`;
  addEvent(state, { type: 'POT_AWARDED', playerId: winner.id, amount, text: state.resultText });
  state.pot = 0;
  state.phase = 'FINISHED';
  state.currentPlayerIndex = null;
  addEvent(state, { type: 'HAND_FINISHED', text: state.resultText });
}

function showdown(state: GameState) {
  state.phase = 'SHOWDOWN';
  returnUncalledBet(state);
  const contenders = activePlayers(state);
  state.handRanks = Object.fromEntries(contenders.map((player) => [player.id, evaluateHand([...player.holeCards, ...state.board])]));
  const awards = new Map<string, number>();
  for (const pot of potStructure(state)) {
    const eligible = pot.eligiblePlayerIds.filter((id) => state.handRanks[id]);
    if (!eligible.length) continue;
    const best = eligible.reduce((winnerId, id) => compareScores(state.handRanks[id].score, state.handRanks[winnerId].score) > 0 ? id : winnerId);
    const winners = eligible.filter((id) => compareScores(state.handRanks[id].score, state.handRanks[best].score) === 0);
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount % winners.length;
    for (const winnerId of seatOrderAfterDealer(state, winners)) {
      const amount = share + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
      const winner = state.players.find((player) => player.id === winnerId)!;
      winner.stack += amount;
      awards.set(winnerId, (awards.get(winnerId) ?? 0) + amount);
      addEvent(state, { type: 'POT_AWARDED', playerId: winnerId, amount, text: `${winner.name} 获得 ${amount}` });
    }
  }
  state.winnerIds = [...awards.keys()];
  state.resultText = [...awards.entries()].map(([id, amount]) => `${state.players.find((player) => player.id === id)!.name} 赢得 ${amount}`).join('；');
  state.pot = 0;
  state.phase = 'FINISHED';
  state.currentPlayerIndex = null;
  addEvent(state, { type: 'HAND_FINISHED', text: state.resultText || '本手结束' });
}

function advanceOrShowdown(state: GameState) {
  const actionable = activePlayers(state).filter((player) => !player.allIn);
  const settled = actionable.every((player) => player.acted && player.streetBet === state.currentBet);
  if (!settled) return false;
  if (state.phase === 'RIVER') {
    showdown(state);
    return true;
  }
  do {
    state.phase = nextPhase(state.phase);
    dealStreet(state, state.phase);
  } while (actionable.length <= 1 && state.phase !== 'RIVER');
  if (actionable.length <= 1) {
    showdown(state);
    return true;
  }
  state.players.forEach((player) => {
    player.streetBet = 0;
    player.acted = !player.inHand || player.folded || player.allIn;
    player.lastActionBet = null;
  });
  state.currentBet = 0;
  state.minRaiseIncrement = state.bigBlind;
  state.currentPlayerIndex = nextActiveIndex(state, state.dealerIndex, true);
  return true;
}

function validateOptions(options: CreateGameOptions) {
  if (options.players.length < 2 || options.players.length > 8) throw new Error('牌桌需要 2 到 8 名玩家');
  if (new Set(options.players.map((player) => player.id)).size !== options.players.length) throw new Error('玩家 ID 不能重复');
  if (options.players.some((player) => !player.id || !player.name || !Number.isInteger(player.stack) || player.stack < 0)) throw new Error('玩家资料无效');
  if (options.players.filter((player) => player.stack > 0).length < 2) throw new Error('至少需要两名仍有筹码的玩家');
  const smallBlind = options.smallBlind ?? 10;
  const bigBlind = options.bigBlind ?? 20;
  if (!Number.isInteger(smallBlind) || !Number.isInteger(bigBlind) || smallBlind <= 0 || bigBlind < smallBlind) throw new Error('盲注设置无效');
}

export function createGame(options: CreateGameOptions): GameState {
  validateOptions(options);
  const handNumber = options.handNumber ?? 1;
  const smallBlind = options.smallBlind ?? 10;
  const bigBlind = options.bigBlind ?? 20;
  const players: PlayerState[] = options.players.map((profile) => ({
    ...profile,
    inHand: profile.stack > 0,
    streetBet: 0,
    handBet: 0,
    folded: profile.stack === 0,
    allIn: profile.stack === 0,
    acted: profile.stack === 0,
    lastActionBet: null,
    holeCards: [],
  }));
  const requestedDealer = ((options.dealerIndex ?? (handNumber - 1)) % players.length + players.length) % players.length;
  let dealerIndex = requestedDealer;
  if (!players[dealerIndex].inHand) {
    const next = nextActiveIndex({ players }, dealerIndex);
    if (next === null) throw new Error('找不到庄家位置');
    dealerIndex = next;
  }
  const deck = shuffledDeck(options.seed);
  for (let round = 0; round < 2; round += 1) {
    players.forEach((player) => {
      if (player.inHand) player.holeCards.push(deck.shift()!);
    });
  }
  const activeCount = players.filter((player) => player.inHand).length;
  const smallBlindIndex = activeCount === 2 ? dealerIndex : nextActiveIndex({ players }, dealerIndex)!;
  const bigBlindIndex = nextActiveIndex({ players }, smallBlindIndex)!;
  const setup = {
    seed: options.seed,
    handNumber,
    dealerIndex,
    smallBlind,
    bigBlind,
    players: clone(options.players),
  };
  const state: GameState = {
    handId: `hand-${handNumber}`,
    version: 1,
    phase: 'PRE_FLOP',
    setup,
    dealerIndex,
    smallBlindIndex,
    bigBlindIndex,
    currentPlayerIndex: null,
    smallBlind,
    bigBlind,
    currentBet: 0,
    minRaiseIncrement: bigBlind,
    pot: 0,
    board: [],
    deck,
    players,
    history: [],
    actions: [],
    winnerIds: [],
    handRanks: {},
  };
  addEvent(state, { type: 'HAND_STARTED', text: `第 ${handNumber} 手牌开始` });
  const smallBlindPlayer = players[smallBlindIndex];
  const bigBlindPlayer = players[bigBlindIndex];
  const smallPaid = commit(smallBlindPlayer, smallBlind);
  const bigPaid = commit(bigBlindPlayer, bigBlind);
  state.pot = smallPaid + bigPaid;
  state.currentBet = Math.max(smallBlindPlayer.streetBet, bigBlindPlayer.streetBet);
  const preferredFirstIndex = activeCount === 2 ? dealerIndex : nextActiveIndex(state, bigBlindIndex)!;
  state.currentPlayerIndex = players[preferredFirstIndex].allIn ? nextActiveIndex(state, preferredFirstIndex, true) : preferredFirstIndex;
  addEvent(state, { type: 'BLIND_POSTED', playerId: smallBlindPlayer.id, amount: smallPaid, text: `${smallBlindPlayer.name} 下小盲 ${smallPaid}` });
  addEvent(state, { type: 'BLIND_POSTED', playerId: bigBlindPlayer.id, amount: bigPaid, text: `${bigBlindPlayer.name} 下大盲 ${bigPaid}` });
  if (state.currentPlayerIndex === null) advanceOrShowdown(state);
  return state;
}

export function legalActions(state: GameState, playerIndex: number): LegalActions {
  const player = state.players[playerIndex];
  const empty: LegalActions = { types: [], callAmount: 0, minRaiseTo: null, maxRaiseTo: 0 };
  if (!player || state.currentPlayerIndex !== playerIndex || state.phase === 'FINISHED' || player.folded || player.allIn || !player.inHand) return empty;
  const callAmount = Math.min(player.stack, Math.max(0, state.currentBet - player.streetBet));
  const maxRaiseTo = player.streetBet + player.stack;
  const minRaiseTo = state.currentBet + state.minRaiseIncrement;
  const raiseReopened = player.lastActionBet === null || state.currentBet - player.lastActionBet >= state.minRaiseIncrement;
  const types: LegalActions['types'] = ['FOLD'];
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
  const state = clone(source);
  const playerIndex = state.currentPlayerIndex;
  if (playerIndex === null) return { ok: false, state: source, error: '当前没有玩家需要行动' };
  const player = state.players[playerIndex];
  const legal = legalActions(state, playerIndex);
  if (!legal.types.includes(action.type)) return { ok: false, state: source, error: '当前不能执行这个动作' };
  const recordedAction: PlayerAction = action.type === 'RAISE' ? { type: 'RAISE', raiseTo: action.raiseTo } : { type: action.type };
  if (action.type === 'FOLD') {
    player.folded = true;
    player.acted = true;
    addEvent(state, { type: 'PLAYER_ACTION', playerId: player.id, action: recordedAction, text: `${player.name} 弃牌` });
  } else if (action.type === 'CHECK') {
    player.acted = true;
    addEvent(state, { type: 'PLAYER_ACTION', playerId: player.id, action: recordedAction, text: `${player.name} 过牌` });
  } else if (action.type === 'CALL') {
    const paid = commit(player, legal.callAmount);
    state.pot += paid;
    player.acted = true;
    addEvent(state, { type: 'PLAYER_ACTION', playerId: player.id, action: recordedAction, amount: paid, text: `${player.name} 跟注 ${paid}` });
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
        if (index !== playerIndex && other.inHand && !other.folded && !other.allIn && other.streetBet < state.currentBet) other.acted = false;
      });
    }
    player.acted = true;
    addEvent(state, {
      type: 'PLAYER_ACTION', playerId: player.id, action: recordedAction, amount: player.streetBet,
      text: `${player.name}${action.type === 'ALL_IN' ? ' 全下到 ' : ' 加注到 '}${player.streetBet}`,
    });
  }
  player.lastActionBet = state.currentBet;
  state.actions.push({ index: state.actions.length, playerId: player.id, action: recordedAction });

  if (activePlayers(state).length === 1) settleUncontested(state);
  else if (!advanceOrShowdown(state)) state.currentPlayerIndex = nextActiveIndex(state, playerIndex, true);
  state.version += 1;
  return { ok: true, state };
}

/** Apply a canonical fold when a player deliberately leaves the table. */
export function foldPlayer(source: GameState, playerId: string): ApplyResult {
  const playerIndex = source.players.findIndex((player) => player.id === playerId);
  if (playerIndex < 0) return { ok: false, state: source, error: '玩家不存在' };
  if (source.phase === 'FINISHED') return { ok: true, state: source };
  const sourcePlayer = source.players[playerIndex];
  if (!sourcePlayer.inHand || sourcePlayer.folded) return { ok: true, state: source };
  if (source.currentPlayerIndex === playerIndex) return applyAction(source, { type: 'FOLD' });

  const state = clone(source);
  const player = state.players[playerIndex];
  const action: PlayerAction = { type: 'FOLD' };
  player.folded = true;
  player.acted = true;
  player.lastActionBet = state.currentBet;
  addEvent(state, { type: 'PLAYER_ACTION', playerId, action, text: `${player.name} 弃牌` });
  state.actions.push({ index: state.actions.length, playerId, action });

  if (activePlayers(state).length === 1) settleUncontested(state);
  else advanceOrShowdown(state);
  state.version += 1;
  return { ok: true, state };
}

function publicPlayers(state: GameState) {
  return state.players.map(({ holeCards: _cards, acted: _acted, lastActionBet: _lastActionBet, ...player }) => player);
}

function visiblePots(state: GameState) {
  const structuredPots = potStructure(state);
  const hasAllInContribution = state.players.some((player) => player.inHand && !player.folded && player.allIn && player.handBet > 0);
  return hasAllInContribution
    ? structuredPots
    : state.pot > 0 ? [{ amount: state.pot, eligiblePlayerIds: activePlayers(state).map((player) => player.id) }] : [];
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
    pots: visiblePots(state),
    players: publicPlayers(state),
    legalActions: legalActions(state, playerIndex),
    recentHistory: state.history.slice(-40),
  };
}

export function tableView(state: GameState): TableView {
  const reachedShowdown = state.phase === 'FINISHED' && activePlayers(state).length > 1;
  return {
    handId: state.handId,
    handNumber: state.setup.handNumber,
    version: state.version,
    phase: state.phase,
    board: [...state.board],
    pot: state.pot,
    pots: visiblePots(state),
    players: publicPlayers(state),
    recentHistory: state.history.slice(-40),
    currentPlayerId: state.currentPlayerIndex === null ? null : state.players[state.currentPlayerIndex].id,
    dealerId: state.players[state.dealerIndex].id,
    smallBlindId: state.players[state.smallBlindIndex].id,
    bigBlindId: state.players[state.bigBlindIndex].id,
    winnerIds: [...state.winnerIds],
    resultText: state.resultText,
    revealedCards: reachedShowdown ? Object.fromEntries(activePlayers(state).map((player) => [player.id, [...player.holeCards]])) : {},
    handRanks: reachedShowdown ? clone(state.handRanks) : {},
  };
}

export function playerView(state: GameState, playerId: string): PlayerView {
  const playerIndex = state.players.findIndex((player) => player.id === playerId);
  if (playerIndex < 0) throw new Error('玩家不存在');
  return {
    viewerId: playerId,
    handId: state.handId,
    version: state.version,
    holeCards: [...state.players[playerIndex].holeCards],
    legalActions: legalActions(state, playerIndex),
  };
}
