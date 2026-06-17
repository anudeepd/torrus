import { io, Socket } from 'socket.io-client'

let _socket: Socket | null = null

export function getSocket(): Socket {
  if (!_socket) {
    _socket = io({
      // Long polling works through reverse proxies that do not forward
      // WebSocket upgrade requests.
      transports: ['polling'],
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
    })
  }
  return _socket
}
