import { applyAction, createGame, decisionContext, type DecisionContext, type PlayerAction, type PlayerProfile } from '@holdem/core';

export type StrategyFamily = 'BASIC' | 'MONTE_CARLO' | 'CFR' | 'GTO' | 'RL';

export interface StrategyRuntime {
  random: () => number;
  signal?: AbortSignal;
}

export interface BotStrategy {
  id: string;
  name: string;
  family: StrategyFamily;
  decide(context: Readonly<DecisionContext>, runtime: StrategyRuntime): PlayerAction | Promise<PlayerAction>;
}

export interface StrategyPlugin {
  id: string;
  name: string;
  family: StrategyFamily;
  create(config?: Readonly<Record<string, unknown>>): BotStrategy;
}

export class StrategyRegistry {
  private readonly plugins = new Map<string, StrategyPlugin>();

  register(plugin: StrategyPlugin) {
    if (this.plugins.has(plugin.id)) throw new Error(`策略已注册：${plugin.id}`);
    this.plugins.set(plugin.id, plugin);
  }

  create(id: string, config?: Readonly<Record<string, unknown>>) {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`策略不存在：${id}`);
    return plugin.create(config);
  }

  list() {
    return [...this.plugins.values()].map(({ id, name, family }) => ({ id, name, family }));
  }
}

export const basicStrategyPlugin: StrategyPlugin = {
  id: 'basic-check-call',
  name: '基础跟注策略',
  family: 'BASIC',
  create: () => ({
    id: 'basic-check-call',
    name: '基础跟注策略',
    family: 'BASIC',
    decide(context) {
      if (context.legalActions.types.includes('CHECK')) return { type: 'CHECK' };
      if (context.legalActions.types.includes('CALL')) return { type: 'CALL' };
      return { type: 'FOLD' };
    },
  }),
};

export function createDefaultStrategyRegistry() {
  const registry = new StrategyRegistry();
  registry.register(basicStrategyPlugin);
  return registry;
}

function seededRandom(seed: number) {
  let value = seed >>> 0 || 1;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === 'function';
}

export interface SimulationOptions {
  hands: number;
  playerCount: number;
  seed: number;
  startingStack?: number;
  smallBlind?: number;
  bigBlind?: number;
  strategy?: BotStrategy;
}

export interface SimulationResult {
  hands: number;
  playerCount: number;
  seed: number;
  totalActions: number;
  averageActions: number;
  wins: Record<string, number>;
}

export function runSimulation(options: SimulationOptions): SimulationResult {
  if (!Number.isInteger(options.hands) || options.hands < 1 || options.hands > 10_000) throw new Error('模拟手数应在 1 到 10000 之间');
  if (!Number.isInteger(options.playerCount) || options.playerCount < 2 || options.playerCount > 8) throw new Error('模拟人数应在 2 到 8 之间');
  const strategy = options.strategy ?? basicStrategyPlugin.create();
  const random = seededRandom(options.seed);
  const wins: Record<string, number> = {};
  let totalActions = 0;
  const profiles: PlayerProfile[] = Array.from({ length: options.playerCount }, (_, index) => ({
    id: `bot-${index + 1}`,
    name: `Bot ${index + 1}`,
    kind: 'BOT',
    stack: options.startingStack ?? 2000,
  }));
  profiles.forEach((profile) => { wins[profile.id] = 0; });

  for (let hand = 0; hand < options.hands; hand += 1) {
    let state = createGame({
      seed: (options.seed + hand) >>> 0,
      handNumber: hand + 1,
      dealerIndex: hand % profiles.length,
      smallBlind: options.smallBlind,
      bigBlind: options.bigBlind,
      players: profiles,
    });
    while (state.phase !== 'FINISHED') {
      if (totalActions > options.hands * 500) throw new Error('模拟动作数量异常');
      const player = state.players[state.currentPlayerIndex!];
      const action = strategy.decide(decisionContext(state, player.id), { random });
      if (isPromise(action)) throw new Error('批量模拟需要同步策略');
      const applied = applyAction(state, action);
      if (!applied.ok) throw new Error(`策略返回了非法动作：${applied.error}`);
      state = applied.state;
      totalActions += 1;
    }
    state.winnerIds.forEach((id) => { wins[id] += 1; });
  }
  return {
    hands: options.hands,
    playerCount: options.playerCount,
    seed: options.seed,
    totalActions,
    averageActions: Number((totalActions / options.hands).toFixed(2)),
    wins,
  };
}
