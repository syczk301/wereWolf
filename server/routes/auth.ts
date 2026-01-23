/**
 * This is a user authentication API route demo.
 * Handle user registration, login, token management, etc.
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { guestLogin, loginUser, logoutToken, registerUser, upgradeGuestToUser } from '../services/authService.js'
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js'

const router = Router()

router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const schema = z.object({
    emailOrUsername: z.string().min(1),
    password: z.string().min(6),
    nickname: z.string().min(1).max(20),
  })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'INVALID_INPUT' })
    return
  }

  try {
    const data = parsed.data as { emailOrUsername: string; password: string; nickname: string }
    await registerUser(data)
    const login = await loginUser({
      emailOrUsername: data.emailOrUsername,
      password: data.password,
    })
    res.status(200).json({ success: true, ...login })
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message ?? 'REGISTER_FAILED' })
  }
})

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
    emailOrUsername: z.string().min(1),
    password: z.string().min(6),
    nickname: z.string().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'INVALID_INPUT' })
    return
  }

  try {
    const data = parsed.data as { emailOrUsername: string; password: string; nickname?: string }
    const upgraded = await upgradeGuestToUser({ token, ...data })
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

