import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { playerView, replayHand, type ActionType, type Card, type HandReplay, type PlayerAction, type PlayerView } from '@holdem/core';
import type { RoomView } from '@holdem/protocol';
import { CardFace } from './CardFace';

const phaseNames: Record<PlayerView['phase'], string> = {
  PRE_FLOP: '翻牌前', FLOP: '翻牌', TURN: '转牌', RIVER: '河牌', SHOWDOWN: '摊牌', FINISHED: '本手结束',
};

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
  view: PlayerView;
  replay: HandReplay | null;
  connection: 'CONNECTING' | 'OPEN' | 'CLOSED';
  busy: boolean;
  notice: string;
  onAction: (action: PlayerAction) => Promise<PlayerView>;
  onLeave: () => void;
  onGetReplay: (handId: string) => void;
  onClearReplay: () => void;
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

export function PokerTable({ room, view, replay, connection, busy, notice, onAction, onLeave, onGetReplay, onClearReplay }: PokerTableProps) {
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

  const displayView = useMemo(() => {
    if (!replay) return view;
    const replayState = replayHand(replay, replayStep);
    const viewerId = replay.setup.players.some((player) => player.id === view.viewerId) ? view.viewerId : replay.setup.players[0].id;
    return playerView(replayState, viewerId);
  }, [replay, replayStep, view]);
  const hero = displayView.players.find((player) => player.id === displayView.viewerId);
  const isHeroTurn = !replay && displayView.currentPlayerId === displayView.viewerId;
  const legal = displayView.legalActions;
  const can = (type: ActionType) => Boolean(isHeroTurn && !busy && legal.types.includes(type));
  useEffect(() => {
    if (legal.minRaiseTo !== null) setRaiseTo(legal.minRaiseTo);
    setRaiseOpen(false);
  }, [legal.minRaiseTo, displayView.version]);

  const quickRaises = useMemo(() => {
    if (!hero || legal.minRaiseTo === null) return [];
    const base = hero.streetBet + legal.callAmount;
    const clamp = (amount: number) => Math.max(legal.minRaiseTo!, Math.min(legal.maxRaiseTo, Math.round(amount)));
    return [
      { label: '½ 底池', value: clamp(base + .5 * (displayView.pot + legal.callAmount)) },
      { label: '¾ 底池', value: clamp(base + .75 * (displayView.pot + legal.callAmount)) },
      { label: '底池', value: clamp(base + displayView.pot + legal.callAmount) },
    ];
  }, [displayView.pot, hero, legal]);

  const viewerIndex = Math.max(0, displayView.players.findIndex((player) => player.id === displayView.viewerId));
  const currentIndex = displayView.players.findIndex((player) => player.id === displayView.currentPlayerId);
  let nextPlayerId: string | null = null;
  if (currentIndex >= 0) {
    for (let step = 1; step < displayView.players.length; step += 1) {
      const candidate = displayView.players[(currentIndex + step) % displayView.players.length];
      if (candidate.inHand && !candidate.folded && !candidate.allIn) { nextPlayerId = candidate.id; break; }
    }
  }
  const currentPlayer = displayView.players.find((player) => player.id === displayView.currentPlayerId);
  const remaining = !replay && room.turnDeadline ? Math.max(0, Math.ceil((room.turnDeadline - now) / 1000)) : null;
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

  return <main className="game-shell" data-card-theme={cardTheme}>
    <header className="topbar">
      <div><p className="eyebrow">HOLDEM LAB · #{room.id}</p><h1>{room.name}</h1></div>
      <div className="table-meta" aria-label="牌桌信息"><span>{room.playerCount} 人桌</span><span>盲注 {room.smallBlind}/{room.bigBlind}</span><span className={`status-pill ${connection.toLowerCase()}`}>{connection === 'OPEN' ? '已连接' : '正在重连'}</span><button className="ghost compact theme-toggle" onClick={toggleCardTheme}>卡面：{cardTheme === 'classic' ? '经典' : '高对比'}</button><button className="ghost compact" onClick={onLeave}>离桌</button></div>
    </header>

    <section className="play-area" aria-label="德州扑克牌桌">
      <div className="turn-banner"><span />{replay ? `回放 ${replay.handId}` : displayView.phase === 'FINISHED' ? displayView.resultText : currentPlayer ? `轮到 ${currentPlayer.name} 行动` : '正在同步牌局'}<strong>#{displayView.handId.split('-')[1]}</strong></div>
      <div className={`table seats-${displayView.players.length}`}>
        <div className="felt-mark">H</div>
        <div className="pot"><small>{phaseNames[displayView.phase]} · {displayView.pots.length > 1 ? `${displayView.pots.length} 个底池` : '底池'}</small><strong>{displayView.pot.toLocaleString()}</strong>{displayView.pots.length > 1 && <em>{displayView.pots.map((pot) => pot.amount).join(' / ')}</em>}</div>
        <div className="community" aria-label="公共牌">{[0, 1, 2, 3, 4].map((index) => <CardFace card={displayView.board[index]} key={index} />)}</div>

        {displayView.players.map((player, index) => {
          const ownCards = player.id === displayView.viewerId ? displayView.holeCards : displayView.revealedCards[player.id];
          const roomPlayer = room.players.find((item) => item.id === player.id);
          const roles = [player.id === displayView.dealerId ? '庄家' : '', player.id === displayView.smallBlindId ? '小盲' : '', player.id === displayView.bigBlindId ? '大盲' : ''].filter(Boolean);
          return <article
            className={`seat ${player.id === displayView.viewerId ? 'hero' : ''} ${player.id === displayView.currentPlayerId ? 'active' : ''} ${player.id === nextPlayerId ? 'next' : ''} ${displayView.winnerIds.includes(player.id) ? 'winner' : ''} ${player.folded ? 'folded' : ''}`}
            style={seatPosition(index, viewerIndex, displayView.players.length)} key={player.id}
          >
            <div className="seat-cards">{ownCards ? ownCards.map((card) => <CardFace card={card} key={card} />) : player.inHand ? <><CardFace card="2s" hidden /><CardFace card="3s" hidden /></> : null}</div>
            <div className="seat-card">
              <div className={`avatar ${player.kind.toLowerCase()}`}>{player.kind === 'BOT' ? 'AI' : player.id === displayView.viewerId ? '你' : player.name[0]}</div>
              <div><strong>{player.id === displayView.viewerId ? '你' : player.name}</strong><small>{player.kind === 'BOT' ? 'Bot' : '玩家'}{player.folded ? ' · 已弃牌' : player.allIn ? ' · All-in' : roomPlayer && !roomPlayer.connected ? ' · 离线' : ''}</small></div>
              <span>{player.stack.toLocaleString()}</span>
            </div>
            {roles.length > 0 && <div className="position-badges" aria-label={`${player.name}的位置`}>{roles.map((role) => <span key={role}>{role}</span>)}</div>}
            {displayView.handRanks[player.id] && <div className="rank-chip">{displayView.handRanks[player.id].description || displayView.handRanks[player.id].name}</div>}
            {player.streetBet > 0 && <div className="bet-chip">{player.streetBet}</div>}
            {player.id === displayView.currentPlayerId && remaining !== null && <div className={`countdown ${remaining <= 5 ? 'urgent' : ''}`}>{remaining}</div>}
          </article>;
        })}
      </div>

      <nav className="tool-rail" aria-label="辅助信息">
        <button className={drawer === 'ranks' ? 'selected' : ''} onClick={() => toggleDrawer('ranks')}>牌型</button>
        <button className={drawer === 'history' ? 'selected' : ''} onClick={() => toggleDrawer('history')}>记录</button>
        {room.status === 'FINISHED' && <button className={drawer === 'replays' ? 'selected' : ''} onClick={() => toggleDrawer('replays')}>回放</button>}
      </nav>
      <aside className={`drawer ${drawer ? 'visible' : ''}`} aria-live="polite">
        {drawer === 'history' && <><h2>本手记录</h2><div className="history-list">{[...displayView.recentHistory].reverse().map((entry) => <div key={entry.index}><span>{phaseNames[entry.phase]}</span><p>{entry.text}</p></div>)}</div></>}
        {drawer === 'ranks' && <><h2>牌型大小</h2><ol className="rank-list">{rankExamples.map((rank) => <li key={rank.name}><strong>{rank.name}</strong><div className="rank-example" aria-label={`${rank.name}示例`}>{rank.cards.map((card) => <CardFace card={card} small key={card} />)}</div></li>)}</ol></>}
        {drawer === 'replays' && <><h2>整局回放</h2><p className="drawer-empty">选择一手查看这一整局的过程。</p><div className="replay-list">{room.replays.map((item) => <button key={item.handId} onClick={() => onGetReplay(item.handId)}><strong>第 {item.handNumber} 手</strong><span>{item.resultText}</span><small>{item.actionCount} 次动作</small></button>)}</div></>}
      </aside>
    </section>

    <footer className="action-dock" aria-label="玩家操作">
      {replay ? <div className="replay-controls">
        <button onClick={() => setReplayStep((step) => Math.max(0, step - 1))}>上一步</button>
        <button className="primary" onClick={() => setPlayingReplay((playing) => !playing)}>{playingReplay ? '暂停' : '播放'}</button>
        <input aria-label="回放进度" type="range" min="0" max={replay.actions.length} value={replayStep} onChange={(event) => setReplayStep(Number(event.target.value))} />
        <span>{replayStep}/{replay.actions.length}</span>
        <button onClick={() => downloadReplay(replay)}>导出 JSON</button>
        <button onClick={onClearReplay}>退出回放</button>
      </div> : <>
        {raiseOpen && legal.minRaiseTo !== null && <div className="raise-panel" role="dialog" aria-label="加注设置"><div className="quick-row">{quickRaises.map((item) => <button key={item.label} onClick={() => setRaiseTo(item.value)}>{item.label}</button>)}<button onClick={() => setRaiseTo(legal.maxRaiseTo)}>全下</button></div><label><span>加注到</span><output>{raiseTo.toLocaleString()}</output><input type="range" min={legal.minRaiseTo} max={legal.maxRaiseTo} value={raiseTo} onChange={(event) => setRaiseTo(Number(event.target.value))} /></label><button className="confirm" onClick={() => act({ type: 'RAISE', raiseTo })}>确认加注</button></div>}
        {displayView.phase === 'FINISHED' ? room.status === 'FINISHED' ? <p className="match-finished">整局结束</p> : <p className="auto-next-hand">下一手即将自动开始…</p> : <div className="main-actions"><button disabled={!can('FOLD')} onClick={() => act({ type: 'FOLD' })}>弃牌</button><button disabled={!can(mainAction.action.type)} onClick={() => act(mainAction.action)}>{mainAction.label}</button><button className="primary raise-trigger" disabled={!can('RAISE') && !can('ALL_IN')} onClick={() => legal.types.includes('RAISE') ? setRaiseOpen((open) => !open) : act({ type: 'ALL_IN' })}>{thirdLabel}</button></div>}
        <p className={notice ? 'notice error' : 'notice'}>{notice || (busy ? '正在确认动作…' : room.status === 'FINISHED' ? '整局已结束，可以查看回放' : displayView.phase === 'FINISHED' ? '正在准备下一手' : isHeroTurn ? '请选择你的行动' : '等待其他玩家行动')}</p>
      </>}
    </footer>
  </main>;
}
