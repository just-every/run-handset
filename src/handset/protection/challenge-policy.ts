import type { Bindings } from '../../auth.server'
import { evaluateRules, type Admission, type Rule, type Verdict } from './model'
/** Snapshot the actual effective inbound policy and fence its complete active
 * rule set. A concurrent allow/block/revoke cannot race a challenge completion. */
export async function challengePolicy(env:Bindings,a:Admission){
 const rules=(await env.DB.prepare('SELECT * FROM hnd_protection_rules WHERE revoked_at IS NULL ORDER BY id').all<Rule>()).results
 const callbacks=(await env.DB.prepare('SELECT id FROM hnd_protection_callbacks WHERE number_id=? AND caller=? AND expires_at>? ORDER BY id').bind(a.numberId,a.address,Date.now()).all<{id:string}>()).results
 const window=await env.DB.prepare('SELECT expires_at FROM hnd_protection_emergency_windows WHERE number_id=? AND expires_at>?').bind(a.numberId,Date.now()).first<{expires_at:number}>()
 const verdict:Verdict=window?{decision:'exempt',reason:'post_911_callback_window',emergency:true}:callbacks.length?{decision:'exempt',reason:'designated_emergency_callback',emergency:true}:evaluateRules(rules,a)
 const fence=env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT CASE WHEN
  COALESCE((SELECT group_concat(id,',') FROM (SELECT id FROM hnd_protection_rules WHERE revoked_at IS NULL ORDER BY id)),'')=?
  AND COALESCE((SELECT group_concat(id,',') FROM (SELECT id FROM hnd_protection_callbacks WHERE number_id=? AND caller=? AND expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) ORDER BY id)),'')=?
  AND COALESCE((SELECT expires_at FROM hnd_protection_emergency_windows WHERE number_id=? AND expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)),0)=?
  THEN 1 ELSE 0 END`).bind(rules.map(r=>r.id).join(','),a.numberId,a.address,callbacks.map(c=>c.id).join(','),a.numberId,window?.expires_at??0)
 return {verdict,fence}
}
