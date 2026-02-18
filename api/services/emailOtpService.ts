import crypto from 'crypto'
import { z } from 'zod'
import { envConfig } from '../../shared/env.js'
import { getRedis } from '../db/redis.js'
import { sendMail } from './emailService.js'

const emailSchema = z.string().trim().email()
const otpSchema = z.string().regex(/^\d{6}$/)
const otpPurposeSchema = z.enum(['register', 'upgrade', 'reset_password'])
export type OtpPurpose = z.infer<typeof otpPurposeSchema>

const otpRecordSchema = z.object({
  codeHash: z.string().min(1),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  expiresAtMs: z.number().int().min(1),
  createdAtMs: z.number().int().min(1),
  purpose: otpPurposeSchema,
})

type OtpRecord = z.infer<typeof otpRecordSchema>

function toRedisString(value: string | Buffer) {
  return typeof value === 'string' ? value : value.toString('utf8')
}

function normalizeEmail(email: string) {
  return emailSchema.parse(email).toLowerCase()
}

function normalizePurpose(purpose: OtpPurpose) {
  return otpPurposeSchema.parse(purpose)
}

function buildOtpEmailMeta(purpose: OtpPurpose) {
  if (purpose === 'upgrade') {
    return {
      subject: '狼人杀账号升级验证码',
      action: '升级账号',
    }
  }
  if (purpose === 'reset_password') {
    return {
      subject: '狼人杀找回密码验证码',
      action: '重置密码',
    }
  }
  return {
    subject: '狼人杀注册验证码',
    action: '注册账号',
  }
}

function otpDataKey(email: string, purpose: OtpPurpose) {
  return `auth:otp:email:${purpose}:${encodeURIComponent(email)}`
}

function otpCooldownKey(email: string, purpose: OtpPurpose) {
  return `auth:otp:email:${purpose}:cooldown:${encodeURIComponent(email)}`
}

function otpDailyCountKey(email: string, purpose: OtpPurpose) {
  const date = new Date()
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `auth:otp:email:${purpose}:daily:${encodeURIComponent(email)}:${y}${m}${d}`
}

function secondsUntilUtcDayEnd() {
  const now = new Date()
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0))
  return Math.max(60, Math.floor((end.getTime() - now.getTime()) / 1000))
}

function createOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function hashOtp(email: string, otp: string) {
  return crypto.createHash('sha256').update(`${email}:${otp}:${envConfig.jwtSecret}`).digest('hex')
}

function parseOtpRecord(raw: unknown): OtpRecord | null {
  if (!raw) return null
  try {
    const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
    return otpRecordSchema.parse(JSON.parse(text))
  } catch {
    return null
  }
}

export function isEmailAccount(value: string) {
  return emailSchema.safeParse(value.trim()).success
}

export async function sendEmailOtp(rawEmail: string, rawPurpose: OtpPurpose) {
  const email = normalizeEmail(rawEmail)
  const purpose = normalizePurpose(rawPurpose)
  const redis = await getRedis()

  const onCooldown = Number(await redis.exists(otpCooldownKey(email, purpose))) > 0
  if (onCooldown) throw new Error('OTP_COOLDOWN')

  const dailyKey = otpDailyCountKey(email, purpose)
  const dailyRaw = await redis.get(dailyKey)
  const dailyCount = dailyRaw ? Number.parseInt(toRedisString(dailyRaw), 10) || 0 : 0
  if (dailyCount >= envConfig.emailOtpDailyLimit) throw new Error('OTP_DAILY_LIMIT')

  const code = createOtpCode()
  const nowMs = Date.now()
  const record: OtpRecord = {
    codeHash: hashOtp(email, code),
    attempts: 0,
    maxAttempts: envConfig.emailOtpMaxAttempts,
    expiresAtMs: nowMs + envConfig.emailOtpTtlSeconds * 1000,
    createdAtMs: nowMs,
    purpose,
  }

  await redis.set(otpDataKey(email, purpose), JSON.stringify(record), { EX: envConfig.emailOtpTtlSeconds })
  await redis.set(otpCooldownKey(email, purpose), '1', { EX: envConfig.emailOtpResendSeconds })
  await redis.set(dailyKey, String(dailyCount + 1), { EX: secondsUntilUtcDayEnd() })

  const expireMinutes = Math.max(1, Math.ceil(envConfig.emailOtpTtlSeconds / 60))
  const mailMeta = buildOtpEmailMeta(purpose)
  await sendMail({
    to: email,
    subject: mailMeta.subject,
    text: `你正在${mailMeta.action}，验证码是 ${code}，${expireMinutes} 分钟内有效。若非本人操作请忽略。`,
    html: `<div><p>你正在${mailMeta.action}</p><p>验证码是 <b style="font-size:22px;letter-spacing:2px;">${code}</b></p><p>${expireMinutes} 分钟内有效。若非本人操作请忽略。</p></div>`,
  })

  return {
    resendAfterSeconds: envConfig.emailOtpResendSeconds,
    expireAfterSeconds: envConfig.emailOtpTtlSeconds,
  }
}

export async function verifyEmailOtp(rawEmail: string, rawOtp: string, rawPurpose: OtpPurpose) {
  const email = normalizeEmail(rawEmail)
  const otpParsed = otpSchema.safeParse(rawOtp.trim())
  if (!otpParsed.success) throw new Error('OTP_INVALID_OR_EXPIRED')
  const otp = otpParsed.data
  const purpose = normalizePurpose(rawPurpose)

  const redis = await getRedis()
  const key = otpDataKey(email, purpose)
  const raw = await redis.get(key)
  const record = parseOtpRecord(raw)
  if (!record) throw new Error('OTP_INVALID_OR_EXPIRED')
  if (record.purpose !== purpose) throw new Error('OTP_INVALID_OR_EXPIRED')

  const nowMs = Date.now()
  if (record.expiresAtMs <= nowMs) {
    await redis.del(key)
    throw new Error('OTP_INVALID_OR_EXPIRED')
  }

  if (record.attempts >= record.maxAttempts) {
    await redis.del(key)
    throw new Error('OTP_TOO_MANY_ATTEMPTS')
  }

  const matched = hashOtp(email, otp) === record.codeHash
  if (!matched) {
    const nextAttempts = record.attempts + 1
    const leftSeconds = Math.max(1, Math.floor((record.expiresAtMs - nowMs) / 1000))
    if (nextAttempts >= record.maxAttempts) {
      await redis.del(key)
      throw new Error('OTP_TOO_MANY_ATTEMPTS')
    }

    await redis.set(
      key,
      JSON.stringify({
        ...record,
        attempts: nextAttempts,
      }),
      { EX: leftSeconds },
    )
    throw new Error('OTP_INVALID_OR_EXPIRED')
  }

  await redis.del(key)
}
