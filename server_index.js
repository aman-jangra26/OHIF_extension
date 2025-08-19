const { Server } = require('socket.io');
const http = require('http');

const PORT = 8000;
const server = http.createServer();

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Utility: strip heavy fields before broadcasting
function sanitizeDisplaySet(displaySet) {
  if (!displaySet) return {};
  return {
    StudyInstanceUID: displaySet.StudyInstanceUID,
    displaySetInstanceUID: displaySet.displaySetInstanceUID,
    SeriesInstanceUID: displaySet.SeriesInstanceUID,
    SeriesDate: displaySet.SeriesDate,
    SeriesTime: displaySet.SeriesTime,
    FrameOfReferenceUID: displaySet.FrameOfReferenceUID,
    volumeLoaderSchema: displaySet.volumeLoaderSchema,
    // Don’t include heavy fields like instances, proxies, or functions
  };
}

// Map<sessionId, { host, participants, seriesState, segmentations, displaySets }>
const sessions = new Map();

io.on('connection', socket => {
  console.log(`Client connected: ${socket.id}`);

  // Broadcast current users in a session
  const broadcastUsers = sessionId => {
    const session = sessions.get(sessionId);
    if (!session) return;
    const users = Array.from(session.participants.entries()).map(([id, name]) => ({
      id,
      name,
    }));
    io.to(sessionId).emit('update-users', users);
    io.to(sessionId).emit('participant-update', { count: users.length });
  };

  // Create Session
  socket.on('create-session', ({ sessionId, username, segmentationId }, callback) => {
    sessions.set(sessionId, {
      host: socket.id,
      participants: new Map([[socket.id, username]]),
      viewportState: null,
      seriesState: null,
      toolState: null,
      segmentations: {
        [segmentationId]: { segId: segmentationId, createdBy: username },
      },
      displaySets: [],
      currentFrame: 0,
    });
    socket.join(sessionId);
    callback({ status: 'success', sessionId });
    broadcastUsers(sessionId);
    console.log(`[Session Created] ${sessionId}, Segmentation ID: ${segmentationId}`);
  });

  // Join Session
  socket.on('join-session', ({ sessionId, username }, callback) => {
    const session = sessions.get(sessionId);
    if (!session) {
      callback({ status: 'error', message: 'Session not found' });
      return;
    }

    session.participants.set(socket.id, username);
    socket.join(sessionId);

    callback({
      status: 'success',
      initialState: {
        viewport: session.viewportState,
        series: session.seriesState,
        tool: session.toolState,
        segmentations: Object.values(session.segmentations),
        displaySets: session.displaySets,
        currentFrame: session.currentFrame,
      },
      participants: session.participants.size,
    });

    broadcastUsers(sessionId);
  });

  // Chat message handler
  socket.on('chat-message', message => {
    sessions.forEach((session, sessionId) => {
      if (session.participants.has(socket.id)) {
        io.to(sessionId).emit('chat-message', message);
      }
    });
  });

  // Displayset-update handler
  socket.on('displayset-update', ({ sessionId, displaySet, updatedBy, timestamp }) => {
    const session = sessions.get(sessionId);
    if (!session) return;

    const sanitized = sanitizeDisplaySet(displaySet);

    if (!session.displaySets) session.displaySets = [];
    session.displaySets.push({ ...sanitized, updatedBy, timestamp });

    console.log(`[DisplaySet Updated] Session: ${sessionId} | By: ${updatedBy}`);
    console.log('DisplaySet Info:', sanitized);

    io.to(sessionId).emit('displayset-update', {
      displaySet: sanitized,
      updatedBy,
      timestamp,
    });
  });

  // Series sync (host only)
  socket.on('sync-series', ({ sessionId, seriesState }) => {
    const session = sessions.get(sessionId);
    if (!session || socket.id !== session.host) return;
    session.seriesState = seriesState;
    socket.to(sessionId).emit('series-update', seriesState);
  });

  // Segmentation update
  socket.on('update-segmentation', ({ sessionId, segmentation }) => {
    const session = sessions.get(sessionId);
    if (!session) return;

    const isHost = socket.id === session.host;
    session.segmentations[segmentation.segId] = segmentation;

    console.log(
      `[Segmentation Updated] Session: ${sessionId} | By: ${segmentation.updatedBy} | Host: ${isHost}`,
      segmentation
    );

    io.to(sessionId).emit('segmentation-update', {
      ...segmentation,
      updatedByHost: isHost,
    });
  });

  // Leave session handler
  socket.on('leave-session', ({ sessionId }, callback) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.participants.delete(socket.id);
      socket.leave(sessionId);
      broadcastUsers(sessionId);
      callback({ status: 'success' });
    } else {
      callback({ error: 'Session not found' });
    }
  });

  io.on('connection', socket => {
    console.log('Client connected:', socket.id);

    socket.on('createSession', data => {
      console.log(`[Session Created] ${data.sessionId}, Segmentation ID: ${data.segmentationId}`);
    });

    socket.on('displaySetChange', data => {
      console.log(`[DisplaySetChange] From ${socket.id}:`, data);
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    sessions.forEach((session, sessionId) => {
      if (session.participants.has(socket.id)) {
        session.participants.delete(socket.id);
        broadcastUsers(sessionId);

        if (socket.id === session.host && session.participants.size > 0) {
          const newHost = session.participants.keys().next().value;
          session.host = newHost;
          io.to(newHost).emit('promoted-to-host');
        }
      }
    });
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Collaboration server running on port ${PORT}`);
});
