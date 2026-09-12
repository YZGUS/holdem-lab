export function center(rect: DOMRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export function playerElement(playerId: string) {
  return [...document.querySelectorAll<HTMLElement>('[data-effect-player-id]')]
    .find((element) => element.dataset.effectPlayerId === playerId) ?? null;
}

export function holeCardElement(playerId: string, index: number) {
  return [...document.querySelectorAll<HTMLElement>('[data-effect-hole-card]')]
    .find((element) => element.dataset.playerId === playerId && Number(element.dataset.cardIndex) === index) ?? null;
}

export function boardCardElement(index: number) {
  return [...document.querySelectorAll<HTMLElement>('[data-effect-board-card]')]
    .find((element) => Number(element.dataset.cardIndex) === index) ?? null;
}

export function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
