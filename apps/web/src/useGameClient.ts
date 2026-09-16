import { useCallback, useEffect, useRef, useState } from 'react';
import type { HandReplay, PlayerAction, PlayerView, TableView } from '@holdem/core';
import { PROTOCOL_VERSION, type ClientMessage, type RoomSummary, type RoomView, type ServerMessage, type SessionView, type SimulationReport } from '@holdem/protocol';

const sessionKey = 'holdem-lab-session';
let actionSequence = 0;

function createActionId() {
  const random = new Uint32Array(2);
  globalThis.crypto?.getRandomValues?.(random);
  actionSequence = (actionSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `action-${Date.now().toString(36)}-${random[0].toString(36)}${random[1].toString(36)}-${actionSequence.toString(36)}`;
}

export interface ClientNotice {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

export type AuthenticationState = 'CHECKING' | 'AUTHENTICATED' | 'REQUIRED';

function appPath(path: string) {
  const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  return `${basePath}${path.replace(/^\/+/, '')}`;
}

function websocketUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL as string;
  const url = new URL(appPath('ws'), window.location.origin);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function useGameClient() {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef(0);
  const noticeTimerRef = useRef(0);
  const noticeIdRef = useRef(0);
  const pendingActionRef = useRef<{ resolve: (table: TableView) => void; reject: (error: Error) => void; timer: number } | null>(null);
  const [connection, setConnection] = useState<'CONNECTING' | 'OPEN' | 'CLOSED'>('CONNECTING');
  const [authentication, setAuthentication] = useState<AuthenticationState>('CHECKING');
  const [authenticationError, setAuthenticationError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [table, setTable] = useState<TableView | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [replay, setReplay] = useState<HandReplay | null>(null);
  const [simulation, setSimulation] = useState<SimulationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ClientNotice | null>(null);

  const clearNotice = useCallback(() => {
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = 0;
    setNotice(null);
  }, []);

  const showNotice = useCallback((message: string, tone: ClientNotice['tone'], duration = 0) => {
    window.clearTimeout(noticeTimerRef.current);
    const id = ++noticeIdRef.current;
    setNotice({ id, message, tone });
    if (duration > 0) {
      noticeTimerRef.current = window.setTimeout(() => {
        setNotice((current) => current?.id === id ? null : current);
        noticeTimerRef.current = 0;
      }, duration);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void fetch(appPath('api/auth/status'), { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('无法确认登录状态');
        return response.json() as Promise<{ authenticated: boolean }>;
      })
      .then((status) => {
        if (!disposed) setAuthentication(status.authenticated ? 'AUTHENTICATED' : 'REQUIRED');
      })
      .catch(() => {
        if (!disposed) {
          setAuthenticationError('无法连接身份服务');
          setAuthentication('REQUIRED');
        }
      });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (authentication !== 'AUTHENTICATED') return;
    let disposed = false;
    let initialConnectTimer = 0;
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
          if (message.session.token) sessionStorage.setItem(sessionKey, message.session.token);
          else sessionStorage.removeItem(sessionKey);
          setSession(message.session);
        } else if (message.type === 'LOBBY') {
          setSession(message.session);
          setRooms(message.rooms);
          setBusy(false);
        } else if (message.type === 'ROOM') {
          setRoom(message.room);
          setTable(message.table ?? null);
          setView(message.view ?? null);
          setSession((current) => current ? { ...current, roomId: message.room.id, roomPresence: 'AT_TABLE' } : current);
          clearNotice();
          setBusy(false);
          const pending = pendingActionRef.current;
          if (pending && message.table) {
            window.clearTimeout(pending.timer);
            pendingActionRef.current = null;
            pending.resolve(message.table);
          }
        } else if (message.type === 'ROOM_CLOSED') {
          const pending = pendingActionRef.current;
          if (pending) {
            window.clearTimeout(pending.timer);
            pendingActionRef.current = null;
            pending.reject(new Error(message.message));
          }
          setRoom(null);
          setTable(null);
          setView(null);
          setReplay(null);
          setSession((current) => current ? { token: current.token, playerId: current.playerId, name: current.name } : current);
          showNotice(message.message, 'info', 4000);
          setBusy(false);
        } else if (message.type === 'REPLAY') {
          setReplay(message.replay);
          setBusy(false);
        } else if (message.type === 'SIMULATION_RESULT') {
          setSimulation(message.result);
          setBusy(false);
        } else {
          if (message.table) {
            setTable(message.table);
            setView(message.view ?? null);
          }
          showNotice(message.message, 'error', 6000);
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
        if (socketRef.current === socket) socketRef.current = null;
        setConnection('CLOSED');
        void fetch(appPath('api/auth/status'), { credentials: 'same-origin', cache: 'no-store' })
          .then(async (response) => response.ok ? response.json() as Promise<{ authenticated: boolean }> : { authenticated: true })
          .then((status) => {
            if (disposed) return;
            if (!status.authenticated) {
              sessionStorage.removeItem(sessionKey);
              setSession(null);
              setAuthenticationError('登录已过期，请重新输入邀请码');
              setAuthentication('REQUIRED');
              return;
            }
            reconnectRef.current = window.setTimeout(connect, 1200);
          })
          .catch(() => {
            if (!disposed) reconnectRef.current = window.setTimeout(connect, 1200);
          });
      };
    };
    // Defer the first side effect so React StrictMode can complete its
    // development-only setup/cleanup pass without opening a disposable socket.
    initialConnectTimer = window.setTimeout(connect, 0);
    return () => {
      disposed = true;
      window.clearTimeout(initialConnectTimer);
      window.clearTimeout(reconnectRef.current);
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
    };
  }, [authentication, clearNotice, showNotice]);

  useEffect(() => () => window.clearTimeout(noticeTimerRef.current), []);

  const send = useCallback((message: ClientMessage, showBusy = true) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      showNotice('游戏服务正在重新连接', 'error', 5000);
      return false;
    }
    if (showBusy) setBusy(true);
    clearNotice();
    socket.send(JSON.stringify(message));
    return true;
  }, [clearNotice, showNotice]);

  const submitAction = useCallback((action: PlayerAction) => new Promise<TableView>((resolve, reject) => {
    if (!table || !view || table.currentPlayerId !== view.viewerId) {
      const error = new Error('现在没有轮到你行动，牌桌状态可能仍在同步');
      showNotice(error.message, 'error', 5000);
      reject(error);
      return;
    }
    if (pendingActionRef.current) {
      const error = new Error('上一动作仍在确认');
      showNotice(error.message, 'error', 5000);
      reject(error);
      return;
    }
    const timer = window.setTimeout(() => {
      pendingActionRef.current = null;
      setBusy(false);
      const error = new Error('等待牌桌确认超时，请检查游戏服务连接');
      showNotice(error.message, 'error', 6000);
      reject(error);
    }, 6000);
    pendingActionRef.current = { resolve, reject, timer };
    const sent = send({ type: 'ACTION', actionId: createActionId(), handId: table.handId, expectedVersion: table.version, action });
    if (!sent) {
      window.clearTimeout(timer);
      pendingActionRef.current = null;
      reject(new Error('牌桌尚未连接'));
    }
  }), [send, showNotice, table, view]);

  const leaveRoom = useCallback(() => {
    if (send({ type: 'LEAVE_ROOM' })) {
      setRoom(null);
      setTable(null);
      setView(null);
      setReplay(null);
      setSession((current) => current ? { token: current.token, playerId: current.playerId, name: current.name } : current);
    }
  }, [send]);

  const leaveTable = useCallback(() => {
    if (send({ type: 'LEAVE_TABLE' })) {
      setRoom(null);
      setTable(null);
      setView(null);
      setReplay(null);
      setSession((current) => current ? { ...current, roomPresence: 'AWAY' } : current);
    }
  }, [send]);

  const loginWithInvite = useCallback(async (code: string) => {
    setAuthenticationError(null);
    const response = await fetch(appPath('api/auth/invite'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      const message = result.error ?? '邀请码登录失败';
      setAuthenticationError(message);
      throw new Error(message);
    }
    setAuthentication('AUTHENTICATED');
  }, []);

  return {
    authentication, authenticationError, loginWithInvite,
    connection, session, rooms, room, table, view, replay, simulation, busy, notice,
    clearReplay: () => setReplay(null),
    clearNotice,
    refreshRooms: () => send({ type: 'LIST_ROOMS' }, false),
    createRoom: (message: Omit<Extract<ClientMessage, { type: 'CREATE_ROOM' }>, 'type'>) => send({ type: 'CREATE_ROOM', ...message }),
    joinRoom: (roomId: string, playerName: string) => send({ type: 'JOIN_ROOM', roomId, playerName }),
    returnRoom: () => send({ type: 'RETURN_ROOM' }),
    leaveRoom,
    leaveTable,
    disbandRoom: () => send({ type: 'DISBAND_ROOM' }),
    requestRebuy: () => send({ type: 'REQUEST_REBUY' }),
    declineRebuy: () => send({ type: 'DECLINE_REBUY' }),
    resolveRebuy: (playerId: string, approved: boolean) => send({ type: 'RESOLVE_REBUY', playerId, approved }),
    startGame: () => send({ type: 'START_GAME' }),
    newHand: () => send({ type: 'NEW_HAND' }),
    submitAction,
    getReplay: (handId: string) => send({ type: 'GET_REPLAY', handId }),
    runSimulation: (hands: number, playerCount: number, seed: number) => send({ type: 'RUN_SIMULATION', hands, playerCount, seed }),
  };
}
