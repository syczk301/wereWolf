import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

function sanitizeEnvString(value?: string) {
  if (typeof value !== 'string') return undefined
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/(?:\\r\\n|\\n|\\r)+$/g, '')
    .trim()
}

function parseCommaSeparated(value?: string) {
  const sanitized = sanitizeEnvString(value)
  if (!sanitized) return []
  return sanitized
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

const schema = z.object({
  PORT: z.coerce.number().default(3001),
  JWT_SECRET: z.string().min(16).optional(),
  MONGODB_URI: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  ADMIN_USER_IDS: z.string().optional(),
  ADMIN_USERNAMES: z.string().optional(),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  throw new Error(`Invalid env: ${issues}`)
}

export const envConfig = {
  port: parsed.data.PORT,
  jwtSecret: sanitizeEnvString(parsed.data.JWT_SECRET) ?? 'dev-secret-change-me-please',
  mongodbUri: sanitizeEnvString(parsed.data.MONGODB_URI) ?? 'mongodb://127.0.0.1:27017/werewolf',
  redisUrl: sanitizeEnvString(parsed.data.REDIS_URL) ?? 'redis://127.0.0.1:6379',
  adminUserIds: parseCommaSeparated(parsed.data.ADMIN_USER_IDS),
  adminUsernames: parseCommaSeparated(parsed.data.ADMIN_USERNAMES).map((item) => item.toLowerCase()),
}
