import { parseDataset } from '../metrics/model'
import type { ImportDoorSource } from '../../modules/import-kit/src/door/types'
import type { Json } from '../../modules/import-kit/src/types'

export const namespace = 'queue-dataset'
export const destination = 'handset-queue-metrics'
export const targetKind = 'queue-dataset'
/** A single allow-list shared by the owner and trusted Business mounts. */
export function importSource(name: string): ImportDoorSource | null {
 if (name !== namespace) return null
 return {
  parse(value) {
   const dataset = parseDataset(value)
   return { kind: targetKind, sourceId: dataset.id, payload: dataset as unknown as Json }
  },
  mapping: {
   version: 'handset-queue-dataset-v1',
   map(record) {
    if (record.kind !== targetKind) return { effects: [], rejection: 'Unsupported source entity; only queue metric datasets are accepted.' }
    const dataset = parseDataset(record.payload)
    return { effects: [{ targetKind, targetId: dataset.id, value: dataset as unknown as Json }] }
   },
  },
 }
}
