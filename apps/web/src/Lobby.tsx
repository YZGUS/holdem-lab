import { useState, type FormEvent } from 'react';
import type { ClientMessage, GameMode, RoomSummary, SessionView } from '@holdem/protocol';
import type { ClientNotice } from './useGameClient';

type CreateRoomConfig = Omit<Extract<ClientMessage, { type: 'CREATE_ROOM' }>, 'type'>;

interface LobbyProps {
  connection: 'CONNECTING' | 'OPEN' | 'CLOSED';
  session: SessionView | null;
  rooms: RoomSummary[];
  busy: boolean;
  notice: ClientNotice | null;
  onCreate: (config: CreateRoomConfig) => void;
  onJoin: (roomId: string, playerName: string) => void;
  onReturn: () => void;
  onRefresh: () => void;
  onDismissNotice: () => void;
}
export function Lobby({ connection, session, rooms, busy, notice, onCreate, onJoin, onReturn, onRefresh, onDismissNotice }: LobbyProps) {
  const [playerName, setPlayerName] = useState(() => sessionStorage.getItem('holdem-lab-name') ?? session?.name ?? '玩家');
  const [roomName, setRoomName] = useState('周末牌局');
  const [roomCode, setRoomCode] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(6);
  const [botCount, setBotCount] = useState(1);
  const [gameMode, setGameMode] = useState<GameMode>('POINTS');
  const [startingStack, setStartingStack] = useState(2000);
  const [smallBlind, setSmallBlind] = useState(10);
  const [bigBlind, setBigBlind] = useState(20);
  const [maxHands, setMaxHands] = useState(0);
  const [rebuyEnabled, setRebuyEnabled] = useState(true);
  const [rebuyAmount, setRebuyAmount] = useState(1000);
  const [maxRebuys, setMaxRebuys] = useState(3);

  const rememberName = () => sessionStorage.setItem('holdem-lab-name', playerName.trim());
  const create = (event: FormEvent) => {
    event.preventDefault();
    rememberName();
    onCreate({
      roomName,
      playerName,
      maxPlayers,
      botCount: Math.min(botCount, maxPlayers - 1),
      startingStack,
      smallBlind,
      bigBlind,
      turnSeconds: 30,
      gameMode,
      maxHands: maxHands || null,
      rebuyEnabled: gameMode === 'POINTS' && rebuyEnabled,
      rebuyAmount,
      maxRebuys: maxRebuys || null,
    });
  };
  const join = (id: string) => {
    rememberName();
    onJoin(id.trim().toUpperCase(), playerName);
  };

  return <main className="lobby-shell">
    <header className="lobby-header">
      <div><p className="eyebrow">HOLDEM LAB</p><h1>德州扑克实验桌</h1><p>本机与局域网共用同一套权威规则。</p></div>
      <span className={`status-pill ${connection.toLowerCase()}`}>{connection === 'OPEN' ? '服务已连接' : connection === 'CONNECTING' ? '正在连接' : '正在重连'}</span>
    </header>

    <section className="lobby-grid">
      <form className="panel create-panel" onSubmit={create}>
        <div className="panel-heading"><div><span>创建房间</span><h2>开一张新牌桌</h2></div><b>01</b></div>
        <div className="form-row">
          <label>你的名字<input value={playerName} maxLength={16} onChange={(event) => setPlayerName(event.target.value)} required /></label>
          <label>房间名称<input value={roomName} maxLength={30} onChange={(event) => setRoomName(event.target.value)} required /></label>
        </div>
        <div className="form-row">
          <label>牌局模式<select value={gameMode} onChange={(event) => setGameMode(event.target.value as GameMode)}><option value="POINTS">积分桌</option><option value="TOURNAMENT">淘汰赛</option></select></label>
          <label>牌局长度<select value={maxHands} onChange={(event) => setMaxHands(Number(event.target.value))}><option value={0}>不限手数</option><option value={20}>20 手</option><option value={50}>50 手</option><option value={100}>100 手</option></select></label>
        </div>
        <div className="form-row">
          <label>座位数<select value={maxPlayers} onChange={(event) => setMaxPlayers(Number(event.target.value))}>{[2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value} value={value}>{value} 人桌</option>)}</select></label>
          <label>Bot 数量<select value={Math.min(botCount, maxPlayers - 1)} onChange={(event) => setBotCount(Number(event.target.value))}>{Array.from({ length: maxPlayers }, (_, value) => <option key={value} value={value}>{value}</option>)}</select></label>
        </div>
        <div className="form-row three">
          <label>起始筹码<input type="number" min={200} max={100000} value={startingStack} onChange={(event) => setStartingStack(Number(event.target.value))} /></label>
          <label>小盲<input type="number" min={1} max={10000} value={smallBlind} onChange={(event) => setSmallBlind(Number(event.target.value))} /></label>
          <label>大盲<input type="number" min={2} max={20000} value={bigBlind} onChange={(event) => setBigBlind(Number(event.target.value))} /></label>
        </div>
        {gameMode === 'POINTS' && <div className="rebuy-config">
          <label>补充筹码<select value={rebuyEnabled ? 'ON' : 'OFF'} onChange={(event) => setRebuyEnabled(event.target.value === 'ON')}><option value="ON">房主审批</option><option value="OFF">不允许</option></select></label>
          <label>每次补充<input type="number" min={100} max={100000} value={rebuyAmount} disabled={!rebuyEnabled} onChange={(event) => setRebuyAmount(Number(event.target.value))} /></label>
          <label>每人上限<select value={maxRebuys} disabled={!rebuyEnabled} onChange={(event) => setMaxRebuys(Number(event.target.value))}><option value={1}>1 次</option><option value={3}>3 次</option><option value={5}>5 次</option><option value={0}>不限</option></select></label>
        </div>}
        <p className="config-note">{gameMode === 'POINTS' ? '筹码用完后留桌观战，可申请补充并从下一手加入。' : '筹码用完后留桌观战，直到决出最后一名玩家。'}</p>
        <button className="primary wide" disabled={busy || connection !== 'OPEN' || Boolean(session?.roomId)}>{session?.roomId ? '请先返回原牌桌' : '创建并入座'}</button>
      </form>

      <section className="panel rooms-panel">
        <div className="panel-heading"><div><span>局域网大厅</span><h2>加入现有房间</h2></div><button className="text-button" onClick={onRefresh}>刷新</button></div>
        <div className="join-code"><input aria-label="房间码" placeholder="输入 6 位房间码" maxLength={6} value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} /><button disabled={busy || Boolean(session?.roomId) || roomCode.trim().length < 4} onClick={() => join(roomCode)}>加入</button></div>
        <div className="room-list">
          {rooms.length === 0 && <div className="empty-state"><strong>暂无公开房间</strong><span>创建后，同一局域网内的设备即可加入。</span></div>}
          {rooms.map((room) => {
            const canReturn = room.membership === 'AWAY';
            const label = canReturn ? '返回牌桌' : room.membership === 'AT_TABLE' ? '牌桌中' : room.status === 'WAITING' ? '加入' : room.status === 'PAUSED' ? '已暂停' : room.status === 'FINISHED' ? '已结束' : '进行中';
            const length = room.maxHands === null ? '不限手数' : `${room.maxHands} 手`;
            return <article key={room.id} className="room-row">
              <div><strong>{room.name}</strong><span>#{room.id} · {room.gameMode === 'POINTS' ? '积分桌' : '淘汰赛'} · {room.smallBlind}/{room.bigBlind} · {length}</span></div>
              <span>{room.playerCount}/{room.maxPlayers}</span>
              <button disabled={busy || (!canReturn && (Boolean(session?.roomId) || room.status !== 'WAITING'))} onClick={() => canReturn ? onReturn() : join(room.id)}>{label}</button>
            </article>;
          })}
        </div>
      </section>
    </section>
    {notice && <div className={`toast ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}><span>{notice.message}</span><button aria-label="关闭提示" onClick={onDismissNotice}>×</button></div>}
    <footer className="lobby-footer">会话 {session?.playerId.slice(-6) ?? '建立中'} · 当前页面刷新后可自动恢复</footer>
  </main>;
}
