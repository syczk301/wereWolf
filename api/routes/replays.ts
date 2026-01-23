import { Router, type Response } from 'express'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { getDb } from '../db/mongo.js'
import { asyncHandler } from '../utils/asyncHandler.js'

const router = Router()

router.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const db = await getDb()
    const replays = db.collection<{
      _id: string
      ownerUserIds: string[]
      createdAt: Date
      durationMs: number
      resultSummary: string
      roomName: string
      events: any[]
    }>('replays')
    const docs = await replays
      .find({ ownerUserIds: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray()

    const records = docs.map((d: any) => ({
      id: d._id,
      createdAt: d.createdAt?.toISOString?.() ?? new Date().toISOString(),
      roomName: d.roomName ?? '房间',
      resultSummary: d.resultSummary ?? '',
      durationMs: d.durationMs ?? 0,
    }))

    res.status(200).json({ success: true, records })
  }),
)

router.get(
  '/:replayId',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const db = await getDb()
    const replays = db.collection<{
      _id: string
      ownerUserIds: string[]
      createdAt: Date
      durationMs: number
      resultSummary: string
      roomName: string
      events: any[]
    }>('replays')
    const doc = await replays.findOne({ _id: req.params.replayId, ownerUserIds: req.user.id })
    if (!doc) {
      res.status(404).json({ success: false, error: 'NOT_FOUND' })
      return
    }

    const record = {
      id: doc._id,
      createdAt: doc.createdAt?.toISOString?.() ?? new Date().toISOString(),
      roomName: doc.roomName ?? '房间',
      resultSummary: doc.resultSummary ?? '',
      durationMs: doc.durationMs ?? 0,
    }

    res.status(200).json({
      success: true,
      detail: {
        record,
        events: doc.events ?? [],
      },
    })
  }),
)

export default router
