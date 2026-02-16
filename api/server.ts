/**
 * Local server entry file, for local development.
 * Socket.IO replaced by Pusher — timers run server-side.
 */
import http from 'http'
import app from './app.js'
import { envConfig } from '../shared/env.js'
import { startTimers, stopTimers } from './realtime.js'

const server = http.createServer(app)

server.on('error', (err) => {
  console.error(err)
  process.exit(1)
})

server.listen(envConfig.port, () => {
  console.log(`Server ready on port ${envConfig.port}`)
  startTimers()
})

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down...`)
  stopTimers()

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

  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down')
    process.exit(1)
  }, 3000).unref()
}

process.once('SIGUSR2', () => shutdown('SIGUSR2'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))

export default app
