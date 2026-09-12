import { center, playerElement, reducedMotion } from './dom';

export class ChipAnimator {
  private chips = new Set<HTMLElement>();

  private move(source: HTMLElement | null, target: HTMLElement | null, amount: number) {
    if (!source || !target || reducedMotion()) return;
    const from = center(source.getBoundingClientRect());
    const to = center(target.getBoundingClientRect());
    const count = Math.max(3, Math.min(7, 3 + Math.floor(Math.log10(Math.max(1, amount)))));

    for (let index = 0; index < count; index += 1) {
      const chip = document.createElement('i');
      chip.className = `effect-chip chip-${index % 3}`;
      chip.style.left = `${from.x - 6}px`;
      chip.style.top = `${from.y - 6}px`;
      document.body.append(chip);
      this.chips.add(chip);
      const spread = (index - (count - 1) / 2) * 5;
      const animation = chip.animate([
        { transform: `translate3d(${spread}px, 0, 0) scale(.8) rotate(0deg)`, opacity: .7 },
        { transform: `translate3d(${to.x - from.x + spread}px, ${to.y - from.y}px, 0) scale(1) rotate(${180 + index * 40}deg)`, opacity: 1 },
      ], { duration: 440, delay: index * 45, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
      void animation.finished.catch(() => undefined).finally(() => {
        chip.remove();
        this.chips.delete(chip);
      });
    }
  }

  bet(playerId: string, amount: number) {
    this.move(playerElement(playerId), document.querySelector<HTMLElement>('[data-effect-pot]'), amount);
  }

  award(playerId: string, amount: number) {
    this.move(document.querySelector<HTMLElement>('[data-effect-pot]'), playerElement(playerId), amount);
  }

  dispose() {
    this.chips.forEach((chip) => {
      chip.getAnimations().forEach((animation) => animation.cancel());
      chip.remove();
    });
    this.chips.clear();
  }
}
