import { Router, type Response, type Request } from 'express'
import { z } from 'zod'
import { roomService } from '../../api/services/roomService.js'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { asyncHandler } from '../utils/asyncHandler.js'

const router = Router()

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const rooms = await roomService.listRooms()
    res.status(200).json({ success: true, rooms })
  }),
)

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthedRequest
    const schema = z.object({
      name: z.string().optional(),
      maxPlayers: z.number().int().min(4).max(20),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'INVALID_INPUT' })
      return
    }

    const room = await roomService.createRoom(
      authReq.user.id,
      authReq.user.nickname,
      parsed.data.name ?? '',
      parsed.data.maxPlayers,
    )
    res.status(200).json({ success: true, room })
  }),
)

router.get('/:roomId', async (req: Request, res: Response) => {
  try {
    const room = await roomService.getRoomState(req.params.roomId)
    res.status(200).json({ success: true, room })
  } catch (e: any) {
    res.status(404).json({ success: false, error: e?.message ?? 'NOT_FOUND' })
  }
})

export default router

