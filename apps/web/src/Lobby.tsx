import { useState, type FormEvent } from 'react';
import type { ClientMessage, GameMode, RoomSummary, SessionView } from '@holdem/protocol';
import { SegmentedChoice, StepperControl } from './FormControls';
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

const playerNameStorageKey = 'holdem-lab-name';
const guestAlphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const roomCodeLength = 6;

function guestName() {
  const values = new Uint8Array(4);
  crypto.getRandomValues(values);
  return `玩家 ${Array.from(values, (value) => guestAlphabet[value % guestAlphabet.length]).join('')}`;
}

function initialPlayerName(session: SessionView | null) {
  const saved = localStorage.getItem(playerNameStorageKey)?.trim() || sessionStorage.getItem(playerNameStorageKey)?.trim();
  if (saved) {
    localStorage.setItem(playerNameStorageKey, saved);
    return saved;
  }
  if (session?.name && session.name !== '玩家') return session.name;
  const generated = guestName();
  localStorage.setItem(playerNameStorageKey, generated);
  return generated;
}

function roomStatus(room: RoomSummary) {
  if (room.membership === 'AWAY') return '可返回';
  if (room.membership === 'AT_TABLE') return '牌桌中';
  if (room.status === 'WAITING') return '等待加入';
  if (room.status === 'PAUSED') return '牌局暂停';
  if (room.status === 'FINISHED') return '牌局结束';
  return '进行中';
}

