import type { NextFunction, Response } from 'express'
import type { AuthedRequest } from './requireAuth.js'
import { isAdminUser } from '../services/authService.js'

export async function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user || req.user.isGuest) {
      res.status(403).json({ success: false, error: 'FORBIDDEN' })
      return
    }

    const allowed = await isAdminUser(req.user.id)
    if (!allowed) {
      res.status(403).json({ success: false, error: 'FORBIDDEN' })
      return
    }

    next()
  } catch {
    res.status(403).json({ success: false, error: 'FORBIDDEN' })
  }
}
