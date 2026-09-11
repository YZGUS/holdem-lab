import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActionType, Card, PlayerView } from '@holdem/core';
import type { ClientMessage, ServerMessage } from '@holdem/protocol';

type WireAction = Extract<ClientMessage, { type: 'ACTION' }>['action'];

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

function CardFace({ card, hidden = false }: { card?: Card; hidden?: boolean }) {
  if (!card) return <i className="card-slot" />;
  if (hidden) return <i className="card-face card-back" aria-label="隐藏牌" />;
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = ({ s: '♠', h: '♥', d: '♦', c: '♣' } as const)[card[1] as 's' | 'h' | 'd' | 'c'];
  const red = card[1] === 'h' || card[1] === 'd';
  return <i className={`card-face ${red ? 'red' : ''}`} aria-label={`${rank}${suit}`}><b>{rank}</b><span>{suit}</span></i>;
}

export function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const viewRef = useRef<PlayerView | null>(null);
  const pendingToolRef = useRef<{ resolve: (view: PlayerView) => void; reject: (error: Error) => void } | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [connection, setConnection] = useState<'CONNECTING' | 'OPEN' | 'CLOSED'>('CONNECTING');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [drawer, setDrawer] = useState<'history' | 'ranks' | null>(null);
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [raiseTo, setRaiseTo] = useState(40);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer = 0;
    const connect = () => {
      setConnection('CONNECTING');
      const socket = new WebSocket(`ws://${window.location.hostname}:8787`);
      socketRef.current = socket;
      socket.onopen = () => !disposed && setConnection('OPEN');
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === 'STATE') {
          viewRef.current = message.view;
          setView(message.view);
          const pending = pendingToolRef.current;
          pendingToolRef.current = null;
          pending?.resolve(message.view);
          setBusy(false);
          setNotice('');
          setRaiseOpen(false);
        } else {
          if (message.view) {
            viewRef.current = message.view;
            setView(message.view);
          }
          pendingToolRef.current?.reject(new Error(message.message));
          pendingToolRef.current = null;
          setNotice(message.message);
          setBusy(false);
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnection('CLOSED');
        reconnectTimer = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
    };
  }, []);

  const hero = view?.players.find((player) => player.id === 'hero');
  const bot = view?.players.find((player) => player.id === 'nova');
  const isHeroTurn = view?.currentPlayerId === 'hero';
  const legal = view?.legalActions;
  const can = (type: ActionType) => Boolean(isHeroTurn && !busy && legal?.types.includes(type));

  useEffect(() => {
    if (legal?.minRaiseTo !== null && legal?.minRaiseTo !== undefined) setRaiseTo(legal.minRaiseTo);
  }, [legal?.minRaiseTo, view?.version]);

  const send = (message: ClientMessage) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setNotice('正在重新连接牌桌');
      return;
    }
    setBusy(true);
    socketRef.current.send(JSON.stringify(message));
  };
  const sendAction = (action: WireAction) => {
    if (!view) return;
    send({ type: 'ACTION', actionId: crypto.randomUUID(), handId: view.handId, expectedVersion: view.version, action });
  };

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: 'submit_holdem_action',
      title: '提交扑克行动',
      description: '在轮到当前玩家时，提交过牌、跟注、弃牌、加注或全下，并等待牌桌确认。',
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
      execute(input) {
        const data = input as { action?: ActionType; raiseTo?: number };
        const current = viewRef.current;
        const socket = socketRef.current;
        if (!current || current.currentPlayerId !== 'hero') throw new Error('现在没有轮到玩家行动');
        if (!data.action || !current.legalActions.types.includes(data.action)) throw new Error('该动作当前不合法');
        if (data.action === 'RAISE' && (!Number.isInteger(data.raiseTo) || data.raiseTo! < current.legalActions.minRaiseTo! || data.raiseTo! > current.legalActions.maxRaiseTo)) throw new Error('加注金额超出合法范围');
        if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('牌桌尚未连接');
        if (pendingToolRef.current) throw new Error('上一动作仍在确认');
        const action = data.action === 'RAISE' ? { type: 'RAISE' as const, raiseTo: data.raiseTo! } : { type: data.action } as WireAction;
        return new Promise((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            pendingToolRef.current = null;
            reject(new Error('等待牌桌确认超时'));
          }, 5000);
          pendingToolRef.current = {
            resolve: (next) => { window.clearTimeout(timeout); resolve({ handId: next.handId, version: next.version, phase: next.phase, result: next.resultText ?? null }); },
            reject: (error) => { window.clearTimeout(timeout); reject(error); },
          };
          socket.send(JSON.stringify({ type: 'ACTION', actionId: crypto.randomUUID(), handId: current.handId, expectedVersion: current.version, action } satisfies ClientMessage));
        });
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  const quickRaises = useMemo(() => {
    if (!legal || !hero || legal.minRaiseTo === null || !view) return [];
    const base = hero.streetBet + legal.callAmount;
    const clamp = (amount: number) => Math.max(legal.minRaiseTo!, Math.min(legal.maxRaiseTo, Math.round(amount)));
    return [
      { label: '½ 底池', value: clamp(base + .5 * (view.pot + legal.callAmount)) },
      { label: '¾ 底池', value: clamp(base + .75 * (view.pot + legal.callAmount)) },
      { label: '底池', value: clamp(base + view.pot + legal.callAmount) },
    ];
  }, [hero, legal, view]);

  const mainAction = legal?.types.includes('CHECK')
    ? { label: '过牌', action: { type: 'CHECK' } as WireAction }
    : { label: `跟注 ${legal?.callAmount ?? 0}`, action: { type: 'CALL' } as WireAction };
  const currentName = view?.currentPlayerId === 'hero' ? '你' : view?.currentPlayerId === 'nova' ? 'Nova' : null;
  const thirdLabel = legal?.types.includes('RAISE') ? '加注' : legal?.types.includes('ALL_IN') ? '全下' : '加注';

  return (
    <main className="game-shell">
      <header className="topbar">
        <div><p className="eyebrow">HOLDEM LAB</p><h1>本机练习桌</h1></div>
        <div className="table-meta" aria-label="牌桌信息">
          <span>单挑桌</span><span>盲注 10 / 20</span>
          <span className={`connection ${connection.toLowerCase()}`}>{connection === 'OPEN' ? '本机已连接' : connection === 'CONNECTING' ? '连接中' : '正在重连'}</span>
        </div>
      </header>

      <section className={`play-area ${drawer ? 'drawer-open' : ''}`} aria-label="德州扑克牌桌">
        <div className="turn-banner"><span />{view?.phase === 'FINISHED' ? view.resultText : currentName ? `轮到 ${currentName} 行动` : '正在同步牌局'}<strong>{view ? `#${view.handId.split('-')[1]}` : '—'}</strong></div>
        <div className="table">
          <div className="felt-mark">H</div>
          <div className="pot"><small>{phaseNames[view?.phase ?? 'PRE_FLOP']} · 底池</small><strong>{view?.pot.toLocaleString() ?? '—'}</strong></div>
          <div className="community" aria-label="公共牌">{[0, 1, 2, 3, 4].map((index) => <CardFace card={view?.board[index]} key={index} />)}</div>

          <article className={`seat north ${view?.currentPlayerId === 'nova' ? 'active' : ''} ${view?.winnerIds.includes('nova') ? 'winner' : ''}`}>
            <div className="opponent-cards">{view?.opponentCards ? view.opponentCards.map((card) => <CardFace card={card} key={card} />) : <><CardFace card={'2s'} hidden /><CardFace card={'3s'} hidden /></>}</div>
            <div className="seat-card"><div className="avatar">AI</div><div><strong>Nova</strong><small>{view?.dealerId === 'nova' ? '庄家 · 小盲' : '大盲'}{bot?.folded ? ' · 已弃牌' : ''}</small></div><span>{bot?.stack.toLocaleString() ?? '—'}</span></div>
            {bot && bot.streetBet > 0 && <div className="bet-chip">{bot.streetBet}</div>}
          </article>

          <article className={`seat south hero ${view?.currentPlayerId === 'hero' ? 'active' : ''} ${view?.winnerIds.includes('hero') ? 'winner' : ''}`}>
            <div className="hole-cards">{view?.holeCards.map((card) => <CardFace card={card} key={card} />)}</div>
            <div className="seat-card"><div className="avatar">你</div><div><strong>你</strong><small>{view?.dealerId === 'hero' ? '庄家 · 小盲' : '大盲'}{hero?.folded ? ' · 已弃牌' : ''}</small></div><span>{hero?.stack.toLocaleString() ?? '—'}</span></div>
            {hero && hero.streetBet > 0 && <div className="bet-chip">{hero.streetBet}</div>}
          </article>
        </div>

        <nav className="tool-rail" aria-label="辅助信息">
          <button className={drawer === 'ranks' ? 'selected' : ''} onClick={() => setDrawer(drawer === 'ranks' ? null : 'ranks')}>牌型</button>
          <button className={drawer === 'history' ? 'selected' : ''} onClick={() => setDrawer(drawer === 'history' ? null : 'history')}>记录</button>
        </nav>
        <aside className={`drawer ${drawer ? 'visible' : ''}`} aria-live="polite">
          {drawer === 'history' && <><h2>本手记录</h2><div className="history-list">{[...(view?.recentHistory ?? [])].reverse().map((entry) => <div key={entry.index}><span>{phaseNames[entry.phase]}</span><p>{entry.text}</p></div>)}</div></>}
          {drawer === 'ranks' && <><h2>牌型大小</h2><ol className="rank-list">{rankExamples.map((rank) => <li key={rank.name}><strong>{rank.name}</strong><div className="rank-example" aria-label={`${rank.name}示例`}>{rank.cards.map((card) => <CardFace card={card} key={card} />)}</div></li>)}</ol></>}
        </aside>
      </section>

      <footer className="action-dock" aria-label="玩家操作">
        {raiseOpen && legal && legal.minRaiseTo !== null && <div className="raise-panel">
          <div className="quick-row">{quickRaises.map((item) => <button key={item.label} onClick={() => setRaiseTo(item.value)}>{item.label}</button>)}<button onClick={() => setRaiseTo(legal.maxRaiseTo)}>全下</button></div>
          <label><span>加注到</span><output>{raiseTo.toLocaleString()}</output><input type="range" min={legal.minRaiseTo} max={legal.maxRaiseTo} step="1" value={raiseTo} onChange={(event) => setRaiseTo(Number(event.target.value))} /></label>
          <button className="confirm" onClick={() => sendAction({ type: 'RAISE', raiseTo })}>确认加注</button>
        </div>}
        {view?.phase === 'FINISHED' ? <button className="new-hand" disabled={busy} onClick={() => send({ type: 'NEW_HAND' })}>开始下一手</button> : <div className="main-actions">
          <button disabled={!can('FOLD')} onClick={() => sendAction({ type: 'FOLD' })}>弃牌</button>
          <button disabled={!can(mainAction.action.type)} onClick={() => sendAction(mainAction.action)}>{mainAction.label}</button>
          <button className="primary" disabled={!can('RAISE') && !can('ALL_IN')} onClick={() => legal?.types.includes('RAISE') ? setRaiseOpen((open) => !open) : sendAction({ type: 'ALL_IN' })}>{thirdLabel}</button>
        </div>}
        <p className={notice ? 'notice error' : 'notice'}>{notice || (busy ? '正在确认动作…' : isHeroTurn ? '请选择你的行动' : '等待对手行动')}</p>
      </footer>
    </main>
  );
}
