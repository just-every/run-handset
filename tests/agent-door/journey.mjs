import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import prepare from './fixtures.mjs';
export default async function (context) {
 const {values}=await prepare({...context,phase:'native-guards'});
 const {tool,request,origin,cookie,database}=context;
 const args={grantId:values.grant.id,caseId:values.case.id,text:'Prepared by the company agent for the native owner',idempotency_key:randomUUID()};
 const snapshot=async()=>(await tool('handset.workspace.snapshot',{})).result.structuredContent;
 const before=await snapshot();
 const stale=await tool('handset.comments.draft',{...args,expected_revision:0});
 assert.equal(stale.result?._meta?.['com.runeditrun/error']?.code,'revision_conflict');
 assert.deepEqual(await snapshot(),before);
 const done=await tool('handset.comments.draft',{...args,expected_revision:1});
 assert.equal(done.result?.isError,false);
 const db=await database('DB');
 const native=await db.prepare('SELECT prepared_by FROM hnd_drafts WHERE id=?').bind(done.result.structuredContent.id).first();
 assert.match(JSON.parse(native.prepared_by).label,/ for /);
 const history=await db.prepare('SELECT identity,idempotency_key FROM hnd_agent_jobs LIMIT 1').first();
 const identity=JSON.parse(history.identity);
 assert.ok(identity.consent&&identity.operationId&&identity.person.id&&identity.agent.id&&identity.scopes.length&&history.idempotency_key);
 const foreign=await tool('handset.cases.read',{grantId:values.grant.id,caseId:randomUUID()});
 assert.equal(foreign.result?._meta?.['com.runeditrun/error']?.code,'record_not_available');
 const revoked=await request(new URL(`/api/handset/grants/${values.grant.id}/revoke`,origin).href,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:'{}'});
 assert.equal(revoked.status,200);
 const denied=await tool('handset.comments.draft',{...args,idempotency_key:randomUUID()});
 assert.equal(denied.result?._meta?.['com.runeditrun/error']?.code,'application_credential_inactive');
}
