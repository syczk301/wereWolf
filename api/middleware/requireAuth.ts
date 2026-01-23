import type { NextFunction, Request, Response } from 'express'
import { verifyAccessToken } from '../services/authService.js'

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''

  if (!token) {
    res.status(401).json({ success: false, error: 'UNAUTHORIZED' })
    return
  }

  try {
    const user = await verifyAccessToken(token)
    ;(req as any).user = user
    next()
  } catch {
    res.status(401).json({ success: false, error: 'UNAUTHORIZED' })
  }
}

export type AuthedRequest = Request & { user: { id: string; nickname: string; isGuest: boolean } }
