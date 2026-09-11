import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { applyAction, createHeadsUpGame, decisionContext, playerView, type GameState, type PlayerAction } from '@holdem/core';
import { clientMessageSchema, type ServerMessage } from '@holdem/protocol';

const port = Number(process.env.PORT ?? 8787);
const server = new WebSocketServer({ port });
const clients = new Set<WebSocket>();
const handledActionIds = new Set<string>();
let handNumber = 1;
let state: GameState = createHeadsUpGame(nextSeed(), handNumber);

function nextSeed() {
  return randomBytes(4).readUInt32LE(0);
}

function send(client: WebSocket, message: ServerMessage) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}

function broadcastState() {
  const message: ServerMessage = { type: 'STATE', view: playerView(state, 'hero') };
  clients.forEach((client) => send(client, message));
}

function replaceState(action: PlayerAction) {
  const result = applyAction(state, action);
  if (!result.ok) return result.error;
  state = result.state;
  broadcastState();
  scheduleBot();
}

function chooseBotAction(): PlayerAction {
  const legal = decisionContext(state, 'nova').legalActions;
  if (legal.types.includes('CHECK')) return { type: 'CHECK' };
  if (legal.types.includes('CALL')) return { type: 'CALL' };
  return { type: 'FOLD' };
}

function scheduleBot() {
  if (state.currentPlayerIndex === null || state.players[state.currentPlayerIndex].id !== 'nova') return;
  const expectedHand = state.handId;
  const expectedVersion = state.version;
  setTimeout(() => {
    if (state.handId !== expectedHand || state.version !== expectedVersion || state.currentPlayerIndex === null || state.players[state.currentPlayerIndex].id !== 'nova') return;
    replaceState(chooseBotAction());
  }, 650);
}

server.on('connection', (client) => {
  clients.add(client);
  send(client, { type: 'STATE', view: playerView(state, 'hero') });

  client.on('message', (raw) => {
    let data: unknown;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      send(client, { type: 'ERROR', message: '消息格式无效' });
      return;
    }
    const parsed = clientMessageSchema.safeParse(data);
    if (!parsed.success) {
      send(client, { type: 'ERROR', message: '动作参数无效', view: playerView(state, 'hero') });
      return;
    }
    const message = parsed.data;
    if (message.type === 'NEW_HAND') {
      if (state.phase !== 'FINISHED') {
        send(client, { type: 'ERROR', message: '当前手牌尚未结束', view: playerView(state, 'hero') });
        return;
      }
      handNumber += 1;
      const stacks = state.players.map((player) => player.stack) as [number, number];
      state = createHeadsUpGame(nextSeed(), handNumber, stacks.includes(0) ? [2000, 2000] : stacks);
      handledActionIds.clear();
      broadcastState();
      scheduleBot();
      return;
    }
    if (handledActionIds.has(message.actionId)) {
      send(client, { type: 'STATE', view: playerView(state, 'hero') });
      return;
    }
    if (message.handId !== state.handId || message.expectedVersion !== state.version) {
      send(client, { type: 'ERROR', message: '牌局已经推进，已为你刷新状态', view: playerView(state, 'hero') });
      return;
    }
    if (state.currentPlayerIndex === null || state.players[state.currentPlayerIndex].id !== 'hero') {
      send(client, { type: 'ERROR', message: '现在还没轮到你', view: playerView(state, 'hero') });
      return;
    }
    const error = replaceState(message.action);
    if (error) {
      send(client, { type: 'ERROR', message: error, view: playerView(state, 'hero') });
      return;
    }
    handledActionIds.add(message.actionId);
  });

  client.on('close', () => clients.delete(client));
});

server.on('listening', () => {
  console.log(`Holdem server listening on ws://127.0.0.1:${port}`);
  scheduleBot();
});
