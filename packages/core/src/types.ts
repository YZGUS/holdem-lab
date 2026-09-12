export type Suit = 's' | 'h' | 'd' | 'c';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export type Card = `${Rank}${Suit}`;
export type Phase = 'PRE_FLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'FINISHED';
export type ActionType = 'FOLD' | 'CHECK' | 'CALL' | 'RAISE' | 'ALL_IN';

export type PlayerAction =
  | { type: 'FOLD' }
  | { type: 'CHECK' }
  | { type: 'CALL' }
  | { type: 'ALL_IN' }
  | { type: 'RAISE'; raiseTo: number };

export interface PlayerProfile {
  id: string;
  name: string;
  kind: 'HUMAN' | 'BOT';
  stack: number;
}

export interface PlayerState extends PlayerProfile {
  inHand: boolean;
  streetBet: number;
  handBet: number;
  folded: boolean;
  allIn: boolean;
  acted: boolean;
  lastActionBet: number | null;
  holeCards: Card[];
}

export type GameEventType = 'HAND_STARTED' | 'BLIND_POSTED' | 'PLAYER_ACTION' | 'STREET_DEALT' | 'UNCALLED_RETURN' | 'POT_AWARDED' | 'HAND_FINISHED';

export interface GameEvent {
  index: number;
  phase: Phase;
  type: GameEventType;
  playerId?: string;
  action?: PlayerAction;
  amount?: number;
  cards?: Card[];
  text: string;
}

export type HistoryEntry = GameEvent;

export interface RecordedAction {
  index: number;
  playerId: string;
  action: PlayerAction;
}

export interface GameSetup {
  seed: number;
  handNumber: number;
  dealerIndex: number;
  smallBlind: number;
  bigBlind: number;
  players: PlayerProfile[];
}

export interface PotSummary {
  amount: number;
  eligiblePlayerIds: string[];
}

export interface HandRank {
  category: number;
  name: string;
  description: string;
  bestFive: Card[];
  score: number[];
}

export interface GameState {
  handId: string;
  version: number;
  phase: Phase;
  setup: GameSetup;
  dealerIndex: number;
  smallBlindIndex: number;
  bigBlindIndex: number;
  currentPlayerIndex: number | null;
  smallBlind: number;
  bigBlind: number;
  currentBet: number;
  minRaiseIncrement: number;
  pot: number;
  board: Card[];
  deck: Card[];
  players: PlayerState[];
  history: GameEvent[];
  actions: RecordedAction[];
  winnerIds: string[];
  handRanks: Record<string, HandRank>;
  resultText?: string;
}

export interface LegalActions {
  types: ActionType[];
  callAmount: number;
  minRaiseTo: number | null;
  maxRaiseTo: number;
}

export type PublicPlayer = Pick<PlayerState, 'id' | 'name' | 'kind' | 'stack' | 'inHand' | 'streetBet' | 'handBet' | 'folded' | 'allIn'>;

export interface DecisionContext {
  handId: string;
  version: number;
  phase: Phase;
  playerId: string;
  holeCards: Card[];
  board: Card[];
  pot: number;
  pots: PotSummary[];
  players: PublicPlayer[];
  legalActions: LegalActions;
  recentHistory: GameEvent[];
}

export interface TableView {
  handId: string;
  handNumber: number;
  version: number;
  phase: Phase;
  board: Card[];
  pot: number;
  pots: PotSummary[];
  players: PublicPlayer[];
  recentHistory: GameEvent[];
  currentPlayerId: string | null;
  dealerId: string;
  smallBlindId: string;
  bigBlindId: string;
  winnerIds: string[];
  resultText?: string;
  revealedCards: Record<string, Card[]>;
  handRanks: Record<string, HandRank>;
}

export interface PlayerView {
  viewerId: string;
  handId: string;
  version: number;
  holeCards: Card[];
  legalActions: LegalActions;
}

export interface CreateGameOptions {
  seed: number;
  handNumber?: number;
  dealerIndex?: number;
  smallBlind?: number;
  bigBlind?: number;
  players: PlayerProfile[];
}

export interface HandReplay {
  schemaVersion: 1;
  handId: string;
  setup: GameSetup;
  actions: RecordedAction[];
  resultText?: string;
  winnerIds: string[];
}

export type ApplyResult =
  | { ok: true; state: GameState }
  | { ok: false; state: GameState; error: string };
