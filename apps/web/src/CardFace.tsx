import type { Card } from '@holdem/core';

export function CardFace({ card, hidden = false, small = false }: { card?: Card; hidden?: boolean; small?: boolean }) {
  if (!card) return <i className={`card-slot${small ? ' small' : ''}`} />;
  if (hidden) return <i className={`card-face card-back${small ? ' small' : ''}`} aria-label="隐藏牌" />;
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = ({ s: '♠', h: '♥', d: '♦', c: '♣' } as const)[card[1] as 's' | 'h' | 'd' | 'c'];
  const red = card[1] === 'h' || card[1] === 'd';
  return <i className={`card-face ${red ? 'red' : ''}${small ? ' small' : ''}`} aria-label={`${rank}${suit}`}><b>{rank}</b><span>{suit}</span></i>;
}
