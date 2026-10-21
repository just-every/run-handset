import type { D1Database, D1Sql, D1TargetAdapter } from '../../modules/import-kit/src/d1/types'
import type { TargetRow } from '../../modules/import-kit/src/types'
import { canonicalJson } from '../../modules/import-kit/src/provenance/identity'
import { destination, targetKind } from './source'

interface NativeRow { id: string; revision: number; value: string; kit_revision: string | null; native_revision: number | null; imported_value: string | null }
const select = `SELECT d.id,d.revision,d.value,r.kit_revision,r.native_revision,r.value AS imported_value
 FROM hnd_metric_datasets d LEFT JOIN hnd_metric_import_revisions r ON r.id=d.id`
const effectiveRevision = `CASE WHEN r.native_revision=d.revision AND r.value=d.value THEN r.kit_revision ELSE CAST(d.revision AS TEXT) END`
const sql = (sql: string, ...params: unknown[]): D1Sql => ({ sql, params })
function scope(to: string, kind = targetKind) {
 if (to !== destination || kind !== targetKind) throw new Error('IMPORT_NATIVE_SCOPE')
}
function target(row: NativeRow): TargetRow {
 return { destination, targetKind, targetId: row.id, revision: row.native_revision === row.revision && row.imported_value === row.value && row.kit_revision !== null ? row.kit_revision : String(row.revision), value: JSON.parse(row.value) }
}
/** Native records are inert historical metric data. No transport/provider operations. */
export const targets: D1TargetAdapter = {
 async read(db, to, kind, id) {
  scope(to, kind)
  const row = await db.prepare(select+' WHERE d.id=?').bind(id).first<NativeRow>()
  return row ? target(row) : undefined
 },
 matches(row, to, kind, id) {
  scope(to, kind)
  return row
   ? sql(`EXISTS(SELECT 1 FROM hnd_metric_datasets d LEFT JOIN hnd_metric_import_revisions r ON r.id=d.id WHERE d.id=? AND ${effectiveRevision}=? AND d.value=?)`, id, row.revision, canonicalJson(row.value))
   : sql('NOT EXISTS(SELECT 1 FROM hnd_metric_datasets WHERE id=?)', id)
 },
 matchesCount(count, to) { scope(to); return sql('(SELECT count(*) FROM hnd_metric_datasets)=?', count) },
 write(row) {
  scope(row.destination, row.targetKind)
  if (row.attachment) throw new Error('IMPORT_ATTACHMENT_UNSUPPORTED')
  const value = canonicalJson(row.value)
  return [
   sql(`INSERT INTO hnd_metric_datasets(id,revision,value) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET revision=hnd_metric_datasets.revision+1,value=excluded.value`,row.targetId,value),
   sql(`INSERT INTO hnd_metric_import_revisions(id,kit_revision,native_revision,value) SELECT id,?,revision,value FROM hnd_metric_datasets WHERE id=? ON CONFLICT(id) DO UPDATE SET kit_revision=excluded.kit_revision,native_revision=excluded.native_revision,value=excluded.value`,row.revision,row.targetId),
  ]
 },
 remove(to, kind, id) {
  scope(to, kind)
  return [sql('DELETE FROM hnd_metric_import_revisions WHERE id=?',id),sql('DELETE FROM hnd_metric_datasets WHERE id=?',id)]
 },
 async list(db, to) { scope(to); return (await db.prepare(select+' ORDER BY d.id').all<NativeRow>()).results.map(target) },
 async preparePreservedUndo(db: D1Database, to, effects) {
  const rows = await this.list(db,to)
  const byId = new Map(rows.map(row => [row.targetId,row]))
  return {
   observations: effects.map(effect => ({ effectId:effect.provenance.id,current:byId.get(effect.provenance.targetId) ?? null,entity:{table:'hnd_metric_datasets',recordId:effect.provenance.targetId} })),
   dependencies: [],
   guards: [this.matchesCount!(rows.length,to),...rows.map(row=>this.matches(row,to,row.targetKind,row.targetId))],
  }
 },
}
