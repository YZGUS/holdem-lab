import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { TableView } from '@holdem/core';
import { EffectDirector } from './effect-director';
import { toPresentationEvents } from './types';

interface EventCursor {
  handId: string;
  lastIndex: number;
}

export function usePresentationEffects(table: TableView, replaying: boolean) {
  const director = useMemo(() => new EffectDirector(), []);
  const cursorRef = useRef<EventCursor | null>(null);
  const disposeTimerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const history = table.recentHistory;
    const lastIndex = history.at(-1)?.index ?? -1;
    if (replaying) {
      cursorRef.current = { handId: table.handId, lastIndex };
      return;
    }

    const cursor = cursorRef.current;
    let events = [] as typeof history;
    if (!cursor) {
      const freshHand = table.phase === 'PRE_FLOP' && !history.some((event) => event.type === 'PLAYER_ACTION');
      if (freshHand) events = history;
    } else if (cursor.handId !== table.handId) {
      events = history;
    } else {
      events = history.filter((event) => event.index > cursor.lastIndex);
    }
    cursorRef.current = { handId: table.handId, lastIndex };
    if (events.length) director.dispatch(toPresentationEvents(events, history, table));
  }, [director, replaying, table]);

  useEffect(() => {
    if (disposeTimerRef.current !== null) {
      window.clearTimeout(disposeTimerRef.current);
      disposeTimerRef.current = null;
    }
    return () => {
      disposeTimerRef.current = window.setTimeout(() => director.dispose(), 0);
    };
  }, [director]);
}
