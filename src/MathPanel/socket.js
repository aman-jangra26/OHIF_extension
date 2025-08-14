import { io, Socket } from 'socket.io-client';

const DEFAULT_URL = 'http://localhost:8000';
const URL = (typeof window !== 'undefined' && (window as any).__COLLAB_URL__) || DEFAULT_URL;

const socket: Socket = io(URL, {
  transports: ['websocket'],
  reconnection: true,
  reconnectionAttempts: 10,
  timeout: 20000,
  autoConnect: false,
});

socket.on('connect', () => {
  console.log('[socket] connected', socket.id);
});
socket.on('connect_error', (err) => {
  console.error('[socket] connect_error', err.message);
});
socket.on('disconnect', (reason) => {
  console.log('[socket] disconnected', reason);
});

// The chat and user list events will be handled in your MathPanel component
// Example:
// socket.on('update-users', users => { setUsers(users) });
// socket.on('chat-message', msg => { setMessages(old => [...old, msg]) });

export default socket;
