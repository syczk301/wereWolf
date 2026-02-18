/**
 * This is a user authentication API route demo.
 * Handle user registration, login, token management, etc.
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import {
  guestLogin,
  isEmailRegistered,
  loginUser,
  logoutToken,
  registerUser,
  resetPasswordByEmail,
  upgradeGuestToUser,
} from '../services/authService.js'
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js'
import { sendEmailOtp, verifyEmailOtp } from '../services/emailOtpService.js'
import { envConfig } from '../../shared/env.js'

const router = Router()

const otpPurposeSchema = z.enum(['register', 'upgrade', 'reset_password'])
const emailSchema = z.string().trim().email()

function normalizeAccountPayload(input: {
  username?: string
  emailOrUsername?: string
  email?: string
}) {
  const username = String(input.username ?? input.emailOrUsername ?? '').trim()
  const email = String(input.email ?? '').trim().toLowerCase()
  return { username, email }
}

router.post('/email/code/send', async (req: Request, res: Response): Promise<void> => {
  const schema = z.object({
    email: z.string().trim().email(),
    purpose: otpPurposeSchema.optional(),
  })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'INVALID_INPUT' })
    return
  }

  try {
    const purpose = parsed.data.purpose ?? 'register'
    if (purpose === 'reset_password') {
      const exists = await isEmailRegistered(parsed.data.email)
      if (!exists) {
        res.status(400).json({ success: false, error: 'EMAIL_NOT_FOUND' })
        return
      }
    }

    const result = await sendEmailOtp(parsed.data.email, purpose)
    res.status(200).json({ success: true, ...result })
  } catch (e: any) {
    const message = String(e?.message ?? 'OTP_SEND_FAILED')
    if (message === 'OTP_COOLDOWN') {
      res.status(429).json({
        success: false,
        error: 'OTP_COOLDOWN',
        resendAfterSeconds: envConfig.emailOtpResendSeconds,
      })
      return
    }
    if (message === 'OTP_DAILY_LIMIT') {
      res.status(429).json({ success: false, error: 'OTP_DAILY_LIMIT' })
      return
    }
    if (message === 'EMAIL_DELIVERY_NOT_CONFIGURED' || message === 'EMAIL_SEND_FAILED') {
      res.status(503).json({ success: false, error: message })
      return
    }
    res.status(400).json({ success: false, error: message })
  }
})

/**
 * User Login
 * POST /api/auth/register
 */
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const schema = z.object({
    username: z.string().trim().min(1).optional(),
    emailOrUsername: z.string().trim().min(1).optional(),
    email: z.string().trim().email().optional(),
    password: z.string().min(6),
    nickname: z.string().trim().min(1).max(20),
    emailCode: z.string().trim().optional(),
  })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'INVALID_INPUT' })
    return
  }

  try {
    const data = parsed.data as {
      username?: string
      emailOrUsername?: string
      email?: string
      password: string
      nickname: string
      emailCode?: string
    }
    const { username, email } = normalizeAccountPayload(data)
    const nickname = data.nickname.trim()
    if (!username) {
      res.status(400).json({ success: false, error: 'USERNAME_REQUIRED' })
      return
    }
    if (!email) {
      res.status(400).json({ success: false, error: 'EMAIL_REQUIRED' })
      return
    }
    if (!data.emailCode || !data.emailCode.trim()) {
      res.status(400).json({ success: false, error: 'EMAIL_CODE_REQUIRED' })
      return
    }
    await verifyEmailOtp(email, data.emailCode, 'register')

    await registerUser({
      username,
      email,
      password: data.password,
      nickname,
    })
    const login = await loginUser({
      emailOrUsername: username,
      password: data.password,
    })
    res.status(200).json({ success: true, ...login })
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message ?? 'REGISTER_FAILED' })
  }
})

