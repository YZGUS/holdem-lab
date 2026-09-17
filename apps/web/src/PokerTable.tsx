import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  playerView, replayHand, tableView, type ActionType, type Card, type HandReplay,
  type LegalActions, type PlayerAction, type PlayerView, type PublicPlayer, type TableView,
} from '@holdem/core';
import type { RoomView } from '@holdem/protocol';
import { CardFace } from './CardFace';
import { ConfirmDialog } from './ConfirmDialog';
import { MatchSettlement } from './MatchSettlement';
import type { ClientNotice } from './useGameClient';
import { SoundControls } from './presentation/SoundControls';
import { usePresentationEffects } from './presentation/usePresentationEffects';

const phaseNames: Record<TableView['phase'], string> = {
  PRE_FLOP: '翻牌前', FLOP: '翻牌', TURN: '转牌', RIVER: '河牌', SHOWDOWN: '摊牌', FINISHED: '本手结束',
};
const emptyLegal: LegalActions = { types: [], callAmount: 0, minRaiseTo: null, maxRaiseTo: 0 };

const rankExamples: Array<{ name: string; cards: Card[] }> = [
  { name: '皇家同花顺', cards: ['As', 'Ks', 'Qs', 'Js', 'Ts'] },
  { name: '同花顺', cards: ['9h', '8h', '7h', '6h', '5h'] },
  { name: '四条', cards: ['Ac', 'Ad', 'Ah', 'As', '9c'] },
  { name: '葫芦', cards: ['Kc', 'Kd', 'Kh', '8s', '8d'] },
  { name: '同花', cards: ['Ah', 'Jh', '8h', '5h', '2h'] },
  { name: '顺子', cards: ['9c', '8d', '7s', '6h', '5c'] },
  { name: '三条', cards: ['Qc', 'Qd', 'Qs', '9h', '3d'] },
  { name: '两对', cards: ['Jc', 'Jd', '5s', '5h', '2c'] },
  { name: '一对', cards: ['Ac', 'Ad', '9s', '6h', '3c'] },
  { name: '高牌', cards: ['As', 'Jd', '8c', '5h', '2s'] },
];

interface PokerTableProps {
  room: RoomView;
  table: TableView;
  view: PlayerView | null;
  replay: HandReplay | null;
  connection: 'CONNECTING' | 'OPEN' | 'CLOSED';
  busy: boolean;
  notice: ClientNotice | null;
  onAction: (action: PlayerAction) => Promise<TableView>;
  onLeave: () => void;
  onDisband: () => void;
  onRequestRebuy: () => void;
  onDeclineRebuy: () => void;
  onResolveRebuy: (playerId: string, approved: boolean) => void;
  onGetReplay: (handId: string) => void;
  onClearReplay: () => void;
  onDismissNotice: () => void;
}

function seatPosition(index: number, viewerIndex: number, count: number): CSSProperties {
  const relative = (index - viewerIndex + count) % count;
  const angle = relative / count * Math.PI * 2;
  return {
    '--seat-x': `${50 + Math.sin(angle) * 46}%`,
    '--seat-y': `${50 + Math.cos(angle) * 48}%`,
  } as CSSProperties;
}

