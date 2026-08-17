/** Portals (doors/windows) imported from UVTT files — admin can toggle open/closed. */
import { Router } from 'express'
import { db } from '../db'
import { authMiddleware, adminOnly } from '../auth'
import { broadcastToTable } from '../hub'

export const portalsRouter = Router()

function normalize(row: Record<string, unknown>) {
  return { ...row, closed: row.closed === 1 || row.closed === true }
}

portalsRouter.get('/tables/:id/portals', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT id, table_id, x1, y1, x2, y2, closed FROM portals WHERE table_id=?')
    .all(req.params.id) as Record<string, unknown>[]
  res.json(rows.map(normalize))
})

portalsRouter.patch('/tables/:id/portals/:portalId', authMiddleware, adminOnly, (req, res) => {
  const { closed } = req.body as { closed: boolean }
  db.prepare('UPDATE portals SET closed=? WHERE id=? AND table_id=?')
    .run(closed ? 1 : 0, req.params.portalId, req.params.id)
  const row = db.prepare('SELECT id, table_id, x1, y1, x2, y2, closed FROM portals WHERE id=?')
    .get(req.params.portalId) as Record<string, unknown>
  const portal = normalize(row)
  broadcastToTable(req.params.id, { type: 'portal_toggle', payload: { portal } })
  res.json(portal)
})