router.post('/password/reset', async (req: Request, res: Response): Promise<void> => {
  const schema = z.object({
    email: z.string().trim().optional(),
    emailCode: z.string().trim().optional(),
    newPassword: z.string().optional(),
  })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'INVALID_INPUT' })
    return
  }

  const rawEmail = String(parsed.data.email ?? '').trim()
  if (!rawEmail) {
    res.status(400).json({ success: false, error: 'EMAIL_REQUIRED' })
    return
  }
  const emailParsed = emailSchema.safeParse(rawEmail)
  if (!emailParsed.success) {
    res.status(400).json({ success: false, error: 'INVALID_INPUT' })
    return
  }
  const email = emailParsed.data.toLowerCase()

  const emailCode = String(parsed.data.emailCode ?? '').trim()
  if (!emailCode) {
    res.status(400).json({ success: false, error: 'EMAIL_CODE_REQUIRED' })
    return
  }

  const newPassword = String(parsed.data.newPassword ?? '')
  if (!newPassword || newPassword.length < 6) {
    res.status(400).json({ success: false, error: 'INVALID_INPUT' })
    return
  }

  try {
    const exists = await isEmailRegistered(email)
    if (!exists) {
      res.status(400).json({ success: false, error: 'EMAIL_NOT_FOUND' })
      return
    }

    await verifyEmailOtp(email, emailCode, 'reset_password')
    await resetPasswordByEmail({ email, newPassword })
    res.status(200).json({ success: true })
  } catch (e: any) {
    const message = String(e?.message ?? 'RESET_PASSWORD_FAILED')
    const knownErrors = new Set([
      'EMAIL_REQUIRED',
      'EMAIL_CODE_REQUIRED',
      'INVALID_INPUT',
      'EMAIL_NOT_FOUND',
      'OTP_INVALID_OR_EXPIRED',
      'OTP_TOO_MANY_ATTEMPTS',
    ])
    res.status(400).json({
      success: false,
      error: knownErrors.has(message) ? message : 'RESET_PASSWORD_FAILED',
    })
  }
})

/**
 * User Login
 * POST /api/auth/login
 */
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const schema = z.object({
    emailOrUsername: z.string().min(1),
    password: z.string().min(1),
  })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'INVALID_INPUT' })
    return
  }

  try {
    const data = parsed.data as { emailOrUsername: string; password: string }
    const login = await loginUser(data)
    res.status(200).json({ success: true, ...login })
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message ?? 'LOGIN_FAILED' })
  }
})

/**
 * User Logout
 * POST /api/auth/logout
 */
router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  if (token) await logoutToken(token)
  res.status(200).json({ success: true })
})

router.post('/guest', async (req: Request, res: Response): Promise<void> => {
  const schema = z.object({ nickname: z.string().optional() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'INVALID_INPUT' })
    return
  }

  try {
    const login = await guestLogin({ nickname: parsed.data.nickname })
    res.status(200).json({ success: true, ...login })
  } catch {
    res.status(500).json({ success: false, error: 'GUEST_LOGIN_FAILED' })
  }
})

router.post('/upgrade', async (req: Request, res: Response): Promise<void> => {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  if (!token) {
    res.status(401).json({ success: false, error: 'UNAUTHORIZED' })
    return
  }

  const schema = z.object({
    username: z.string().trim().min(1).optional(),
    emailOrUsername: z.string().trim().min(1).optional(),
    email: z.string().trim().email().optional(),
    password: z.string().min(6),
    nickname: z.string().trim().optional(),
    emailCode: z.string().trim().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'INVALID_INPUT' })
    return
  }

  try {
    const data = parsed.data as {
      username?: string
      emailOrUsername?: string
      email?: string
      password: string
      nickname?: string
      emailCode?: string
    }
    const { username, email } = normalizeAccountPayload(data)

    if (!username) {
      res.status(400).json({ success: false, error: 'USERNAME_REQUIRED' })
      return
    }
    if (!email) {
      res.status(400).json({ success: false, error: 'EMAIL_REQUIRED' })
      return
    }
    if (!data.emailCode || !data.emailCode.trim()) {
      res.status(400).json({ success: false, error: 'EMAIL_CODE_REQUIRED' })
      return
    }

    await verifyEmailOtp(email, data.emailCode, 'upgrade')

    const upgraded = await upgradeGuestToUser({
      token,
      username,
      email,
      password: data.password,
      nickname: data.nickname,
    })
    res.status(200).json({ success: true, ...upgraded })
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message ?? 'UPGRADE_FAILED' })
  }
})

router.get('/me', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const user = (req as AuthedRequest).user
  res.status(200).json({ success: true, user })
})

export default router
