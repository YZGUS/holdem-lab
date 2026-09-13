import type { TableView } from '@holdem/core';
import type { RoomView } from '@holdem/protocol';

interface MatchSettlementProps {
  room: RoomView;
  table: TableView;
  onClose: () => void;
  onViewReplays: () => void;
  onReturnLobby: () => void;
}

function signed(value: number) {
  return `${value > 0 ? '+' : ''}${value.toLocaleString()}`;
}

export function MatchSettlement({ room, table, onClose, onViewReplays, onReturnLobby }: MatchSettlementProps) {
  const standings = [...room.players].sort((left, right) => right.stack - left.stack || left.seat - right.seat);
  const highestStack = standings[0]?.stack ?? 0;
  const leaders = standings.filter((player) => player.stack === highestStack);
  const champion = leaders.length === 1 ? leaders[0] : null;

  return <div className="match-settlement-backdrop">
    <section className="match-settlement" role="dialog" aria-modal="true" aria-labelledby="settlement-title">
      <button className="settlement-close" aria-label="关闭排行榜" onClick={onClose}>×</button>
      <header className="settlement-heading">
        <p className="eyebrow">{room.gameMode === 'TOURNAMENT' ? '淘汰赛' : '积分桌'} · 共 {table.handNumber} 手</p>
        <h2 id="settlement-title">最终排行榜</h2>
        <p>本局已经结束，排名按最终筹码计算</p>
      </header>
      <div className="champion-block">
        <span>{champion?.kind === 'BOT' ? 'AI' : champion?.id === room.viewerPlayerId ? '你' : champion?.name[0] ?? '·'}</span>
        <div><small>{champion ? champion.id === room.viewerPlayerId ? '你赢得了本局' : '本局冠军' : '并列第一'}</small><strong>{champion?.id === room.viewerPlayerId ? '你' : champion?.name ?? leaders.map((player) => player.name).join(' / ')}</strong></div>
      </div>
      {champion && <dl className="settlement-stats">
        <div><dt>最终筹码</dt><dd>{champion.stack.toLocaleString()}</dd></div>
        <div><dt>总带入</dt><dd>{champion.buyInTotal.toLocaleString()}</dd></div>
        <div><dt>净成绩</dt><dd className={champion.stack - champion.buyInTotal >= 0 ? 'positive' : 'negative'}>{signed(champion.stack - champion.buyInTotal)}</dd></div>
      </dl>}
      <div className="standings-heading" aria-hidden="true"><span>排名 / 玩家</span><span>最终筹码</span><span>净成绩</span></div>
      <div className="standings" aria-label="最终排行榜">
        {standings.map((player, index) => {
          const rank = standings.findIndex((item) => item.stack === player.stack) + 1;
          const net = player.stack - player.buyInTotal;
          return <div className={player.id === champion?.id ? 'champion' : ''} key={player.id}>
            <b>#{rank}</b>
            <span>{player.id === room.viewerPlayerId ? '你' : player.name}<small>{player.kind === 'BOT' ? 'Bot' : '玩家'}</small></span>
            <strong>{player.stack.toLocaleString()}</strong>
            <em className={net >= 0 ? 'positive' : 'negative'}>{signed(net)}</em>
          </div>;
        })}
      </div>
      <footer>
        <button onClick={onViewReplays}>查看整局回放</button>
        <button className="primary" onClick={onReturnLobby}>返回大厅</button>
      </footer>
    </section>
  </div>;
}