export function Lobby({ connection, session, rooms, busy, notice, onCreate, onJoin, onReturn, onRefresh, onDismissNotice }: LobbyProps) {
  const [playerName, setPlayerName] = useState(() => initialPlayerName(session));
  const [profileOpen, setProfileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const effectiveBotCount = Math.min(botCount, maxPlayers - 1);
  const hasPlayerName = playerName.trim().length > 0;
  const resumeRoom = session?.roomId ? rooms.find((room) => room.id === session.roomId) : undefined;
  const modeSummary = gameMode === 'POINTS' ? '积分桌' : '淘汰赛';
  const lengthSummary = maxHands ? `${maxHands} 手` : '不限手数';
  const rebuySummary = gameMode === 'POINTS' && rebuyEnabled ? `可补充 ${rebuyAmount.toLocaleString()}` : '不可补充';
  const createDisabled = busy || connection !== 'OPEN' || Boolean(session?.roomId) || !hasPlayerName;

  const rememberName = () => {
    const name = playerName.trim();
    localStorage.setItem(playerNameStorageKey, name);
    return name;
  };
  const randomizeName = () => {
    const name = guestName();
    setPlayerName(name);
    localStorage.setItem(playerNameStorageKey, name);
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    if (createDisabled) return;
    onCreate({
      roomName: roomName.trim(),
      playerName: rememberName(),
      maxPlayers,
      botCount: effectiveBotCount,
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
    setSettingsOpen(false);
  };
  const join = (id: string) => {
    if (!hasPlayerName) return;
    onJoin(id.trim().toUpperCase(), rememberName());
  };

  return <main className="lobby-shell">
    <div className="lobby-layout">
      <header className="lobby-header">
        <div className="lobby-brand">
          <p className="eyebrow">HOLDEM LAB</p>
          <h1>德州扑克实验桌</h1>
          <p>随时开桌，朋友就在身边。</p>
        </div>
        <div className="lobby-header-tools">
          <span className={`status-pill ${connection.toLowerCase()}`}>{connection === 'OPEN' ? '已连接' : connection === 'CONNECTING' ? '连接中' : '重连中'}</span>
          <div className="lobby-profile-control">
            <button className="lobby-identity" type="button" aria-expanded={profileOpen} aria-controls="lobby-profile-popover" onClick={() => setProfileOpen((open) => !open)}>
              <span className="profile-avatar" aria-hidden="true">{playerName.trim().charAt(0) || '玩'}</span>
              <span><small>本机玩家</small><strong>{playerName.trim() || '设置昵称'}</strong></span>
              <i aria-hidden="true">✎</i>
            </button>
            {profileOpen && <div className="lobby-profile-popover" id="lobby-profile-popover">
              <div><strong>玩家身份</strong><button type="button" aria-label="关闭昵称设置" onClick={() => setProfileOpen(false)}>×</button></div>
              <label>玩家昵称<input aria-invalid={!hasPlayerName} value={playerName} maxLength={16} onChange={(event) => setPlayerName(event.target.value)} autoFocus /></label>
              <p>{hasPlayerName ? '刷新后仍会保留；房间内重名会自动添加序号。' : '请先填写昵称，再创建或加入牌桌。'}</p>
              <footer><button type="button" onClick={randomizeName}>换一个</button><button className="primary" type="button" disabled={!hasPlayerName} onClick={() => { rememberName(); setProfileOpen(false); }}>完成</button></footer>
            </div>}
          </div>
        </div>
      </header>

      {session?.roomId && <section className="lobby-resume" aria-label="未结束的牌桌">
        <span className="resume-icon" aria-hidden="true">↗</span>
        <div><strong>上次牌桌仍在进行</strong><span>{resumeRoom?.name ?? '原牌桌'} · #{session.roomId}{resumeRoom ? ` · ${resumeRoom.playerCount}/${resumeRoom.maxPlayers} 人` : ''}</span></div>
        <button type="button" onClick={onReturn} disabled={busy}>返回牌桌</button>
      </section>}

      <section className="lobby-hero">
        <form className="lobby-card lobby-quick-create" onSubmit={create}>
          <div className="quick-create-copy">
            <span className="lobby-kicker">推荐设置</span>
            <h2>今晚，开一张牌桌？</h2>
            <p>使用常用规则立即开局，朋友可通过房间码加入。</p>
            <div className="lobby-rule-chips" aria-label="当前推荐设置"><span>{modeSummary}</span><span>{maxPlayers} 人桌</span><span>盲注 {smallBlind}/{bigBlind}</span></div>
            <div className="quick-create-actions">
              <button className="primary" disabled={createDisabled}>{session?.roomId ? '请先返回原牌桌' : '快速创建牌桌'}</button>
              <button type="button" onClick={() => setSettingsOpen(true)}>自定义牌桌设置 <span aria-hidden="true">→</span></button>
            </div>
          </div>
          <div className="lobby-table-art" aria-hidden="true"><span>H</span></div>
        </form>

        <form className="lobby-card lobby-join" onSubmit={(event) => { event.preventDefault(); join(roomCode); }}>
          <span className="lobby-kicker">朋友已经开桌</span>
          <h2>使用房间码加入</h2>
          <p>输入朋友分享的 6 位房间码。</p>
          <label className="room-code-field">
            <span className="sr-only">房间码</span>
            <span className="room-code-slots" aria-hidden="true">{Array.from({ length: roomCodeLength }, (_, index) => <i className={roomCode[index] ? 'filled' : ''} key={index}>{roomCode[index] ?? '—'}</i>)}</span>
            <input aria-label="房间码" autoCapitalize="characters" autoComplete="off" maxLength={roomCodeLength} value={roomCode} onChange={(event) => setRoomCode(event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase())} />
          </label>
          <div className="join-actions"><button disabled={busy || Boolean(session?.roomId) || roomCode.length < 4 || !hasPlayerName}>加入牌桌</button><small>支持键盘输入<br />或直接粘贴</small></div>
        </form>
      </section>

      <section className="lobby-rooms">
        <header><div><h2>大厅牌桌</h2><p>等待中的牌桌可以直接加入</p></div><button type="button" onClick={onRefresh} disabled={busy}><span aria-hidden="true">↻</span> 刷新</button></header>
        <div className="lobby-room-list">
          {rooms.length === 0 && <div className="lobby-room-empty"><span aria-hidden="true">◇</span><div><strong>还没有公开牌桌</strong><p>快速创建一桌，房间码会自动生成。</p></div></div>}
          {rooms.map((room) => {
            const canReturn = room.membership === 'AWAY';
            const atTable = room.membership === 'AT_TABLE';
            const canJoin = room.status === 'WAITING' && !session?.roomId && hasPlayerName;
            const humanCount = Math.max(0, room.playerCount - room.botCount);
            const playerMarks = [...Array(Math.min(humanCount, 2)).fill('玩'), ...Array(Math.min(room.botCount, 1)).fill('AI')];
            const actionLabel = canReturn ? '返回' : atTable ? '牌桌中' : room.status === 'WAITING' ? '加入' : room.status === 'PAUSED' ? '已暂停' : room.status === 'FINISHED' ? '已结束' : '进行中';
            return <article className={`lobby-room-row ${canReturn ? 'returnable' : ''}`} key={room.id}>
              <div className="lobby-room-name"><strong>{room.name}</strong><span>#{room.id} · {roomStatus(room)}</span></div>
              <span className="lobby-room-rules">{room.gameMode === 'POINTS' ? '积分桌' : '淘汰赛'} · 盲注 {room.smallBlind}/{room.bigBlind} · {room.maxHands === null ? '不限手数' : `${room.maxHands} 手`}</span>
              <div className="lobby-room-count"><span>{playerMarks.map((mark, index) => <i className={mark === 'AI' ? 'bot' : ''} key={`${mark}-${index}`}>{mark}</i>)}{room.playerCount > playerMarks.length && <i className="more">+{room.playerCount - playerMarks.length}</i>}</span><strong>{room.playerCount}/{room.maxPlayers}</strong></div>
              <button type="button" disabled={busy || (!canReturn && !canJoin)} onClick={() => canReturn ? onReturn() : join(room.id)}>{actionLabel}</button>
            </article>;
          })}
        </div>
      </section>

      <footer className="lobby-footer">本地与局域网共用同一套权威规则</footer>
    </div>

    {settingsOpen && <div className="lobby-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
      <form className="lobby-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="lobby-settings-title" onSubmit={create}>
        <header><div><span className="lobby-kicker">自定义牌桌</span><h2 id="lobby-settings-title">设置本局规则</h2><p>这些设置只影响新创建的牌桌。</p></div><button type="button" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}>×</button></header>
        <div className="settings-scroll">
          <fieldset>
            <legend>基本信息</legend>
            <label className="settings-wide">房间名称<input value={roomName} maxLength={30} onChange={(event) => setRoomName(event.target.value)} required /></label>
          </fieldset>
          <fieldset>
            <legend>牌局规则</legend>
            <SegmentedChoice label="牌局模式" value={gameMode} options={[{ value: 'POINTS', label: '积分桌' }, { value: 'TOURNAMENT', label: '淘汰赛' }]} onChange={(value) => setGameMode(value as GameMode)} />
            <SegmentedChoice label="牌局长度" value={maxHands} options={[{ value: 0, label: '不限' }, { value: 20, label: '20 手' }, { value: 50, label: '50 手' }, { value: 100, label: '100 手' }]} onChange={setMaxHands} />
          </fieldset>
          <fieldset className="settings-seat-grid">
            <legend>座位与筹码</legend>
            <StepperControl label="座位数" value={maxPlayers} min={2} max={8} formatValue={(value) => `${value} 人桌`} onChange={(value) => { setMaxPlayers(value); setBotCount((current) => Math.min(current, value - 1)); }} />
            <StepperControl label="Bot 数量" value={effectiveBotCount} min={0} max={maxPlayers - 1} formatValue={(value) => `${value} 个`} onChange={setBotCount} />
            <label>起始筹码<input type="number" inputMode="numeric" step={100} min={200} max={100000} value={startingStack} onChange={(event) => setStartingStack(Number(event.target.value))} /></label>
            <label>小盲<input type="number" inputMode="numeric" min={1} max={10000} value={smallBlind} onChange={(event) => setSmallBlind(Number(event.target.value))} /></label>
            <label>大盲<input type="number" inputMode="numeric" min={2} max={20000} value={bigBlind} onChange={(event) => setBigBlind(Number(event.target.value))} /></label>
          </fieldset>
          {gameMode === 'POINTS' && <fieldset className="settings-rebuy-grid">
            <legend>筹码补充</legend>
            <SegmentedChoice label="补充规则" value={rebuyEnabled ? 'ON' : 'OFF'} options={[{ value: 'ON', label: '房主审批' }, { value: 'OFF', label: '不允许' }]} onChange={(value) => setRebuyEnabled(value === 'ON')} />
            <label>每次补充<input type="number" inputMode="numeric" step={100} min={100} max={100000} value={rebuyAmount} disabled={!rebuyEnabled} onChange={(event) => setRebuyAmount(Number(event.target.value))} /></label>
            <SegmentedChoice className="settings-wide" label="每人上限" value={maxRebuys} disabled={!rebuyEnabled} options={[{ value: 1, label: '1 次' }, { value: 3, label: '3 次' }, { value: 5, label: '5 次' }, { value: 0, label: '不限' }]} onChange={setMaxRebuys} />
          </fieldset>}
        </div>
        <div className="settings-summary"><strong>{modeSummary} · {maxPlayers} 人桌 · {effectiveBotCount} Bot</strong><span>{startingStack.toLocaleString()} 筹码 · 盲注 {smallBlind}/{bigBlind} · {lengthSummary} · {rebuySummary}</span></div>
        <footer><button type="button" onClick={() => setSettingsOpen(false)}>取消</button><button className="primary" disabled={createDisabled}>{session?.roomId ? '请先返回原牌桌' : '使用这些设置创建'}</button></footer>
      </form>
    </div>}

    {notice && <div className={`toast ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}><span>{notice.message}</span><button aria-label="关闭提示" onClick={onDismissNotice}>×</button></div>}
  </main>;
}
