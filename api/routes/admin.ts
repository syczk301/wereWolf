import { Router, type Response } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { deleteManagedUser, listManagedUsers, updateManagedUser } from '../services/authService.js'

const router = Router()

router.use(requireAdmin)

router.get(
  '/users',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const query = typeof req.query.q === 'string' ? req.query.q : ''
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 200
    const limit = Number.isFinite(limitRaw) ? limitRaw : 200
    const users = await listManagedUsers({ query, limit })
    res.status(200).json({ success: true, users })
  }),
)

router.patch(
  '/users/:userId',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const schema = z
      .object({
        nickname: z.string().trim().min(1).max(20).optional(),
        password: z.string().min(6).max(128).optional(),
      })
      .refine((value) => value.nickname !== undefined || value.password !== undefined, {
        message: 'INVALID_PATCH',
      })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'INVALID_INPUT' })
      return
    }

    try {
      const user = await updateManagedUser(req.params.userId, parsed.data)
      res.status(200).json({ success: true, user })
    } catch (e: any) {
      const message = String(e?.message ?? 'UPDATE_FAILED')
      if (message === 'NOT_FOUND') {
        res.status(404).json({ success: false, error: 'NOT_FOUND' })
        return
      }
      if (message === 'INVALID_USER' || message === 'INVALID_PATCH') {
        res.status(400).json({ success: false, error: message })
        return
      }
      throw e
    }
  }),
)

router.delete(
  '/users/:userId',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    if (req.params.userId === req.user.id) {
      res.status(400).json({ success: false, error: 'SELF_DELETE_FORBIDDEN' })
      return
    }

    try {
      await deleteManagedUser(req.params.userId)
      res.status(200).json({ success: true })
    } catch (e: any) {
      const message = String(e?.message ?? 'DELETE_FAILED')
      if (message === 'NOT_FOUND') {
        res.status(404).json({ success: false, error: 'NOT_FOUND' })
        return
      }
      if (message === 'INVALID_USER') {
        res.status(400).json({ success: false, error: message })
        return
      }
      throw e
    }
  }),
)

export default router
