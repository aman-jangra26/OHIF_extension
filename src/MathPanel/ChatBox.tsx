// src/ChatBox.tsx
import React, { useState, useRef, useEffect } from 'react';

type Message = {
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
};

type Props = {
  messages: Message[];
  sendMessage: (text: string) => void;
};

export default function ChatBox({ messages, sendMessage }: Props) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const handleSend = () => {
    const t = text.trim();
    if (t) {
      sendMessage(t);
      setText('');
    }
  };

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  return (
    <div>
      <div
        ref={listRef}
        style={{
          maxHeight: 200,
          overflowY: 'auto',
          background: '#1a1a1a',
          padding: 8,
          borderRadius: 6,
          border: '1px solid #333',
          boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5)',
        }}
      >
        {messages.length === 0 ? (
          <p style={{ color: '#777', fontStyle: 'italic', textAlign: 'center', margin: 0 }}>
            No messages yet
          </p>
        ) : (
          messages.map((m, idx) => (
            <div
              key={idx}
              style={{
                marginBottom: 6,
                display: 'flex',
                flexDirection: 'column',
                background: '#2b2b2b',
                padding: '6px 8px',
                borderRadius: 6,
                maxWidth: '100%',
              }}
            >
              <span style={{ fontWeight: 'bold', fontSize: 13, color: '#66c' }}>{m.userName}</span>
              <span style={{ fontSize: 13, color: '#ddd', whiteSpace: 'pre-wrap' }}>{m.text}</span>
              <span style={{ fontSize: 10, color: '#888', alignSelf: 'flex-end' }}>
                {new Date(m.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Type message..."
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSend();
            }
          }}
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
          type="button"
          onClick={handleSend}
          style={{
            background: '#2196f3',
            color: '#fff',
            padding: '8px 14px',
            border: 'none',
            borderRadius: 20,
            cursor: text.trim() ? 'pointer' : 'not-allowed',
            opacity: text.trim() ? 1 : 0.6,
            fontWeight: 'bold',
          }}
          disabled={!text.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