function downloadReplay(replay: HandReplay) {
  const blob = new Blob([JSON.stringify(replay, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${replay.handId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function gamePlayerOrObserver(roomPlayer: RoomView['players'][number], player?: PublicPlayer): PublicPlayer {
  return player ?? {
    id: roomPlayer.id,
    name: roomPlayer.name,
    kind: roomPlayer.kind,
    stack: roomPlayer.stack,
    inHand: false,
    streetBet: 0,
    handBet: 0,
    folded: false,
    allIn: false,
  };
}

function secondsUntil(deadline: number) {
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

function TurnCountdown({ deadline }: { deadline: number }) {
  const [remaining, setRemaining] = useState(() => secondsUntil(deadline));

  useEffect(() => {
    let timer = 0;
    const tick = () => {
      const next = secondsUntil(deadline);
      setRemaining((current) => current === next ? current : next);
      if (next === 0) return;

      const millisecondsLeft = Math.max(0, deadline - Date.now());
      const nextSecondBoundary = millisecondsLeft - (next - 1) * 1000;
      timer = window.setTimeout(tick, Math.max(80, nextSecondBoundary + 20));
    };

    tick();
    return () => window.clearTimeout(timer);
  }, [deadline]);

  return <div className={`countdown ${remaining <= 5 ? 'urgent' : ''}`}>{remaining}</div>;
}

export function PokerTable({
  room, table, view, replay, connection, busy, notice, onAction, onLeave, onDisband,
  onRequestRebuy, onDeclineRebuy, onResolveRebuy, onGetReplay, onClearReplay, onDismissNotice,
}: PokerTableProps) {
  const [drawer, setDrawer] = useState<'history' | 'ranks' | 'replays' | null>(null);
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [raiseTo, setRaiseTo] = useState(40);
  const [replayStep, setReplayStep] = useState(0);
  const [playingReplay, setPlayingReplay] = useState(false);
  const [cardTheme, setCardTheme] = useState<'classic' | 'contrast'>(() => sessionStorage.getItem('holdem-card-theme') === 'contrast' ? 'contrast' : 'classic');
  const [settlementOpen, setSettlementOpen] = useState(false);
  const settlementRoom = useRef<string | null>(null);
  const [confirmingDisband, setConfirmingDisband] = useState(false);
  const [confirmingDecline, setConfirmingDecline] = useState(false);
  usePresentationEffects(table, Boolean(replay));

  useEffect(() => {
    if (!replay) return;
    setReplayStep(0);
    setPlayingReplay(false);
    setDrawer('replays');
  }, [replay]);
  useEffect(() => {
    if (!playingReplay || !replay) return;
    const timer = window.setTimeout(() => {
      setReplayStep((step) => {
        if (step >= replay.actions.length) {
          setPlayingReplay(false);
          return step;
        }
        return step + 1;
      });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [playingReplay, replay, replayStep]);
  useEffect(() => {
    if (room.status !== 'FINISHED') {
      settlementRoom.current = null;
      setSettlementOpen(false);
      return;
    }
    if (settlementRoom.current === room.id) return;
    settlementRoom.current = room.id;
    if (replay || drawer === 'replays') return;
    const timer = window.setTimeout(() => setSettlementOpen(true), 900);
    return () => window.clearTimeout(timer);
  }, [drawer, replay, room.id, room.status]);

  const replayState = useMemo(() => replay ? replayHand(replay, replayStep) : null, [replay, replayStep]);
  const displayTable = useMemo(() => replayState ? tableView(replayState) : table, [replayState, table]);
  const displayPrivate = useMemo(() => {
    if (!replayState) return view;
    return replayState.players.some((player) => player.id === room.viewerPlayerId)
      ? playerView(replayState, room.viewerPlayerId)
      : null;
  }, [replayState, room.viewerPlayerId, view]);

  const viewerRoomPlayer = room.players.find((player) => player.id === room.viewerPlayerId)!;
  const viewerGamePlayer = displayTable.players.find((player) => player.id === room.viewerPlayerId);
  const legal = !replay && displayPrivate ? displayPrivate.legalActions : emptyLegal;
  const isHeroTurn = !replay && displayTable.currentPlayerId === room.viewerPlayerId;
  const actionSurfaceReady = connection === 'OPEN' && room.status === 'PLAYING' && displayTable.phase !== 'FINISHED';
  const can = (type: ActionType) => Boolean(actionSurfaceReady && isHeroTurn && !busy && legal.types.includes(type));

  useEffect(() => {
    if (legal.minRaiseTo !== null) setRaiseTo(legal.minRaiseTo);
    setRaiseOpen(false);
  }, [legal.minRaiseTo, displayTable.version]);

  const quickRaises = useMemo(() => {
    if (!viewerGamePlayer || legal.minRaiseTo === null) return [];
    const base = viewerGamePlayer.streetBet + legal.callAmount;
    const clamp = (amount: number) => Math.max(legal.minRaiseTo!, Math.min(legal.maxRaiseTo, Math.round(amount)));
    return [
      { label: '½ 底池', value: clamp(base + .5 * (displayTable.pot + legal.callAmount)) },
      { label: '¾ 底池', value: clamp(base + .75 * (displayTable.pot + legal.callAmount)) },
      { label: '底池', value: clamp(base + displayTable.pot + legal.callAmount) },
    ];
  }, [displayTable.pot, legal, viewerGamePlayer]);

  const currentIndex = displayTable.players.findIndex((player) => player.id === displayTable.currentPlayerId);
  let nextPlayerId: string | null = null;
  if (currentIndex >= 0) {
    for (let step = 1; step < displayTable.players.length; step += 1) {
      const candidate = displayTable.players[(currentIndex + step) % displayTable.players.length];
      if (candidate.inHand && !candidate.folded && !candidate.allIn) { nextPlayerId = candidate.id; break; }
    }
  }
  const currentPlayer = displayTable.players.find((player) => player.id === displayTable.currentPlayerId);
  const currentRoomPlayer = room.players.find((player) => player.id === displayTable.currentPlayerId);
  const currentPlayerLabel = currentPlayer?.id === room.viewerPlayerId
    ? '你'
    : currentPlayer && currentRoomPlayer
      ? `${currentPlayer.name}（${currentRoomPlayer.seat + 1}号位）`
      : currentPlayer?.name;
  const viewerIndex = Math.max(0, room.players.findIndex((player) => player.id === room.viewerPlayerId));
  const isHost = room.hostPlayerId === room.viewerPlayerId;
  const pendingRebuys = room.players.filter((player) => player.rebuyStatus === 'PENDING');
  const fundedPlayers = room.players.filter((player) => player.stack > 0);
  const pausedForPlayers = room.status === 'PAUSED' && displayTable.phase === 'FINISHED' && fundedPlayers.length < 2;
  const isObserver = !displayPrivate || (viewerRoomPlayer.stack === 0 && displayTable.phase === 'FINISHED');
  const canRequestRebuy = room.gameMode === 'POINTS'
    && room.rebuyEnabled
    && viewerRoomPlayer.stack === 0
    && viewerRoomPlayer.rebuyStatus === 'NONE'
    && displayTable.phase === 'FINISHED'
    && (room.maxRebuys === null || viewerRoomPlayer.rebuyCount < room.maxRebuys);
  const browsingReplays = !replay && room.status === 'FINISHED' && drawer === 'replays';
  const waitingRebuyPlayers = room.players.filter((player) => player.kind === 'HUMAN'
    && player.stack === 0
    && player.rebuyStatus !== 'DECLINED'
    && (player.rebuyStatus !== 'NONE' || room.maxRebuys === null || player.rebuyCount < room.maxRebuys));
  const mainAction = legal.types.includes('CHECK')
    ? { label: '过牌', action: { type: 'CHECK' } as PlayerAction }
    : { label: `跟注 ${legal.callAmount}`, action: { type: 'CALL' } as PlayerAction };
  const thirdLabel = legal.types.includes('RAISE') ? '加注' : legal.types.includes('ALL_IN') ? '全下' : '加注';
  const act = (action: PlayerAction) => void onAction(action).catch(() => undefined);
  const toggleDrawer = (next: typeof drawer) => setDrawer((current) => current === next ? null : next);
  const showSettlement = () => {
    if (replay) onClearReplay();
    setDrawer(null);
    setSettlementOpen(true);
  };
  const toggleCardTheme = () => setCardTheme((current) => {
    const next = current === 'classic' ? 'contrast' : 'classic';
    sessionStorage.setItem('holdem-card-theme', next);
    return next;
  });
  const observerText = viewerRoomPlayer.stack === 0
    ? viewerRoomPlayer.rebuyStatus === 'PENDING' ? '补充申请等待房主处理'
      : viewerRoomPlayer.rebuyStatus === 'APPROVED' ? '补充已批准，将从下一手加入'
        : viewerRoomPlayer.rebuyStatus === 'DECLINED' ? '已放弃本局，正在观战'
        : '筹码已用完，正在观战'
    : '等待下一手加入牌局';

  return <main className="game-shell" data-card-theme={cardTheme}>
    <header className="topbar">
      <div className="table-identity"><p className="eyebrow">HOLDEM LAB · #{room.id}</p><h1>{room.name}</h1></div>
      <div className="hand-stage" aria-label="牌局进度"><strong>第 {displayTable.handNumber} 手</strong><span>{phaseNames[displayTable.phase]}</span></div>
      <div className="table-meta" aria-label="牌桌信息"><span className="meta-mode">{room.gameMode === 'POINTS' ? '积分桌' : '淘汰赛'}</span><span className="meta-blinds">盲注 {room.smallBlind}/{room.bigBlind}</span><span className={`status-pill ${connection.toLowerCase()}`}>{connection === 'OPEN' ? '已连接' : '正在重连'}</span><SoundControls /><button className="ghost compact theme-toggle" onClick={toggleCardTheme}>卡面：{cardTheme === 'classic' ? '经典' : '高对比'}</button>{isHost && <button className="ghost compact danger host-action" disabled={busy} onClick={() => setConfirmingDisband(true)}>解散</button>}<button className="ghost compact leave-action" onClick={onLeave}>离桌</button></div>
    </header>

    <section className={`play-area${drawer ? ' panel-open' : ''}`} aria-label="德州扑克牌桌">
      <div className="turn-banner"><span />{replay ? `第 ${displayTable.handNumber} 手回放` : displayTable.phase === 'FINISHED' ? displayTable.resultText : currentPlayerLabel ? `轮到${currentPlayerLabel === '你' ? '你' : ` ${currentPlayerLabel}`}行动` : room.status === 'PAUSED' ? '牌局已暂停' : '正在同步牌局'}</div>
      <div className={`table seats-${room.players.length}`}>
        <div className="felt-mark">H</div>
        <div className="deck-anchor" data-effect-deck aria-hidden="true"><i /><i /><i /></div>
        <div className={`pot${displayTable.pots.length > 1 ? ' split' : ''}`} data-effect-pot>
          <small>{phaseNames[displayTable.phase]} · {displayTable.pots.length > 1 ? `${displayTable.pots.length} 个底池` : '底池'}</small>
          <strong>{displayTable.pot.toLocaleString()}</strong>
          {displayTable.pots.length > 1 && <div className="pot-breakdown" aria-label="底池明细">{displayTable.pots.map((pot, index) => <span key={index}>{index === 0 ? '主池' : `边池 ${index}`}<b>{pot.amount.toLocaleString()}</b></span>)}</div>}
        </div>
        <div className="community" aria-label="公共牌">{[0, 1, 2, 3, 4].map((index) => <CardFace card={displayTable.board[index]} target={{ kind: 'board', index }} key={index} />)}</div>

        {room.players.map((roomPlayer, index) => {
          const player = gamePlayerOrObserver(roomPlayer, displayTable.players.find((item) => item.id === roomPlayer.id));
          const ownCards = player.id === room.viewerPlayerId ? displayPrivate?.holeCards : displayTable.revealedCards[player.id];
          const roles = [player.id === displayTable.dealerId ? '庄家' : '', player.id === displayTable.smallBlindId ? '小盲' : '', player.id === displayTable.bigBlindId ? '大盲' : ''].filter(Boolean);
          const stateText = replay
            ? !player.inHand ? '未参与' : player.folded ? '已弃牌' : player.allIn ? 'All-in' : ''
            : roomPlayer.presence === 'AWAY' ? '暂离' : player.stack === 0 && !player.allIn ? '观战' : !player.inHand ? '等待下一手' : player.folded ? '已弃牌' : player.allIn ? 'All-in' : !roomPlayer.connected ? '离线' : '';
          const handRank = displayTable.handRanks[player.id];
          const relativeSeat = (index - viewerIndex + room.players.length) % room.players.length;
          return <article
            className={`seat ${player.id === room.viewerPlayerId ? 'hero' : ''} ${player.id === displayTable.currentPlayerId ? 'active' : ''} ${player.id === nextPlayerId ? 'next' : ''} ${displayTable.winnerIds.includes(player.id) ? 'winner' : ''} ${player.folded ? 'folded' : ''} ${!player.inHand ? 'spectator' : ''}`}
            style={seatPosition(index, viewerIndex, room.players.length)} data-position={relativeSeat} data-effect-player-id={player.id} key={player.id}
          >
            <div className="seat-cards">{ownCards?.length ? ownCards.map((card, cardIndex) => <CardFace card={card} target={{ kind: 'hole', playerId: player.id, index: cardIndex }} key={card} />) : player.inHand ? <><CardFace card="2s" hidden target={{ kind: 'hole', playerId: player.id, index: 0 }} /><CardFace card="3s" hidden target={{ kind: 'hole', playerId: player.id, index: 1 }} /></> : null}</div>
            <div className="seat-card">
              <div className={`avatar ${player.kind.toLowerCase()}`}>{player.kind === 'BOT' ? 'AI' : player.id === room.viewerPlayerId ? '你' : player.name[0]}</div>
              <div className="seat-identity"><strong>{player.name}</strong><small>{player.kind === 'BOT' ? 'Bot' : player.id === room.viewerPlayerId ? '本人' : '玩家'}</small></div>
              <span className="seat-stack">{player.stack.toLocaleString()}</span>
              {roles.length > 0 && <div className="position-badges" aria-label={`${player.name}的位置`}>{roles.map((role) => <span key={role}>{role}</span>)}</div>}
            </div>
            {(stateText || handRank || player.streetBet > 0) && <div className="seat-tags">
              {stateText && <span className="seat-status">{stateText}</span>}
              {handRank && <span className="rank-chip">{handRank.description || handRank.name}</span>}
              {player.streetBet > 0 && <span className="bet-chip">已下注 {player.streetBet}</span>}
            </div>}
            {!replay && player.id === displayTable.currentPlayerId && room.turnDeadline && <TurnCountdown deadline={room.turnDeadline} />}
          </article>;
        })}
      </div>

      <aside className={`side-panel${drawer ? ' open' : ''}`} aria-live="polite">
        <nav className="tool-tabs" aria-label="辅助信息">
          <button className={drawer === 'ranks' ? 'selected' : ''} aria-label={drawer === 'ranks' ? '关闭牌型面板' : '打开牌型面板'} aria-expanded={drawer === 'ranks'} onClick={() => toggleDrawer('ranks')}>牌型</button>
          <button className={drawer === 'history' ? 'selected' : ''} aria-label={drawer === 'history' ? '关闭记录面板' : '打开记录面板'} aria-expanded={drawer === 'history'} onClick={() => toggleDrawer('history')}>记录</button>
          {room.status === 'FINISHED' && <button className={drawer === 'replays' ? 'selected' : ''} aria-label={drawer === 'replays' ? '关闭回放面板' : '打开回放面板'} aria-expanded={drawer === 'replays'} onClick={() => toggleDrawer('replays')}>回放</button>}
        </nav>
        {drawer && <div className="drawer-content">
          <div className="drawer-heading">
            <h2>{drawer === 'history' ? '牌局记录' : drawer === 'ranks' ? '牌型大小' : '整局回放'}</h2>
            {drawer === 'replays' && <button className="drawer-back" onClick={showSettlement}>返回排行榜</button>}
          </div>
          {drawer === 'history' && <><h3>本手记录</h3><div className="history-list">{[...displayTable.recentHistory].reverse().map((entry) => <div key={entry.index}><span>{phaseNames[entry.phase]}</span><p>{entry.text}</p></div>)}</div><h3 className="ledger-title">筹码记录</h3><div className="history-list">{[...room.ledger].reverse().slice(0, 30).map((entry) => <div key={entry.index}><span>牌桌</span><p>{entry.text}</p></div>)}</div></>}
          {drawer === 'ranks' && <ol className="rank-list">{rankExamples.map((rank) => <li key={rank.name}><strong>{rank.name}</strong><div className="rank-example" aria-label={`${rank.name}示例`}>{rank.cards.map((card) => <CardFace card={card} small key={card} />)}</div></li>)}</ol>}
          {drawer === 'replays' && <><p className="drawer-empty">选择一手查看这一整局的过程。</p><div className="replay-list">{room.replays.map((item) => <button key={item.handId} onClick={() => onGetReplay(item.handId)}><strong>第 {item.handNumber} 手</strong><span>{item.resultText}</span><small>{item.actionCount} 次动作</small></button>)}</div></>}
        </div>}
      </aside>
      {settlementOpen && !replay && <MatchSettlement
        room={room}
        table={displayTable}
        onClose={() => setSettlementOpen(false)}
        onViewReplays={() => { setSettlementOpen(false); setDrawer('replays'); }}
        onReturnLobby={onLeave}
      />}
      {confirmingDisband && <ConfirmDialog
        title="解散当前牌局？"
        description="当前牌局会立即结束，所有玩家都会返回大厅。"
        busy={busy}
        onCancel={() => setConfirmingDisband(false)}
        onConfirm={onDisband}
      />}
      {confirmingDecline && <ConfirmDialog
        title="放弃本局？"
        description="放弃后不能再次加入本局，但可以继续观战并查看最终排名。"
        busy={busy}
        cancelLabel="继续考虑"
        confirmLabel="确认放弃"
        busyLabel="正在确认…"
        onCancel={() => setConfirmingDecline(false)}
        onConfirm={() => { setConfirmingDecline(false); onDeclineRebuy(); }}
      />}
    </section>

    {!browsingReplays && <footer className={`action-dock${drawer ? ' panel-open' : ''}${canRequestRebuy ? ' decision-mode' : ''}`} aria-label={replay ? '回放控制' : '玩家操作'}>
      {isHost && pendingRebuys.length > 0 && <div className="rebuy-requests">{pendingRebuys.map((player) => <div key={player.id}><span>{player.name} 申请补充 {room.rebuyAmount.toLocaleString()}</span><button disabled={busy} onClick={() => onResolveRebuy(player.id, false)}>拒绝</button><button className="primary" disabled={busy} onClick={() => onResolveRebuy(player.id, true)}>批准</button></div>)}</div>}
      {replay ? <div className="replay-controls">
        <button onClick={() => setReplayStep((step) => Math.max(0, step - 1))}>上一步</button>
        <button className="primary" onClick={() => setPlayingReplay((playing) => !playing)}>{playingReplay ? '暂停' : '播放'}</button>
        <input aria-label="回放进度" type="range" min="0" max={replay.actions.length} value={replayStep} onChange={(event) => setReplayStep(Number(event.target.value))} />
        <span>{replayStep}/{replay.actions.length}</span>
        <button onClick={() => downloadReplay(replay)}>导出 JSON</button>
        <button onClick={onClearReplay}>退出回放</button>
      </div> : <>
        {raiseOpen && legal.minRaiseTo !== null && <div className="raise-panel" role="dialog" aria-label="加注设置"><div className="quick-row">{quickRaises.map((item) => <button key={item.label} onClick={() => setRaiseTo(item.value)}>{item.label}</button>)}<button onClick={() => setRaiseTo(legal.maxRaiseTo)}>全下</button></div><label><span>加注到</span><output>{raiseTo.toLocaleString()}</output><input type="range" min={legal.minRaiseTo} max={legal.maxRaiseTo} value={raiseTo} onChange={(event) => setRaiseTo(Number(event.target.value))} /></label><button className="confirm" onClick={() => act({ type: 'RAISE', raiseTo })}>确认加注</button></div>}
        {room.status === 'FINISHED' ? <button className="match-finished" onClick={() => setSettlementOpen(true)}>整局结束 · 查看排行榜</button>
          : canRequestRebuy ? <div className="bust-decision"><div className="decision-copy"><span>本手已结束</span><strong>筹码已用完</strong><p>补充后从下一手返回牌桌；放弃后仍可观战和查看排名。</p></div><div className="decision-actions"><button className="decline" disabled={busy} onClick={() => setConfirmingDecline(true)}>放弃本局</button><button className="primary" disabled={busy} onClick={onRequestRebuy}>申请补充 {room.rebuyAmount.toLocaleString()}</button></div></div>
          : isObserver ? <div className="observer-bar"><span>{observerText}</span></div>
          : pausedForPlayers ? <div className="round-paused"><span><strong>牌局暂停</strong>{waitingRebuyPlayers.length > 0 ? `等待 ${waitingRebuyPlayers.length} 名玩家决定是否补充筹码` : fundedPlayers[0] ? `${fundedPlayers[0].id === room.viewerPlayerId ? '你' : fundedPlayers[0].name} 暂时领先 · ${fundedPlayers[0].stack.toLocaleString()}` : '暂无可参赛玩家'}</span></div>
            : displayTable.phase === 'FINISHED' ? <p className="auto-next-hand">{room.status === 'PAUSED' ? '牌局已暂停，等待玩家补充筹码' : '下一手即将自动开始…'}</p>
              : viewerGamePlayer?.allIn && !viewerGamePlayer.folded ? <p className="auto-next-hand">已全下，等待本手结算</p>
                : !isHeroTurn ? <p className="waiting-action">{currentPlayerLabel ? `等待 ${currentPlayerLabel}行动` : '正在同步牌局'}</p>
                  : <div className="main-actions"><button disabled={!can('FOLD')} onClick={() => act({ type: 'FOLD' })}>弃牌</button><button disabled={!can(mainAction.action.type)} onClick={() => act(mainAction.action)}>{mainAction.label}</button><button className="primary raise-trigger" disabled={!can('RAISE') && !can('ALL_IN')} onClick={() => legal.types.includes('RAISE') ? setRaiseOpen((open) => !open) : act({ type: 'ALL_IN' })}>{thirdLabel}</button></div>}
        {(notice || busy || !canRequestRebuy) && <p className={notice?.tone === 'error' ? 'notice error' : 'notice'}>{notice ? <><span>{notice.message}</span><button aria-label="关闭提示" onClick={onDismissNotice}>×</button></> : busy ? '正在确认…' : isObserver ? observerText : isHeroTurn ? '请选择你的行动' : '当前操作区将在轮到你时出现'}</p>}
      </>}
    </footer>}
  </main>;
}
