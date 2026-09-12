import { useEffect, useRef } from 'react';
import type { ActionType, PlayerAction, PlayerView, TableView } from '@holdem/core';
import { Lobby } from './Lobby';
import { PokerTable } from './PokerTable';
import { WaitingRoom } from './WaitingRoom';
import { useGameClient } from './useGameClient';

export function App() {
  const client = useGameClient();
  const viewRef = useRef<PlayerView | null>(null);
  const tableRef = useRef<TableView | null>(null);
  const submitRef = useRef(client.submitAction);
  viewRef.current = client.view;
  tableRef.current = client.table;
  submitRef.current = client.submitAction;

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: 'submit_holdem_action',
      title: '提交扑克行动',
      description: '在轮到当前玩家时，提交弃牌、过牌、跟注、加注或全下，并等待权威牌桌确认。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['FOLD', 'CHECK', 'CALL', 'RAISE', 'ALL_IN'] },
          raiseTo: { type: 'integer', minimum: 0 },
        },
        required: ['action'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input) {
        const data = input as { action?: ActionType; raiseTo?: number };
        const current = viewRef.current;
        const table = tableRef.current;
        if (!current || !table || table.currentPlayerId !== current.viewerId) throw new Error('现在没有轮到当前玩家');
        if (!data.action || !current.legalActions.types.includes(data.action)) throw new Error('该动作当前不合法');
        if (data.action === 'RAISE' && (!Number.isInteger(data.raiseTo) || data.raiseTo! < current.legalActions.minRaiseTo! || data.raiseTo! > current.legalActions.maxRaiseTo)) throw new Error('加注金额超出合法范围');
        const action: PlayerAction = data.action === 'RAISE' ? { type: 'RAISE', raiseTo: data.raiseTo! } : { type: data.action };
        const next = await submitRef.current(action);
        return { handId: next.handId, version: next.version, phase: next.phase, result: next.resultText ?? null };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  if (!client.room) {
    return <Lobby
      connection={client.connection}
      session={client.session}
      rooms={client.rooms}
      busy={client.busy}
      notice={client.notice}
      onCreate={client.createRoom}
      onJoin={client.joinRoom}
      onReturn={client.returnRoom}
      onRefresh={client.refreshRooms}
      onDismissNotice={client.clearNotice}
    />;
  }
  if (client.room.status === 'WAITING' || !client.table) {
    return <WaitingRoom room={client.room} connection={client.connection} busy={client.busy} onStart={client.startGame} onLeave={client.room.status === 'WAITING' ? client.leaveRoom : client.leaveTable} onDisband={client.disbandRoom} />;
  }
  return <PokerTable
    room={client.room}
    table={client.table}
    view={client.view}
    replay={client.replay}
    connection={client.connection}
    busy={client.busy}
    notice={client.notice}
    onDismissNotice={client.clearNotice}
    onAction={client.submitAction}
    onLeave={client.leaveTable}
    onDisband={client.disbandRoom}
    onRequestRebuy={client.requestRebuy}
    onResolveRebuy={client.resolveRebuy}
    onGetReplay={client.getReplay}
    onClearReplay={client.clearReplay}
  />;
}
