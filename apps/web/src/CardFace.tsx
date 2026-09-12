import type { Card } from '@holdem/core';

type EffectTarget =
  | { kind: 'hole'; playerId: string; index: number }
  | { kind: 'board'; index: number };

export function CardFace({ card, hidden = false, small = false, target }: { card?: Card; hidden?: boolean; small?: boolean; target?: EffectTarget }) {
  const targetProps = target?.kind === 'hole'
    ? { 'data-effect-hole-card': 'true', 'data-player-id': target.playerId, 'data-card-index': target.index }
    : target?.kind === 'board'
      ? { 'data-effect-board-card': 'true', 'data-card-index': target.index }
      : {};
  if (!card) return <i className={`card-slot${small ? ' small' : ''}`} {...targetProps} />;
  if (hidden) return <i className={`card-face card-back${small ? ' small' : ''}`} aria-label="隐藏牌" {...targetProps} />;
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = ({ s: '♠', h: '♥', d: '♦', c: '♣' } as const)[card[1] as 's' | 'h' | 'd' | 'c'];
  const red = card[1] === 'h' || card[1] === 'd';
  return <i className={`card-face ${red ? 'red' : ''}${small ? ' small' : ''}`} aria-label={`${rank}${suit}`} {...targetProps}><b>{rank}</b><span>{suit}</span></i>;
}
