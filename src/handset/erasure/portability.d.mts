import type { D1Sql } from '../../modules/import-kit/src/d1/types'
export function checkpoint(database: D1Database): Promise<D1Sql[]>
