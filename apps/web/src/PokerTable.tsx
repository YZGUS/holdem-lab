import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  playerView, replayHand, tableView, type ActionType, type Card, type HandReplay,
  type LegalActions, type PlayerAction, type PlayerView, type PublicPlayer, type TableView,
} from '@holdem/core';
import type { RoomView } from '@holdem/protocol';
import { CardFace } from './CardFace';
import type { ClientNotice } from './useGameClient';

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

export function PokerTable({
  room, table, view, replay, connection, busy, notice, onAction, onLeave, onDisband,
  onRequestRebuy, onResolveRebuy, onGetReplay, onClearReplay, onDismissNotice,
}: PokerTableProps) {
  const [drawer, setDrawer] = useState<'history' | 'ranks' | 'replays' | null>(null);
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [raiseTo, setRaiseTo] = useState(40);
  const [replayStep, setReplayStep] = useState(0);
  const [playingReplay, setPlayingReplay] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [cardTheme, setCardTheme] = useState<'classic' | 'contrast'>(() => sessionStorage.getItem('holdem-card-theme') === 'contrast' ? 'contrast' : 'classic');

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
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
  const can = (type: ActionType) => Boolean(isHeroTurn && !busy && legal.types.includes(type));

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
  const remaining = !replay && room.turnDeadline ? Math.max(0, Math.ceil((room.turnDeadline - now) / 1000)) : null;
  const isHost = room.hostPlayerId === room.viewerPlayerId;
  const pendingRebuys = room.players.filter((player) => player.rebuyStatus === 'PENDING');
  const isObserver = !displayPrivate || (viewerRoomPlayer.stack === 0 && displayTable.phase === 'FINISHED');
  const canRequestRebuy = room.gameMode === 'POINTS'
    && room.rebuyEnabled
    && viewerRoomPlayer.stack === 0
    && viewerRoomPlayer.rebuyStatus === 'NONE'
    && (room.maxRebuys === null || viewerRoomPlayer.rebuyCount < room.maxRebuys);
  const mainAction = legal.types.includes('CHECK')
    ? { label: '过牌', action: { type: 'CHECK' } as PlayerAction }
    : { label: `跟注 ${legal.callAmount}`, action: { type: 'CALL' } as PlayerAction };
  const thirdLabel = legal.types.includes('RAISE') ? '加注' : legal.types.includes('ALL_IN') ? '全下' : '加注';
  const act = (action: PlayerAction) => void onAction(action).catch(() => undefined);
  const toggleDrawer = (next: typeof drawer) => setDrawer((current) => current === next ? null : next);
  const toggleCardTheme = () => setCardTheme((current) => {
    const next = current === 'classic' ? 'contrast' : 'classic';
    sessionStorage.setItem('holdem-card-theme', next);
    return next;
  });
  const disband = () => {
    if (window.confirm('确定解散房间？当前牌局将立即结束，所有玩家都会返回大厅。')) onDisband();
  };

  const observerText = viewerRoomPlayer.stack === 0
    ? viewerRoomPlayer.rebuyStatus === 'PENDING' ? '补充申请等待房主处理'
      : viewerRoomPlayer.rebuyStatus === 'APPROVED' ? '补充已批准，将从下一手加入'
        : '筹码已用完，正在观战'
    : '等待下一手加入牌局';

  return <main className="game-shell" data-card-theme={cardTheme}>
    <header className="topbar">
      <div className="table-identity"><p className="eyebrow">HOLDEM LAB · #{room.id}</p><h1>{room.name}</h1></div>
      <div className="hand-stage" aria-label="牌局进度"><strong>第 {displayTable.handNumber} 手</strong><span>{phaseNames[displayTable.phase]}</span></div>
      <div className="table-meta" aria-label="牌桌信息"><span>{room.gameMode === 'POINTS' ? '积分桌' : '淘汰赛'}</span><span>盲注 {room.smallBlind}/{room.bigBlind}</span><span className={`status-pill ${connection.toLowerCase()}`}>{connection === 'OPEN' ? '已连接' : '正在重连'}</span><button className="ghost compact theme-toggle" onClick={toggleCardTheme}>卡面：{cardTheme === 'classic' ? '经典' : '高对比'}</button>{isHost && <button className="ghost compact danger" disabled={busy} onClick={disband}>解散</button>}<button className="ghost compact" onClick={onLeave}>离桌</button></div>
    </header>

    <section className={`play-area${drawer ? ' panel-open' : ''}`} aria-label="德州扑克牌桌">
      <div className="turn-banner"><span />{replay ? `第 ${displayTable.handNumber} 手回放` : displayTable.phase === 'FINISHED' ? displayTable.resultText : currentPlayerLabel ? `轮到${currentPlayerLabel === '你' ? '你' : ` ${currentPlayerLabel}`}行动` : room.status === 'PAUSED' ? '牌局已暂停' : '正在同步牌局'}</div>
      <div className={`table seats-${room.players.length}`}>
        <div className="felt-mark">H</div>
        <div className="pot"><small>{phaseNames[displayTable.phase]} · {displayTable.pots.length > 1 ? `${displayTable.pots.length} 个底池` : '底池'}</small><strong>{displayTable.pot.toLocaleString()}</strong>{displayTable.pots.length > 1 && <em>{displayTable.pots.map((pot) => pot.amount).join(' / ')}</em>}</div>
        <div className="community" aria-label="公共牌">{[0, 1, 2, 3, 4].map((index) => <CardFace card={displayTable.board[index]} key={index} />)}</div>

        {room.players.map((roomPlayer, index) => {
          const player = gamePlayerOrObserver(roomPlayer, displayTable.players.find((item) => item.id === roomPlayer.id));
          const ownCards = player.id === room.viewerPlayerId ? displayPrivate?.holeCards : displayTable.revealedCards[player.id];
          const roles = [player.id === displayTable.dealerId ? '庄家' : '', player.id === displayTable.smallBlindId ? '小盲' : '', player.id === displayTable.bigBlindId ? '大盲' : ''].filter(Boolean);
          const stateText = roomPlayer.presence === 'AWAY' ? '暂离' : roomPlayer.stack === 0 && !player.allIn ? '观战' : !player.inHand ? '等待下一手' : player.folded ? '已弃牌' : player.allIn ? 'All-in' : !roomPlayer.connected ? '离线' : '';
          const relativeSeat = (index - viewerIndex + room.players.length) % room.players.length;
          return <article
            className={`seat ${player.id === room.viewerPlayerId ? 'hero' : ''} ${player.id === displayTable.currentPlayerId ? 'active' : ''} ${player.id === nextPlayerId ? 'next' : ''} ${displayTable.winnerIds.includes(player.id) ? 'winner' : ''} ${player.folded ? 'folded' : ''} ${!player.inHand ? 'spectator' : ''}`}
            style={seatPosition(index, viewerIndex, room.players.length)} data-position={relativeSeat} key={player.id}
          >
            <div className="seat-cards">{ownCards?.length ? ownCards.map((card) => <CardFace card={card} key={card} />) : player.inHand ? <><CardFace card="2s" hidden /><CardFace card="3s" hidden /></> : null}</div>
            <div className="seat-card">
              <div className={`avatar ${player.kind.toLowerCase()}`}>{player.kind === 'BOT' ? 'AI' : player.id === room.viewerPlayerId ? '你' : player.name[0]}</div>
              <div><strong>{player.id === room.viewerPlayerId ? '你' : player.name}</strong><small>{player.kind === 'BOT' ? 'Bot' : '玩家'}{stateText ? ` · ${stateText}` : ''}</small></div>
              <span>{roomPlayer.stack.toLocaleString()}</span>
            </div>
            {roles.length > 0 && <div className="position-badges" aria-label={`${player.name}的位置`}>{roles.map((role) => <span key={role}>{role}</span>)}</div>}
            {displayTable.handRanks[player.id] && <div className="rank-chip">{displayTable.handRanks[player.id].description || displayTable.handRanks[player.id].name}</div>}
            {player.streetBet > 0 && <div className="bet-chip">{player.streetBet}</div>}
            {player.id === displayTable.currentPlayerId && remaining !== null && <div className={`countdown ${remaining <= 5 ? 'urgent' : ''}`}>{remaining}</div>}
          </article>;
        })}
      </div>

      <aside className={`side-panel${drawer ? ' open' : ''}`} aria-live="polite">
        <nav className="tool-tabs" aria-label="辅助信息">
          <button className={drawer === 'ranks' ? 'selected' : ''} aria-expanded={drawer === 'ranks'} onClick={() => toggleDrawer('ranks')}>牌型</button>
          <button className={drawer === 'history' ? 'selected' : ''} aria-expanded={drawer === 'history'} onClick={() => toggleDrawer('history')}>记录</button>
          {room.status === 'FINISHED' && <button className={drawer === 'replays' ? 'selected' : ''} aria-expanded={drawer === 'replays'} onClick={() => toggleDrawer('replays')}>回放</button>}
        </nav>
        {drawer && <div className="drawer-content">
          <div className="drawer-heading"><h2>{drawer === 'history' ? '牌局记录' : drawer === 'ranks' ? '牌型大小' : '整局回放'}</h2><button aria-label="关闭辅助面板" onClick={() => setDrawer(null)}>关闭</button></div>
          {drawer === 'history' && <><h3>本手记录</h3><div className="history-list">{[...displayTable.recentHistory].reverse().map((entry) => <div key={entry.index}><span>{phaseNames[entry.phase]}</span><p>{entry.text}</p></div>)}</div><h3 className="ledger-title">筹码记录</h3><div className="history-list">{[...room.ledger].reverse().slice(0, 30).map((entry) => <div key={entry.index}><span>牌桌</span><p>{entry.text}</p></div>)}</div></>}
          {drawer === 'ranks' && <ol className="rank-list">{rankExamples.map((rank) => <li key={rank.name}><strong>{rank.name}</strong><div className="rank-example" aria-label={`${rank.name}示例`}>{rank.cards.map((card) => <CardFace card={card} small key={card} />)}</div></li>)}</ol>}
          {drawer === 'replays' && <><p className="drawer-empty">选择一手查看这一整局的过程。</p><div className="replay-list">{room.replays.map((item) => <button key={item.handId} onClick={() => onGetReplay(item.handId)}><strong>第 {item.handNumber} 手</strong><span>{item.resultText}</span><small>{item.actionCount} 次动作</small></button>)}</div></>}
        </div>}
      </aside>
    </section>

    <footer className="action-dock" aria-label="玩家操作">
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
        {room.status === 'FINISHED' ? <p className="match-finished">整局结束 · 共 {displayTable.handNumber} 手</p>
          : isObserver ? <div className="observer-bar"><span>{observerText}</span>{canRequestRebuy && <button className="primary" disabled={busy} onClick={onRequestRebuy}>申请补充 {room.rebuyAmount.toLocaleString()}</button>}</div>
            : displayTable.phase === 'FINISHED' ? <p className="auto-next-hand">{room.status === 'PAUSED' ? '牌局已暂停，等待玩家补充筹码' : '下一手即将自动开始…'}</p>
              : viewerGamePlayer?.allIn && !viewerGamePlayer.folded ? <p className="auto-next-hand">已全下，等待本手结算</p>
                : !isHeroTurn ? <p className="waiting-action">{currentPlayerLabel ? `等待 ${currentPlayerLabel}行动` : '正在同步牌局'}</p>
                  : <div className="main-actions"><button disabled={!can('FOLD')} onClick={() => act({ type: 'FOLD' })}>弃牌</button><button disabled={!can(mainAction.action.type)} onClick={() => act(mainAction.action)}>{mainAction.label}</button><button className="primary raise-trigger" disabled={!can('RAISE') && !can('ALL_IN')} onClick={() => legal.types.includes('RAISE') ? setRaiseOpen((open) => !open) : act({ type: 'ALL_IN' })}>{thirdLabel}</button></div>}
        <p className={notice?.tone === 'error' ? 'notice error' : 'notice'}>{notice ? <><span>{notice.message}</span><button aria-label="关闭提示" onClick={onDismissNotice}>×</button></> : busy ? '正在确认…' : isObserver ? observerText : isHeroTurn ? '请选择你的行动' : '当前操作区将在轮到你时出现'}</p>
      </>}
    </footer>
  </main>;
}
