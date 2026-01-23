/**
 * This is a API server
 */

import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express'
import cors from 'cors'
import path from 'path'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import authRoutes from './routes/auth.js'
import roomRoutes from './routes/rooms.js'
import replayRoutes from './routes/replays.js'
import { requireAuth } from './middleware/requireAuth.js'

// for esm mode
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// load env
dotenv.config()

const app: express.Application = express()

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

/**
 * API Routes
 */
app.use('/api/auth', authRoutes)

/**
 * health
 */
app.use(
  '/api/health',
  (req: Request, res: Response, next: NextFunction): void => {
    res.status(200).json({
      success: true,
      message: 'ok',
    })
  },
)

app.use('/api', requireAuth)
app.use('/api/rooms', roomRoutes)
app.use('/api/replays', replayRoutes)

/**
 * error handler middleware
 */
app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  console.error(error)
  const raw = (error as any)?.message ? String((error as any).message) : 'Server internal error'
  const name = String((error as any)?.name ?? '')
  const errorText =
    name.includes('Mongo') || raw.includes('Mongo') || raw.includes('ECONNREFUSED') || raw.includes('ENOTFOUND')
      ? 'DB_UNAVAILABLE'
      : raw
  res.status(500).json({
    success: false,
    error: errorText,
  })
})

/**
 * 404 handler
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'API not found',
  })
})

export default app
