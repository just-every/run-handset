import type { Bindings } from '../../auth.server'
import { runtimeBindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import type { D1Sql } from '../../modules/import-kit/src/d1/types'
import type { ImportDoorClaimConfig } from '../../modules/import-kit/src/door/types'
import { destination, importSource, namespace } from './source'
import { targets } from './targets'

// Permanent door key. Configuring Business trust later must keep this key.
export const installationId = 'handset-import-door-v1'
export function ownerPredicate(actor: Session): D1Sql {
 return { sql: `EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
 WHERE s.id=? AND s.operator_id=? AND s.operator_version=o.version AND o.role='owner' AND o.status='active'
 AND s.revoked_at IS NULL AND s.expires_at>(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)))`, params:[actor.id,actor.operator.id] }
}
type ImportBindings = Bindings & Partial<Record<'RER_OWNER_CLAIM_ISSUER'|'RER_OWNER_CLAIM_INSTALLATION_ID'|'RER_OWNER_CLAIM_APP_ORIGIN'|'RER_OWNER_CLAIM_PUBLIC_KEYS',string>>
export function claimConfig(original: Bindings): ImportDoorClaimConfig | null {
 const env = runtimeBindings(original) as ImportBindings
 const {RER_OWNER_CLAIM_ISSUER:issuer,RER_OWNER_CLAIM_INSTALLATION_ID:id,RER_OWNER_CLAIM_APP_ORIGIN:appOrigin,RER_OWNER_CLAIM_PUBLIC_KEYS:keys}=env
 if (!issuer || !id || !appOrigin || !keys || appOrigin !== env.AUTH_ORIGIN) return null
 try {
  const publicKeys = JSON.parse(keys)
  if (!publicKeys || typeof publicKeys!=='object' || Array.isArray(publicKeys) || !Object.keys(publicKeys).length) return null
  return { issuer, installationId:id, appOrigin, expectedEmail:env.OWNER_EMAIL, publicKeys }
 } catch { return null }
}
export function runtime(env: Bindings, principalId = 'role:owner') {
 return { database:env.DB, targets, destination, ownerPrincipalId:principalId, format:'json' as const,
  reversalPolicy:'preserve-conflicts' as const, limits:{maxBytes:2_097_152,maxRecordBytes:1_048_576,maxRecords:100}, ...importSource(namespace)! }
}
