import { useState, useEffect, useCallback } from 'react';
import socket from './socket';

export function useCollabSocket(
  username: string,
  segmentationId?: string,
  segmentationService?: any
) {
  const [sessionId, setSessionId] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [participants, setParticipants] = useState(0);
  const [users, setUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');

  useEffect(() => {
    socket.on('connect', () => setConnectionStatus('connected'));
    socket.on('disconnect', () => setConnectionStatus('disconnected'));

    socket.on('update-users', setUsers);
    socket.on('participant-update', ({ count }) => setParticipants(count));
    socket.on('chat-message', msg => setMessages(prev => [...prev, msg]));

    socket.on('segmentation-update', seg => {
      console.log('[Socket] Segmentation update received', seg);
      segmentationService?.addOrUpdateSegmentation(seg.segId, seg);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('update-users');
      socket.off('participant-update');
      socket.off('chat-message');
      socket.off('segmentation-update');
    };
  }, [segmentationService]);

  useEffect(() => {
    if (!segmentationService) return;
    const onSegmentationChange = evt => {
      console.log('[OHIF] Segmentation event', evt);
      const activeSegId = segmentationService.getActiveSegmentationId?.();
      if (activeSegId) {
        const seg = segmentationService.getSegmentation(activeSegId);
        socket.emit('update-segmentation', { sessionId, segmentation: seg });
      }
    };

    const subs = [
      segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_ADDED,
        onSegmentationChange
      ),
      segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_MODIFIED,
        onSegmentationChange
      ),
    ];

    return () => subs.forEach(sub => segmentationService.unsubscribe(sub));
  }, [sessionId, segmentationService]);

  const createSession = useCallback(() => {
    const id = `med-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    socket.emit('create-session', { sessionId: id, username, segmentationId }, res => {
      if (res.status === 'success') {
        setSessionId(id);
        setIsConnected(true);
        setIsHost(true);
      }
    });
  }, [username, segmentationId]);

  const joinSession = useCallback(
    (idToJoin: string) => {
      socket.emit('join-session', { sessionId: idToJoin, username, segmentationId }, res => {
        if (res.status === 'success') {
          setSessionId(idToJoin);
          setIsConnected(true);
          setIsHost(false);
          if (res.initialState?.segmentations) {
            res.initialState.segmentations.forEach(seg => {
              segmentationService?.addOrUpdateSegmentation(seg.segId, seg);
            });
          }
        }
      });
    },
    [username, segmentationId, segmentationService]
  );

  const leaveSession = useCallback(() => {
    socket.emit('leave-session', { sessionId }, () => {
      setIsConnected(false);
      setIsHost(false);
      setSessionId('');
      setParticipants(0);
      setUsers([]);
      setMessages([]);
    });
  }, [sessionId]);

  const sendMessage = (text: string) => {
    const message = { userId: socket.id, userName: username, text, timestamp: Date.now() };
    socket.emit('chat-message', message);
    setMessages(prev => [...prev, message]);
  };

  return {
    sessionId,
    isConnected,
    isHost,
    participants,
    users,
    messages,
    connectionStatus,
    createSession,
    joinSession,
    leaveSession,
    sendMessage,
  };
}
