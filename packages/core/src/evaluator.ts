import type { Card, HandRank, Rank } from './types.js';

const ranks: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const rankNames = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

function displayRank(value: number) {
  return value <= 10 ? String(value) : ['J', 'Q', 'K', 'A'][value - 11];
}

function describeScore(score: number[], name: string) {
  if (name === '皇家同花顺') return name;
  const first = displayRank(score[1]);
  switch (score[0]) {
    case 8: return `同花顺 ${first} 高`;
    case 7: return `四条 ${first}`;
    case 6: return `葫芦 ${first} 带 ${displayRank(score[2])}`;
    case 5: return `同花 ${first} 高`;
    case 4: return `顺子 ${first} 高`;
    case 3: return `三条 ${first}`;
    case 2: return `两对 ${first}、${displayRank(score[2])}`;
    case 1: return `一对 ${first}`;
    default: return `高牌 ${first}`;
  }
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

export function compareScores(a: number[], b: number[]) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export function evaluateHand(cards: Card[]): HandRank {
  if (cards.length < 5 || cards.length > 7) throw new Error('牌型计算需要 5 到 7 张牌');
  let bestFive: Card[] = [];
  let score: number[] = [];
  for (let a = 0; a < cards.length - 4; a += 1)
    for (let b = a + 1; b < cards.length - 3; b += 1)
      for (let c = b + 1; c < cards.length - 2; c += 1)
        for (let d = c + 1; d < cards.length - 1; d += 1)
          for (let e = d + 1; e < cards.length; e += 1) {
            const candidate = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const candidateScore = fiveCardScore(candidate);
            if (!score.length || compareScores(candidateScore, score) > 0) {
              score = candidateScore;
              bestFive = candidate;
            }
          }
  const name = score[0] === 8 && score[1] === 14 ? '皇家同花顺' : rankNames[score[0]];
  return { category: score[0], name, description: describeScore(score, name), bestFive, score };
}
