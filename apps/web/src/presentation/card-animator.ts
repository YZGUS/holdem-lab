import type { Card } from '@holdem/core';
import { boardCardElement, center, holeCardElement, reducedMotion } from './dom';

function cardLabel(card: Card) {
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = ({ s: '♠', h: '♥', d: '♦', c: '♣' } as const)[card[1] as 's' | 'h' | 'd' | 'c'];
  return { rank, suit, red: card[1] === 'h' || card[1] === 'd' };
}

function cardTheme() {
  return document.querySelector<HTMLElement>('[data-card-theme]')?.dataset.cardTheme ?? 'classic';
}

export class CardAnimator {
  private overlays = new Set<HTMLElement>();
  private hiddenTargets = new Set<HTMLElement>();

  private deckRect() {
    return document.querySelector<HTMLElement>('[data-effect-deck]')?.getBoundingClientRect() ?? null;
  }

  private hide(target: HTMLElement) {
    target.style.visibility = 'hidden';
    this.hiddenTargets.add(target);
  }

  private reveal(target: HTMLElement) {
    target.style.visibility = '';
    this.hiddenTargets.delete(target);
  }

  private track(element: HTMLElement) {
    document.body.append(element);
    this.overlays.add(element);
    return element;
  }

  private remove(element: HTMLElement) {
    element.remove();
    this.overlays.delete(element);
  }

  deal(playerIds: string[]) {
    if (reducedMotion()) return;
    const sourceRect = this.deckRect();
    if (!sourceRect) return;
    const targets = [0, 1].flatMap((cardIndex) => playerIds
      .map((playerId) => holeCardElement(playerId, cardIndex))
      .filter((target): target is HTMLElement => Boolean(target)));
    const source = center(sourceRect);

    targets.forEach((target, index) => {
      const targetRect = target.getBoundingClientRect();
      const destination = center(targetRect);
      const card = document.createElement('i');
      card.className = 'effect-card effect-card-back';
      card.dataset.cardTheme = cardTheme();
      card.style.left = `${source.x - targetRect.width / 2}px`;
      card.style.top = `${source.y - targetRect.height / 2}px`;
      card.style.width = `${targetRect.width}px`;
      card.style.height = `${targetRect.height}px`;
      this.hide(target);
      this.track(card);
      const animation = card.animate([
        { transform: 'translate3d(0, 0, 0) rotate(-10deg) scale(.72)', opacity: .65 },
        { transform: `translate3d(${destination.x - source.x}px, ${destination.y - source.y}px, 0) rotate(${index % 2 ? 4 : -4}deg) scale(1)`, opacity: 1 },
      ], { duration: 430, delay: index * 85, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'forwards' });
      void animation.finished.catch(() => undefined).finally(() => {
        this.reveal(target);
        this.remove(card);
      });
    });
  }

  flipBoard(cards: Array<{ card: Card; index: number }>) {
    if (reducedMotion()) return;
    const deckRect = this.deckRect();
    cards.forEach(({ card, index }, order) => {
      const target = boardCardElement(index);
      if (!target) return;
      const targetRect = target.getBoundingClientRect();
      const source = deckRect ? center(deckRect) : center(targetRect);
      const destination = center(targetRect);
      const wrapper = document.createElement('span');
      wrapper.className = 'effect-flip-card';
      wrapper.dataset.cardTheme = cardTheme();
      wrapper.style.left = `${source.x - targetRect.width / 2}px`;
      wrapper.style.top = `${source.y - targetRect.height / 2}px`;
      wrapper.style.width = `${targetRect.width}px`;
      wrapper.style.height = `${targetRect.height}px`;
      const inner = document.createElement('span');
      inner.className = 'effect-flip-inner';
      const back = document.createElement('i');
      back.className = 'effect-flip-face effect-flip-back';
      const front = document.createElement('i');
      const label = cardLabel(card);
      front.className = `effect-flip-face effect-flip-front${label.red ? ' red' : ''}`;
      const rank = document.createElement('b');
      const suit = document.createElement('span');
      rank.textContent = label.rank;
      suit.textContent = label.suit;
      front.append(rank, suit);
      inner.append(back, front);
      wrapper.append(inner);
      this.hide(target);
      this.track(wrapper);

      const delay = order * 125;
      const travel = wrapper.animate([
        { transform: 'translate3d(0, 0, 0) rotate(-6deg) scale(.8)' },
        { transform: `translate3d(${destination.x - source.x}px, ${destination.y - source.y}px, 0) rotate(0) scale(1)` },
      ], { duration: 300, delay, easing: 'cubic-bezier(.2,.7,.25,1)', fill: 'forwards' });
      void travel.finished.catch(() => undefined).then(() => inner.animate([
        { transform: 'rotateY(0deg)' },
        { transform: 'rotateY(180deg)' },
      ], { duration: 380, easing: 'cubic-bezier(.3,.7,.25,1)', fill: 'forwards' }).finished).catch(() => undefined).finally(() => {
        this.reveal(target);
        this.remove(wrapper);
      });
    });
  }

  dispose() {
    this.overlays.forEach((element) => {
      element.getAnimations().forEach((animation) => animation.cancel());
      element.querySelectorAll<HTMLElement>('*').forEach((child) => child.getAnimations().forEach((animation) => animation.cancel()));
      element.remove();
    });
    this.overlays.clear();
    this.hiddenTargets.forEach((target) => { target.style.visibility = ''; });
    this.hiddenTargets.clear();
  }
}
