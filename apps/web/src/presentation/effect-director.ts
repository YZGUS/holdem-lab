import { audioManager, type AudioManager } from './audio-manager';
import { CardAnimator } from './card-animator';
import { ChipAnimator } from './chip-animator';
import type { PresentationEvent } from './types';

export class EffectDirector {
  private timers = new Set<number>();

  constructor(
    private cards = new CardAnimator(),
    private chips = new ChipAnimator(),
    private audio: AudioManager = audioManager,
  ) {}

  private schedule(callback: () => void, delay: number) {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delay);
    this.timers.add(timer);
  }

  private run(event: PresentationEvent) {
    if (event.type === 'DEAL_CARDS') {
      this.cards.deal(event.playerIds);
      for (let index = 0; index < event.playerIds.length * 2; index += 1) {
        this.schedule(() => this.audio.play('deal'), index * 85);
      }
    } else if (event.type === 'REVEAL_BOARD') {
      this.cards.flipBoard(event.cards);
      event.cards.forEach((_, index) => this.schedule(() => this.audio.play('flip'), 300 + index * 125));
    } else if (event.type === 'PLAYER_BET') {
      this.chips.bet(event.playerId, event.amount);
      this.audio.play('chip');
    } else if (event.type === 'CHIPS_RETURNED') {
      this.chips.award(event.playerId, event.amount);
      this.audio.play('chip');
    } else if (event.type === 'POT_AWARDED') {
      this.chips.award(event.playerId, event.amount);
      this.audio.play('win');
    } else if (event.type === 'PLAYER_FOLD') {
      this.audio.play('fold');
    } else {
      this.audio.play('check');
    }
  }

  dispatch(events: PresentationEvent[]) {
    events.forEach((event, index) => this.schedule(() => this.run(event), index * 110));
  }

  dispose() {
    this.timers.forEach((timer) => window.clearTimeout(timer));
    this.timers.clear();
    this.cards.dispose();
    this.chips.dispose();
  }
}
