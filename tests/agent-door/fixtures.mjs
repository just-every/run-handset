import { randomUUID } from 'node:crypto';
/** Every phase uses genuine native person routes and fresh, reviewed records. */
export default async function ({phase,request,origin,cookie,database}) {
 const post=async(path,value)=>{
  const response=await request(new URL(path,origin).href,{method:'POST',redirect:'manual',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(value)});
  if(response.status!==201)throw new Error(`Native preparation ${path} returned ${response.status}`);
  return response.json();
 };
 const detail=await post('/api/handset/cases',{title:`Reviewed callback ${phase}`});
 const caseId=detail.current.id;
 const record=async(kind,data)=>(await post('/api/handset/records',{kind,sourceId:randomUUID(),occurredAt:Date.now(),caseId,data})).record.id;
 const number=await record('number',{e164:'+15125550124'});
 const recipient=await record('person',{name:'Alex Rivera'});
 const issued=await post('/api/handset/grants',{name:'Front office preparation',definition:{scopes:['read','draft','send'],tools:['case.read','comment.draft','call.paid','message.send','campaign.launch','number.release','flow.publish'],records:[caseId],numbers:[number],recipients:[recipient],budgetCents:100000,policyRevision:'owner-only-v1'},expiresAt:Date.now()+3600000,confirm:'approve scoped credential'});
 const grant=issued.grant;
 const clients={native:{token:issued.token,clientId:'handset-grant:'+grant.id,agent:{id:grant.id,name:grant.name,specialist:'front-office-phone-operator'}}};
 const values={case:{id:caseId},grant:{id:grant.id}};
 for(const verb of ['call.paid','message.send','campaign.launch','number.release','flow.publish']){
  const state={operation:verb,caseId,caseVersion:1,numberId:number,recipients:[recipient],amountCents:0,flowRevision:'1',policyRevision:'owner-only-v1',content:'Prepare requested work; no provider effect'};
  const approval=await post('/api/handset/grants/approve',{grantId:grant.id,state,expiresAt:Date.now()+1800000,confirm:'approve exact reviewed state'});
  const injected=await post('/api/handset/grants/approve',{grantId:grant.id,state,expiresAt:Date.now()+1800000,confirm:'approve exact reviewed state'});
  values[verb]={state,approvalId:approval.id,injectionApprovalId:injected.id};
 }
 if(phase==='negative'){
  const db=await database('DB');
  const person=await db.prepare('SELECT business_id,operator_id,email FROM bs_team WHERE email=?').bind('synthetic-inactive@example.invalid').first();
  if(!person)throw new Error('Signed native member binding unavailable');
  const suspended=await request(new URL('/auth/operator/status',origin).href,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({operatorId:person.operator_id,status:'inactive'})});
  if(!suspended.ok)throw new Error('Native member suspension failed');
  return {values,clients,sponsors:{inactive:{sub:person.business_id,email:person.email}}};
 }
 return {values,clients};
}
