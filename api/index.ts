/**
 * Vercel deploy entry handler.
 * Socket.IO removed — using Pusher for realtime.
 */
import app from './app.js'
import { startTimers } from './realtime.js'

// Start background timers on cold start
startTimers()

export default app
