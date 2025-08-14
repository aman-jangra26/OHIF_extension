// src/SessionControls.tsx
import React, { useState } from 'react';

type Props = {
  isConnected: boolean;
  createSession: () => void;
  joinSession: (id: string) => void;
  leaveSession: () => void;
};

export default function SessionControls({
  isConnected,
  createSession,
  joinSession,
  leaveSession,
}: Props) {
  const [joinId, setJoinId] = useState('');

  return (
    <div
      style={{
        width: '100%',
        padding: 12,
        backgroundColor: '#111',
        color: 'white',
        borderRadius: 6,
        border: '1px solid #333',
        marginBottom: 12,
        boxSizing: 'border-box',
      }}
    >
      {!isConnected ? (
        <>
          {/* Create Session Button */}
          <button
            type="button"
            onClick={createSession}
            style={{
              background: '#4caf50',
              color: '#fff',
              padding: '8px 16px',
              border: 0,
              borderRadius: 4,
              cursor: 'pointer',
              marginBottom: 8,
              width: '100%',
              fontWeight: 'bold',
            }}
          >
            Create Session
          </button>

          {/* Join Session */}
          <div>
            <label
              htmlFor="session-id-input"
              style={{ display: 'block', marginBottom: 4, fontSize: 13, color: '#ccc' }}
            >
              Enter Session ID:
            </label>
            <input
              id="session-id-input"
              type="text"
              value={joinId}
              onChange={e => setJoinId(e.target.value)}
              placeholder="Paste session ID"
              style={{
                width: '100%',
                padding: 8,
                marginBottom: 8,
                borderRadius: 4,
                border: '1px solid #555',
                background: '#222',
                color: '#fff',
              }}
            />
            <button
              type="button"
              onClick={() => joinSession(joinId)}
              style={{
                background: '#2196f3',
                color: '#fff',
                padding: '8px 16px',
                border: 0,
                borderRadius: 4,
                cursor: joinId.trim() ? 'pointer' : 'not-allowed',
                opacity: joinId.trim() ? 1 : 0.6,
                width: '100%',
                fontWeight: 'bold',
              }}
              disabled={!joinId.trim()}
            >
              Join Session
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Leave Session Button */}
          <button
            type="button"
            onClick={leaveSession}
            style={{
              background: '#f44336',
              color: '#fff',
              padding: '8px 16px',
              border: 0,
              borderRadius: 4,
              cursor: 'pointer',
              width: '100%',
              fontWeight: 'bold',
            }}
          >
            Leave Session
          </button>
        </>
      )}
    </div>
  );
}
