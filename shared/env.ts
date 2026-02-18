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
  EMAIL_PROVIDER: z.string().optional(),
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).optional(),
  EMAIL_OTP_RESEND_SECONDS: z.coerce.number().int().min(10).max(600).optional(),
  EMAIL_OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).optional(),
  EMAIL_OTP_DAILY_LIMIT: z.coerce.number().int().min(1).max(500).optional(),
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
  emailProvider: (
    (sanitizeEnvString(parsed.data.EMAIL_PROVIDER)?.toLowerCase() ?? '') === 'resend'
      ? 'resend'
      : 'mock'
  ) as 'mock' | 'resend',
  emailApiKey: sanitizeEnvString(parsed.data.EMAIL_API_KEY) ?? '',
  emailFrom: sanitizeEnvString(parsed.data.EMAIL_FROM) ?? '',
  emailOtpTtlSeconds: parsed.data.EMAIL_OTP_TTL_SECONDS ?? 300,
  emailOtpResendSeconds: parsed.data.EMAIL_OTP_RESEND_SECONDS ?? 60,
  emailOtpMaxAttempts: parsed.data.EMAIL_OTP_MAX_ATTEMPTS ?? 5,
  emailOtpDailyLimit: parsed.data.EMAIL_OTP_DAILY_LIMIT ?? 20,
}
