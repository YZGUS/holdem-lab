import { useMemo, useState, type FormEvent } from 'react';
import type { RoomSummary, SessionView, SimulationReport } from '@holdem/protocol';

interface LobbyProps {
  connection: 'CONNECTING' | 'OPEN' | 'CLOSED';
  session: SessionView | null;
  rooms: RoomSummary[];
  simulation: SimulationReport | null;
  busy: boolean;
  notice: string;
  onCreate: (config: { roomName: string; playerName: string; maxPlayers: number; botCount: number; startingStack: number; smallBlind: number; bigBlind: number; turnSeconds: number }) => void;
  onJoin: (roomId: string, playerName: string) => void;
  onRefresh: () => void;
  onSimulate: (hands: number, playerCount: number, seed: number) => void;
}

export function Lobby({ connection, session, rooms, simulation, busy, notice, onCreate, onJoin, onRefresh, onSimulate }: LobbyProps) {
  const [playerName, setPlayerName] = useState(() => sessionStorage.getItem('holdem-lab-name') ?? session?.name ?? '玩家');
  const [roomName, setRoomName] = useState('周末牌局');
  const [roomCode, setRoomCode] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(6);
  const [botCount, setBotCount] = useState(1);
  const [hands, setHands] = useState(100);
  const [simulationPlayers, setSimulationPlayers] = useState(6);
  const [seed, setSeed] = useState(2026);
  const maxWins = useMemo(() => Math.max(1, ...Object.values(simulation?.wins ?? {})), [simulation]);

  const rememberName = () => sessionStorage.setItem('holdem-lab-name', playerName.trim());
  const create = (event: FormEvent) => {
    event.preventDefault();
    rememberName();
    onCreate({ roomName, playerName, maxPlayers, botCount: Math.min(botCount, maxPlayers - 1), startingStack: 2000, smallBlind: 10, bigBlind: 20, turnSeconds: 30 });
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
        <label>你的名字<input value={playerName} maxLength={16} onChange={(event) => setPlayerName(event.target.value)} required /></label>
        <label>房间名称<input value={roomName} maxLength={30} onChange={(event) => setRoomName(event.target.value)} required /></label>
        <div className="form-row">
          <label>座位数<select value={maxPlayers} onChange={(event) => setMaxPlayers(Number(event.target.value))}>{[2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value} value={value}>{value} 人桌</option>)}</select></label>
          <label>Bot 数量<select value={Math.min(botCount, maxPlayers - 1)} onChange={(event) => setBotCount(Number(event.target.value))}>{Array.from({ length: maxPlayers }, (_, value) => <option key={value} value={value}>{value}</option>)}</select></label>
        </div>
        <button className="primary wide" disabled={busy || connection !== 'OPEN'}>创建并入座</button>
      </form>

      <section className="panel rooms-panel">
        <div className="panel-heading"><div><span>局域网大厅</span><h2>加入现有房间</h2></div><button className="text-button" onClick={onRefresh}>刷新</button></div>
        <div className="join-code"><input aria-label="房间码" placeholder="输入 6 位房间码" maxLength={6} value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} /><button disabled={busy || roomCode.trim().length < 4} onClick={() => join(roomCode)}>加入</button></div>
        <div className="room-list">
          {rooms.length === 0 && <div className="empty-state"><strong>暂无公开房间</strong><span>创建后，同一局域网内的设备即可加入。</span></div>}
          {rooms.map((room) => <article key={room.id} className="room-row">
            <div><strong>{room.name}</strong><span>#{room.id} · {room.smallBlind}/{room.bigBlind} · {room.botCount} Bot</span></div>
            <span>{room.playerCount}/{room.maxPlayers}</span>
            <button disabled={busy || room.status !== 'WAITING'} onClick={() => join(room.id)}>{room.status === 'WAITING' ? '加入' : '进行中'}</button>
          </article>)}
        </div>
      </section>

      <section className="panel simulation-panel">
        <div className="panel-heading"><div><span>批量模拟</span><h2>基础策略自对战</h2></div><b>LAB</b></div>
        <div className="form-row three">
          <label>手数<input type="number" min="1" max="1000" value={hands} onChange={(event) => setHands(Number(event.target.value))} /></label>
          <label>人数<select value={simulationPlayers} onChange={(event) => setSimulationPlayers(Number(event.target.value))}>{[2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>种子<input type="number" min="0" max="4294967295" value={seed} onChange={(event) => setSeed(Number(event.target.value))} /></label>
        </div>
        <button className="secondary wide" disabled={busy || connection !== 'OPEN'} onClick={() => onSimulate(hands, simulationPlayers, seed)}>运行模拟</button>
        {simulation && <div className="simulation-result">
          <p>{simulation.hands} 手牌 · 平均 {simulation.averageActions} 次动作</p>
          {Object.entries(simulation.wins).map(([id, wins], index) => <div className="result-row" key={id}><span>Bot {index + 1}</span><i><b style={{ width: `${wins / maxWins * 100}%` }} /></i><strong>{wins}</strong></div>)}
        </div>}
        <small>Monte Carlo、CFR、GTO、RL 已预留统一策略插件接口，当前不执行这些算法。</small>
      </section>
    </section>
    {notice && <div className="toast error" role="alert">{notice}</div>}
    <footer className="lobby-footer">会话 {session?.playerId.slice(-6) ?? '建立中'} · 当前页面刷新后可自动恢复</footer>
  </main>;
}
