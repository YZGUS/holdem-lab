import { describe, expect, it } from 'vitest';
import { createDefaultStrategyRegistry, runSimulation } from './index';

describe('bot strategy boundary', () => {
  it('runs deterministic multi-player simulations through DecisionContext', () => {
    const first = runSimulation({ hands: 25, playerCount: 6, seed: 2026 });
    const second = runSimulation({ hands: 25, playerCount: 6, seed: 2026 });
    expect(second).toEqual(first);
    expect(first.totalActions).toBeGreaterThan(0);
    expect(Object.keys(first.wins)).toHaveLength(6);
    expect(createDefaultStrategyRegistry().list()).toEqual([{ id: 'basic-check-call', name: '基础跟注策略', family: 'BASIC' }]);
  });
});
