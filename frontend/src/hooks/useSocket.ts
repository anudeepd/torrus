import { io, Socket } from 'socket.io-client'

let _socket: Socket | null = null

export function getSocket(): Socket {
  if (!_socket) {
    _socket = io({
      // Start on long polling and upgrade when the transport allows it: polling
      // alone works through every reverse proxy, but it costs a round trip per
      // keystroke on the terminal. Socket.IO keeps polling if the upgrade fails,
      // so a proxy that drops upgrade requests still works.
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
    })
  }
  return _socket
}
