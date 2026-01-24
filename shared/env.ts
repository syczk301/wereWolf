import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const schema = z.object({
  PORT: z.coerce.number().default(3001),
  JWT_SECRET: z.string().min(16).optional(),
  MONGODB_URI: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  throw new Error(`Invalid env: ${issues}`)
}

export const envConfig = {
  port: parsed.data.PORT,
  jwtSecret: parsed.data.JWT_SECRET ?? 'dev-secret-change-me-please',
  mongodbUri: parsed.data.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/werewolf',
  redisUrl: parsed.data.REDIS_URL ?? 'redis://127.0.0.1:6379',
}
