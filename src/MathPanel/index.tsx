// src/MathPanel.tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import socket from './socket';
import SessionControls from './SessionControls';
import ChatBox from './ChatBox';

type Props = { servicesManager: any };

interface User {
  id: string;
  name: string;
}

interface Message {
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
}

/** Helper to robustly get the active segmentationId from OHIF service */
function getActiveSegmentationIdSafe(segmentationService: any): string | undefined {
  try {
    if (!segmentationService) return undefined;
    if (typeof segmentationService.getActiveSegmentationId === 'function') {
      return segmentationService.getActiveSegmentationId();
    }
    if (segmentationService.state?.activeSegmentationId) {
      return segmentationService.state.activeSegmentationId;
    }
    if (typeof segmentationService.getSegmentationIds === 'function') {
      const ids = segmentationService.getSegmentationIds();
      if (Array.isArray(ids) && ids.length) return ids[0];
    }
  } catch (e) {
    console.warn('Could not determine active segmentation id:', e);
  }
  return undefined;
}

export default function MathPanel({ servicesManager }: Props) {
  const segmentationService = servicesManager?.services?.segmentationService;

  const [sessionId, setSessionId] = useState<string>('');
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isHost, setIsHost] = useState<boolean>(false);
  const [copySuccess, setCopySuccess] = useState<boolean>(false);
  const [participants, setParticipants] = useState<number>(0);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected'>(
    'disconnected'
  );
  const [error, setError] = useState<string>('');

  const [username, setUsername] = useState<string>(localStorage.getItem('username') || '');
  const [inputUsername, setInputUsername] = useState<string>('');
  const [users, setUsers] = useState<User[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState<string>('');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const generateSessionId = () => `med-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

  // Auto-scroll chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Socket lifecycle listeners
  useEffect(() => {
    const onConnect = () => {
      setConnectionStatus('connected');
      setIsConnected(true);

      // Attempt rejoin if we have persisted info
      const savedSessionId = localStorage.getItem('collabSessionId');
      const savedUsername = localStorage.getItem('username') || username;
      if (savedUsername && savedSessionId) {
        socket.emit('rejoin-session', { sessionId: savedSessionId, username: savedUsername });
        setSessionId(savedSessionId);
      }
    };

    const onDisconnect = () => {
      setConnectionStatus('disconnected');
      setIsConnected(false);
    };

    const onUpdateUsers = (usersList: User[]) => {
      setUsers(usersList);
      setParticipants(usersList.length);
    };

    const onChatMessage = (message: Message) => {
      if (message.userId !== socket.id) {
        setMessages(prev => [...prev, message]);
      }
    };

    const onParticipantUpdate = ({ count }: { count: number }) => {
      setParticipants(count);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('update-users', onUpdateUsers);
    socket.on('chat-message', onChatMessage);
    socket.on('participant-update', onParticipantUpdate);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('update-users', onUpdateUsers);
      socket.off('chat-message', onChatMessage);
      socket.off('participant-update', onParticipantUpdate);
    };
  }, [username]);

  // Subscribe to OHIF segmentation events and forward to server
  useEffect(() => {
    if (!segmentationService) {
      console.warn('Segmentation service not available; events will not be broadcast.');
      return;
    }

    const emitUpdate = (segIdFromEvent?: string) => {
      if (!isConnected || !sessionId) return;

      const currentId =
        segIdFromEvent || getActiveSegmentationIdSafe(segmentationService) || undefined;

      if (!currentId) return;

      socket.emit('update-segmentation', {
        sessionId,
        segmentation: {
          segId: currentId,
          updatedBy: username || 'unknown',
          timestamp: Date.now(),
        },
      });
    };

    const onSegmentationChange = (evt: any) => {
      const segId =
        evt?.segmentationId ||
        evt?.detail?.segmentationId ||
        evt?.detail?.segmentationRepresentationUID ||
        undefined;
      emitUpdate(segId);
    };

    const subs: any[] = [
      segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_ADDED,
        onSegmentationChange
      ),
      segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_MODIFIED,
        onSegmentationChange
      ),
      segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_REMOVED,
        onSegmentationChange
      ),
    ];

    return () => {
      subs.forEach(sub => {
        if (typeof sub === 'function') {
          sub(); // new API: unsubscribe function
        } else if (segmentationService.unsubscribe) {
          segmentationService.unsubscribe(sub); // old API
        }
      });
    };
  }, [segmentationService, isConnected, sessionId, username]);

  // Actions
  const ensureSocket = () =>
    new Promise<void>((resolve, reject) => {
      if (socket.connected) return resolve();
      socket.connect();
      const timeout = setTimeout(() => {
        socket.off('connect', onConnectOnce);
        reject(new Error('Connection timeout'));
      }, 5000);
      const onConnectOnce = () => {
        clearTimeout(timeout);
        resolve();
      };
      socket.once('connect', onConnectOnce);
    });

  const createSession = useCallback(async () => {
    setError('');
    if (!username) {
      setError('Please enter your name before creating a session');
      return;
    }
    try {
      await ensureSocket();

      const newId = generateSessionId();
      // grab the active segmentation id at creation time
      const activeSegId = getActiveSegmentationIdSafe(segmentationService);

      socket.emit(
        'create-session',
        { sessionId: newId, username, segmentationId: activeSegId || null },
        (response: any) => {
          if (response?.error) {
            setError(response.error);
            return;
          }
          setSessionId(newId);
          setIsConnected(true);
          setIsHost(true);
          setParticipants(1);
          localStorage.setItem('collabRole', 'host');
          localStorage.setItem('collabSessionId', newId);
          localStorage.setItem('username', username);
        }
      );
    } catch (err) {
      console.error(err);
      setError('Failed to create session');
    }
  }, [username, segmentationService]);

  const joinSession = useCallback(
    async (idToJoin: string) => {
      setError('');
      if (!username) {
        setError('Please enter your name before joining a session');
        return;
      }
      const trimmed = (idToJoin || '').trim();
      if (!trimmed) {
        setError('Please enter a session ID');
        return;
      }
      try {
        await ensureSocket();
        socket.emit('join-session', { sessionId: trimmed, username }, (response: any) => {
          if (response?.error || response?.status === 'error') {
            setError(response?.error || response?.message || 'Failed to join');
            return;
          }
          setSessionId(trimmed);
          setIsConnected(true);
          setIsHost(false);
          setParticipants(response?.participants || 1);
          localStorage.setItem('collabRole', 'viewer');
          localStorage.setItem('collabSessionId', trimmed);
          localStorage.setItem('username', username);
        });
      } catch (err) {
        console.error(err);
        setError('Failed to join session');
      }
    },
    [username]
  );

  const leaveSession = useCallback(() => {
    setError('');
    const sid = localStorage.getItem('collabSessionId') || sessionId;
    if (!sid) return;
    socket.emit('leave-session', { sessionId: sid, username }, (response: any) => {
      if (response?.error) {
        setError(response.error);
        return;
      }
      localStorage.removeItem('collabRole');
      localStorage.removeItem('collabSessionId');
      setIsConnected(false);
      setIsHost(false);
      setSessionId('');
      setParticipants(0);
      setUsers([]);
      setMessages([]);
    });
  }, [sessionId, username]);

  const sendMessage = (textFromChild?: string) => {
    const text = typeof textFromChild === 'string' ? textFromChild : chatInput;
    if (!text.trim()) return;
    const message: Message = {
      userId: socket.id,
      userName: username,
      text: text.trim(),
      timestamp: Date.now(),
    };
    socket.emit('chat-message', message);
    setMessages(prev => [...prev, message]); // render own message immediately
    if (typeof textFromChild !== 'string') setChatInput('');
  };

  const handleChatKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  };

  // Username gate (same UX you had)
  if (!username) {
    return (
      <div style={{ padding: 16, color: 'white', backgroundColor: '#111', height: '100%' }}>
        <h2>Enter Your Name</h2>
        <input
          type="text"
          value={inputUsername}
          onChange={e => setInputUsername(e.target.value)}
          placeholder="Your name"
          style={{
            width: '100%',
            padding: 8,
            marginBottom: 16,
            borderRadius: 4,
            border: '1px solid #555',
            background: '#222',
            color: '#fff',
          }}
        />
        <button
          onClick={() => {
            if (inputUsername.trim()) {
              setUsername(inputUsername.trim());
              localStorage.setItem('username', inputUsername.trim());
            }
          }}
          style={{
            background: '#4caf50',
            color: '#fff',
            padding: '8px 16px',
            border: 0,
            borderRadius: 4,
            cursor: 'pointer',
          }}
          disabled={!inputUsername.trim()}
        >
          Save Name
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        width: '320px',
        padding: 16,
        color: 'white',
        backgroundColor: '#111',
        height: '100vh',
        overflowY: 'auto',
        boxSizing: 'border-box',
      }}
    >
      <h2>Collaboration</h2>
      <p>Status: {connectionStatus}</p>
      {error && <div style={{ color: 'red', marginBottom: 8 }}>Error: {error}</div>}

      <SessionControls
        isConnected={isConnected}
        createSession={createSession}
        joinSession={joinSession}
        leaveSession={leaveSession}
      />

      {isConnected && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0' }}>
            <div>
              Session ID: <strong>{sessionId}</strong>
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(sessionId);
                setCopySuccess(true);
                setTimeout(() => setCopySuccess(false), 2000);
              }}
              style={{
                background: '#555',
                color: '#fff',
                padding: '4px 8px',
                border: 0,
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Copy
            </button>
            {copySuccess && <span style={{ color: '#4caf50' }}>Copied!</span>}
          </div>

          <p>
            Role: <strong>{isHost ? 'Host' : 'Viewer'}</strong>
          </p>
          <p>
            Participants: <strong>{participants}</strong>
          </p>

          <div style={{ marginBottom: 8 }}>
            <h3>Users</h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {users.map(user => (
                <li key={user.id}>
                  {user.name} {user.id === socket.id && '(You)'}{' '}
                  {isHost && user.id === socket.id && '(Host)'}
                </li>
              ))}
            </ul>
          </div>

          <h3
            style={{
              margin: '12px 0 8px',
              fontSize: '1rem',
              borderBottom: '1px solid #444',
              paddingBottom: 4,
            }}
          >
            💬 Chat
          </h3>

          <ChatBox messages={messages} sendMessage={sendMessage} />

          {/* Also keep the inline single-line input (optional) */}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input
              type="text"
              placeholder="Type a message..."
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={handleChatKeyDown}
              style={{
                flex: 1,
                padding: '8px 10px',
                borderRadius: 20,
                border: '1px solid #555',
                background: '#111',
                color: '#fff',
                outline: 'none',
                fontSize: 13,
              }}
            />
            <button
              onClick={() => sendMessage()}
              style={{
                background: '#2196f3',
                color: '#fff',
                padding: '8px 14px',
                border: 'none',
                borderRadius: 20,
                cursor: chatInput.trim() ? 'pointer' : 'not-allowed',
                opacity: chatInput.trim() ? 1 : 0.6,
                fontWeight: 'bold',
              }}
              disabled={!chatInput.trim()}
            >
              ➤
            </button>
          </div>
        </>
      )}
    </div>
  );
}
