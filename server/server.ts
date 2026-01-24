/**
 * local server entry file, for local development
 */
import http from 'http'
import { Server as SocketIOServer } from 'socket.io'
import app from './app.js'
import { envConfig } from './config.js'
import { initSocket } from './socket.js'

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

server.listen(envConfig.port, () => {
  console.log(`Server ready on port ${envConfig.port}`)
})

process.once('SIGUSR2', () => {
  server.close(() => {
    process.kill(process.pid, 'SIGUSR2')
  })
  setTimeout(() => {
    process.kill(process.pid, 'SIGUSR2')
  }, 2000).unref()
})

process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  server.close(() => {
    process.exit(0)
  })
})

export default app

