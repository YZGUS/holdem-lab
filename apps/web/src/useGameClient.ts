import { useCallback, useEffect, useRef, useState } from 'react';
import type { HandReplay, PlayerAction, PlayerView } from '@holdem/core';
import { PROTOCOL_VERSION, type ClientMessage, type RoomSummary, type RoomView, type ServerMessage, type SessionView, type SimulationReport } from '@holdem/protocol';

const sessionKey = 'holdem-lab-session';

function websocketUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL as string;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return import.meta.env.DEV ? `${protocol}://${window.location.hostname}:8787` : `${protocol}://${window.location.host}`;
}

export function useGameClient() {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef(0);
  const pendingActionRef = useRef<{ resolve: (view: PlayerView) => void; reject: (error: Error) => void; timer: number } | null>(null);
  const [connection, setConnection] = useState<'CONNECTING' | 'OPEN' | 'CLOSED'>('CONNECTING');
  const [session, setSession] = useState<SessionView | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [replay, setReplay] = useState<HandReplay | null>(null);
  const [simulation, setSimulation] = useState<SimulationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let disposed = false;
    const connect = () => {
      setConnection('CONNECTING');
      const socket = new WebSocket(websocketUrl());
      socketRef.current = socket;
      socket.onopen = () => {
        if (disposed) return;
        setConnection('OPEN');
        const sessionToken = sessionStorage.getItem(sessionKey) ?? undefined;
        socket.send(JSON.stringify({ type: 'HELLO', protocolVersion: PROTOCOL_VERSION, ...(sessionToken ? { sessionToken } : {}) } satisfies ClientMessage));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === 'WELCOME') {
          sessionStorage.setItem(sessionKey, message.session.token);
          setSession(message.session);
        } else if (message.type === 'LOBBY') {
          setSession(message.session);
          setRooms(message.rooms);
          setBusy(false);
        } else if (message.type === 'ROOM') {
          setRoom(message.room);
          setView(message.view ?? null);
          setSession((current) => current ? { ...current, roomId: message.room.id, roomPresence: 'AT_TABLE' } : current);
          setNotice('');
          setBusy(false);
          const pending = pendingActionRef.current;
          if (pending && message.view) {
            window.clearTimeout(pending.timer);
            pendingActionRef.current = null;
            pending.resolve(message.view);
          }
        } else if (message.type === 'ROOM_CLOSED') {
          const pending = pendingActionRef.current;
          if (pending) {
            window.clearTimeout(pending.timer);
            pendingActionRef.current = null;
            pending.reject(new Error(message.message));
          }
          setRoom(null);
          setView(null);
          setReplay(null);
          setSession((current) => current ? { token: current.token, playerId: current.playerId, name: current.name } : current);
          setNotice(message.message);
          setBusy(false);
        } else if (message.type === 'REPLAY') {
          setReplay(message.replay);
          setBusy(false);
        } else if (message.type === 'SIMULATION_RESULT') {
          setSimulation(message.result);
          setBusy(false);
        } else {
          if (message.view) setView(message.view);
          setNotice(message.message);
          setBusy(false);
          const pending = pendingActionRef.current;
          if (pending) {
            window.clearTimeout(pending.timer);
            pendingActionRef.current = null;
            pending.reject(new Error(message.message));
          }
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnection('CLOSED');
        reconnectRef.current = window.setTimeout(connect, 1200);
      };
    };
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectRef.current);
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback((message: ClientMessage, showBusy = true) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setNotice('正在重新连接服务');
      return false;
    }
    if (showBusy) setBusy(true);
    setNotice('');
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const submitAction = useCallback((action: PlayerAction) => new Promise<PlayerView>((resolve, reject) => {
    if (!view || view.currentPlayerId !== view.viewerId) {
      reject(new Error('现在没有轮到你行动'));
      return;
    }
    if (pendingActionRef.current) {
      reject(new Error('上一动作仍在确认'));
      return;
    }
    const timer = window.setTimeout(() => {
      pendingActionRef.current = null;
      setBusy(false);
      reject(new Error('等待牌桌确认超时'));
    }, 6000);
    pendingActionRef.current = { resolve, reject, timer };
    const sent = send({ type: 'ACTION', actionId: crypto.randomUUID(), handId: view.handId, expectedVersion: view.version, action });
    if (!sent) {
      window.clearTimeout(timer);
      pendingActionRef.current = null;
      reject(new Error('牌桌尚未连接'));
    }
  }), [send, view]);

  const leaveRoom = useCallback(() => {
    if (send({ type: 'LEAVE_ROOM' })) {
      setRoom(null);
      setView(null);
      setReplay(null);
      setSession((current) => current ? { token: current.token, playerId: current.playerId, name: current.name } : current);
    }
  }, [send]);

  const leaveTable = useCallback(() => {
    if (send({ type: 'LEAVE_TABLE' })) {
      setRoom(null);
      setView(null);
      setReplay(null);
      setSession((current) => current ? { ...current, roomPresence: 'AWAY' } : current);
    }
  }, [send]);

  return {
    connection, session, rooms, room, view, replay, simulation, busy, notice,
    clearReplay: () => setReplay(null),
    clearNotice: () => setNotice(''),
    refreshRooms: () => send({ type: 'LIST_ROOMS' }, false),
    createRoom: (message: Omit<Extract<ClientMessage, { type: 'CREATE_ROOM' }>, 'type'>) => send({ type: 'CREATE_ROOM', ...message }),
    joinRoom: (roomId: string, playerName: string) => send({ type: 'JOIN_ROOM', roomId, playerName }),
    returnRoom: () => send({ type: 'RETURN_ROOM' }),
    leaveRoom,
    leaveTable,
    disbandRoom: () => send({ type: 'DISBAND_ROOM' }),
    startGame: () => send({ type: 'START_GAME' }),
    newHand: () => send({ type: 'NEW_HAND' }),
    submitAction,
    getReplay: (handId: string) => send({ type: 'GET_REPLAY', handId }),
    runSimulation: (hands: number, playerCount: number, seed: number) => send({ type: 'RUN_SIMULATION', hands, playerCount, seed }),
  };
}
