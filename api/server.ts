/**
 * local server entry file, for local development
 */
import http from 'http'
import { Server as SocketIOServer } from 'socket.io'
import app from './app.js'
import { config } from './config.js'
import { initSocket } from './socket.js'
import { roomService } from './services/roomService.js'

/**
 * start server with port
 */
const server = http.createServer(app)

server.on('error', (err) => {
  console.error(err)
  process.exit(1)
})

const io = new SocketIOServer(server, {
  cors: {
    origin: true,
    credentials: true,
  },
})

await initSocket(io)

server.listen(config.port, () => {
  console.log(`Server ready on port ${config.port}`)

  // Clean up expired rooms every 10 seconds
  setInterval(() => {
    roomService.checkAndExpireRooms(io).catch(console.error)
  }, 10000)
})

/**
 * close server
 */
// Gracefully handle shutdown steps
function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down...`)

  // Close Socket.IO first
  io.close(() => {
    console.log('Socket.IO closed')
  })

  // Close HTTP server
  server.close((err) => {
    if (err) {
      console.error('Error closing server:', err)
      process.exit(1)
    }
    console.log('Server closed')
    if (signal === 'SIGUSR2') {
      process.kill(process.pid, 'SIGUSR2')
    } else {
      process.exit(0)
    }
  })

  // Force close after timeout if lagging
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down')
    process.exit(1)
  }, 3000).unref()
}

process.once('SIGUSR2', () => shutdown('SIGUSR2'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))

export default app
