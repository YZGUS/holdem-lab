import { useState } from 'react';
import type { RoomView } from '@holdem/protocol';
import { ConfirmDialog } from './ConfirmDialog';

export function WaitingRoom({ room, connection, busy, onStart, onLeave, onDisband }: { room: RoomView; connection: string; busy: boolean; onStart: () => void; onLeave: () => void; onDisband: () => void }) {
  const [confirmingDisband, setConfirmingDisband] = useState(false);
  const isHost = room.hostPlayerId === room.viewerPlayerId;
  const waitingToStart = room.status === 'WAITING';
  const copyCode = () => navigator.clipboard?.writeText(room.id);
  return <main className="waiting-shell">
    <header className="room-header">
      <div><p className="eyebrow">HOLDEM LAB · LOBBY</p><h1>{room.name}</h1></div>
      <div className="room-actions"><span className="status-pill open">{connection === 'OPEN' ? '已连接' : '正在重连'}</span>{isHost && <button className="ghost danger" disabled={busy} onClick={() => setConfirmingDisband(true)}>解散房间</button>}<button className="ghost" onClick={onLeave}>{waitingToStart ? '离开房间' : '离桌'}</button></div>
    </header>
    <section className="waiting-card">
      <div className="code-block"><span>房间码</span><strong>{room.id}</strong><button onClick={copyCode}>复制</button></div>
      <div className="waiting-copy"><p>同一局域网的玩家打开本机地址，输入房间码即可入座。</p><span>{room.gameMode === 'POINTS' ? '积分桌' : '淘汰赛'} · {room.smallBlind}/{room.bigBlind} 盲注 · {room.startingStack.toLocaleString()} 起始筹码 · {room.maxHands === null ? '不限手数' : `${room.maxHands} 手`}</span></div>
      <div className="seat-list">
        {Array.from({ length: room.maxPlayers }, (_, seat) => {
          const player = room.players.find((item) => item.seat === seat);
          return <article className={player ? 'occupied' : ''} key={seat}>
            <span>{seat + 1}</span>
            {player ? <><div className={`mini-avatar ${player.kind.toLowerCase()}`}>{player.kind === 'BOT' ? 'AI' : player.name[0]}</div><div><strong>{player.name}{player.id === room.hostPlayerId ? ' · 房主' : ''}</strong><small>{player.kind === 'BOT' ? '基础策略 Bot' : player.connected ? '已连接' : '等待重连'}</small></div></> : <div><strong>空座位</strong><small>等待玩家加入</small></div>}
          </article>;
        })}
      </div>
      {waitingToStart ? isHost ? <button className="primary start-button" disabled={busy || room.players.length < 2} onClick={onStart}>开始牌局</button> : <p className="waiting-note">等待房主开始牌局</p> : <p className="waiting-note">已返回牌桌，将从下一手加入</p>}
    </section>
    {confirmingDisband && <ConfirmDialog
      title="解散这个房间？"
      description="房间码将立即失效，所有玩家都会返回大厅。"
      busy={busy}
      onCancel={() => setConfirmingDisband(false)}
      onConfirm={onDisband}
    />}
  </main>;
}
