import React, { useState, useEffect } from 'react';
import socket from './socket';

type Props = {
  isConnected: boolean;
  createSession: () => void;
  joinSession: (id: string) => void;
  leaveSession: () => void;
  servicesManager: any;
  sessionId: string;
  username: string;
};

export default function SessionControls({
  isConnected,
  createSession,
  joinSession,
  leaveSession,
  servicesManager,
  sessionId,
  username,
}: Props) {
  const [joinId, setJoinId] = useState('');

  // 🔹 Host: Send changes to server
  const handleDisplaySetChange = (displaySet: any) => {
    console.log('Client (host): Display set changed:', displaySet);

    socket.emit('displaySetChange', {
      seriesInstanceUID: displaySet?.SeriesInstanceUID,
      displaySetInstanceUID: displaySet?.displaySetInstanceUID,
      studyInstanceUID: displaySet?.StudyInstanceUID,
      modality: displaySet?.Modality,
      numberOfFrames: displaySet?.numImageFrames || displaySet?.images?.length || 'N/A',
      description: displaySet?.SeriesDescription || 'N/A',
      currentFrame: displaySet?.currentImageIdIndex || 0,
    });
  };

  // 🔹 Joiner: Listen for host’s updates
  useEffect(() => {
    if (!servicesManager) return;

    const { displaySetService, viewportGridService } = servicesManager.services;

    const onDisplaySetChange = (data: any) => {
      console.log('Client (joiner): Received displaySetChange:', data);

      const { displaySetInstanceUID, currentFrame } = data;

      // 1. Find the displaySet locally
      const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
      if (!displaySet) {
        console.warn('⚠️ Joiner: DisplaySet not found for UID:', displaySetInstanceUID);
        return;
      }

      // 2. Ensure it is active
      displaySetService.addActiveDisplaySets([displaySet]);

      // 3. Explicitly show this displaySet in the first viewport
      viewportGridService.setDisplaySetsForViewport({
        viewportIndex: 0, // TODO: make dynamic if multiple viewports
        displaySetInstanceUIDs: [displaySetInstanceUID],
      });

      // 4. Sync current frame (for stacks / cine)
      if (typeof currentFrame === 'number') {
        viewportGridService.setDisplaySetOptionsForViewport({
          viewportIndex: 0,
          displaySetInstanceUID,
          options: { currentImageIdIndex: currentFrame },
        });
      }

      console.log('✅ Joiner synced to host display set:', displaySet);
    };

    socket.on('displaySetChange', onDisplaySetChange);

    return () => {
      socket.off('displaySetChange', onDisplaySetChange);
    };
  }, [servicesManager]);

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
          {/* Host: Create session */}
          <button
            type="button"
            onClick={() => {
              createSession();

              const displaySetService = servicesManager?.services?.displaySetService;
              const displaySets = displaySetService?.getActiveDisplaySets?.() || [];
              const firstDisplaySet = displaySets[0];

              if (firstDisplaySet) {
                console.log('Emitting displayset-update with displaySet:', firstDisplaySet);
                handleDisplaySetChange(firstDisplaySet);
              }
            }}
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

          {/* Joiner: Join session */}
          <div>
            <label
              htmlFor="session-id-input"
              style={{
                display: 'block',
                marginBottom: 4,
                fontSize: 13,
                color: '#ccc',
              }}
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
          {/* Both host + joiner: Leave session */}
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
