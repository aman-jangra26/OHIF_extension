const { Server } = require('socket.io');
const http = require('http');

const PORT = 8000;
const server = http.createServer();
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const sessions = new Map(); // Map<sessionId, { host, participants: Map<socketId,name>, lastViewport, lastSegState }>

function findSessionIdForSocket(socketId) {
  for (const [sid, sess] of sessions.entries()) {
    if (sess.participants.has(socketId)) return sid;
  }
  return null;
}

io.on('connection', socket => {
  console.log(`✅ Client connected: ${socket.id}`);

  const broadcastUsers = sessionId => {
    const sess = sessions.get(sessionId);
    if (!sess) return;
    const users = Array.from(sess.participants.entries()).map(([id, name]) => ({ id, name }));
    console.log(`[Users] Session ${sessionId}:`, users);
    io.to(sessionId).emit('update-users', users);
    io.to(sessionId).emit('participant-update', { count: users.length });
  };

  socket.on('create-session', ({ sessionId, username, segmentationId }, cb = () => {}) => {
    console.log(
      `[Create] sessionId=${sessionId} by ${username} (${socket.id}) segId=${segmentationId || 'none'}`
    );

    sessions.set(sessionId, {
      host: socket.id,
      participants: new Map([[socket.id, username || 'host']]),
      lastViewport: null,
      lastSegState: {},
    });

    if (segmentationId) {
      sessions.get(sessionId).lastSegState[segmentationId] = { createdBy: username || 'host' };
    }

    socket.join(sessionId);
    cb({ status: 'success', sessionId });
    broadcastUsers(sessionId);
  });

  socket.on('join-session', ({ sessionId, username }, cb = () => {}) => {
    const sess = sessions.get(sessionId);
    if (!sess) {
      console.warn(`[Join] FAILED: no session ${sessionId}`);
      return cb({ status: 'error', message: 'Session not found' });
    }
    console.log(`[Join] ${username} (${socket.id}) -> ${sessionId}`);

    sess.participants.set(socket.id, username || 'guest');
    socket.join(sessionId);

    cb({
      status: 'success',
      initialState: {
        viewport: sess.lastViewport,
        segmentations: sess.lastSegState,
      },
      participants: sess.participants.size,
    });

    broadcastUsers(sessionId);
  });

  // Relay host's displaySetChange
  socket.on('displaySetChange', data => {
    const sessionId = findSessionIdForSocket(socket.id);
    if (!sessionId)
      return console.warn('[displaySetChange] socket is not in a session:', socket.id);

    const label = data?.description || data?.displaySetInstanceUID || 'unknown';
    console.log(`[DisplaySetChange] session=${sessionId} from=${socket.id} label="${label}"`);
    console.log('  ↳ payload:', data);

    const sess = sessions.get(sessionId);
    if (sess) sess.lastViewport = data;

    socket.to(sessionId).emit('displaySetChange', data);
  });

  // Relay segmentation events
  socket.on('segmentationEvent', data => {
    const sessionId = findSessionIdForSocket(socket.id);
    if (!sessionId)
      return console.warn('[segmentationEvent] socket is not in a session:', socket.id);

    console.log(`[SegmentationEvent] session=${sessionId} from=${socket.id}`);
    console.log('  ↳ event:', data?.eventName, 'payload:', data?.evt);

    // Store lightweight last state (useful for late joiners)
    const sess = sessions.get(sessionId);
    if (sess && data?.evt?.segmentationId) {
      if (!sess.lastSegState) sess.lastSegState = {};
      if (data.eventName === 'SEGMENTATION_REMOVED') {
        delete sess.lastSegState[data.evt.segmentationId];
      } else {
        sess.lastSegState[data.evt.segmentationId] = data.evt;
      }
    }

    socket.to(sessionId).emit('segmentationEvent', data);
  });

  // Handle segmentation data requests
  socket.on('requestSegmentationData', data => {
    const sessionId = findSessionIdForSocket(socket.id);
    if (!sessionId)
      return console.warn('[requestSegmentationData] socket is not in a session:', socket.id);

    console.log(
      `[SegmentationDataRequest] session=${sessionId} from=${socket.id} segId=${data.segmentationId}`
    );

    // Forward the request to the host (only the host should have the data)
    const sess = sessions.get(sessionId);
    if (sess && sess.host) {
      io.to(sess.host).emit('requestSegmentationData', data);
    }
  });

  // Relay segmentation data responses
  socket.on('segmentationData', data => {
    const sessionId = findSessionIdForSocket(socket.id);
    if (!sessionId)
      return console.warn('[segmentationData] socket is not in a session:', socket.id);

    console.log(
      `[SegmentationData] session=${sessionId} from=${socket.id} segId=${data.segmentationId}`
    );

    // Forward segmentation data to all participants except the sender
    socket.to(sessionId).emit('segmentationData', data);
  });

  socket.on('leave-session', ({ sessionId }, cb = () => {}) => {
    const sess = sessions.get(sessionId);
    if (!sess) return cb({ error: 'Session not found' });
    console.log(`[Leave] ${socket.id} from ${sessionId}`);

    sess.participants.delete(socket.id);
    socket.leave(sessionId);
    broadcastUsers(sessionId);
    cb({ status: 'success' });
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);

    for (const [sessionId, sess] of sessions.entries()) {
      if (!sess.participants.has(socket.id)) continue;

      const wasHost = sess.host === socket.id;
      sess.participants.delete(socket.id);
      broadcastUsers(sessionId);

      if (wasHost) {
        const next = sess.participants.keys().next().value;
        if (next) {
          sess.host = next;
          io.to(next).emit('promoted-to-host');
          console.log(`[Host] Promoted ${next} in session ${sessionId}`);
        } else {
          console.log(`[Session] Empty, deleting ${sessionId}`);
          sessions.delete(sessionId);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Collaboration server running on port ${PORT}`);
});
