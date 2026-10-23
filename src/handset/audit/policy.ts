/** Only server-selected opaque references and revisions belong in the ledger.
 * Never copy a caller's policy label, payload, person name or credential. */
export interface Revision { id:string; revision:number; ownerVersion?:number }
export interface AppliedPolicy {
 native?:{role:'owner'|'admin'|'member';version:number};
 source?:Revision; line?:Revision; grant?:Revision; standing?:Revision;
 delegation?:Revision; approval?:Revision; recording?:Revision; route?:Revision;
 qualification?:Revision; rule?:Revision; list?:Revision; access?:Revision; scopes?:Revision[];
}
const legacy = ['owner-only-v1','handset-authorization-v2']
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const positive = (n:unknown) => Number.isSafeInteger(n)&&Number(n)>0
const validRevision=(v:unknown):v is Revision=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>['id','revision','ownerVersion'].includes(k))&&reference.test(String((v as Revision).id))&&positive((v as Revision).revision)&&((v as Revision).ownerVersion===undefined||positive((v as Revision).ownerVersion))
export function validPolicy(value:string){
 if(legacy.includes(value))return true
 try{
  const p=JSON.parse(value)
  if(!p||p.schema!=='handset-authorization-v3'||!p.applied||typeof p.applied!=='object'||Array.isArray(p.applied)||Object.keys(p).some(k=>!['schema','applied'].includes(k)))return false
  for(const [key,v] of Object.entries(p.applied) as [string,Record<string,unknown>][]){
   if(key==='scopes'){if(!Array.isArray(v)||!v.length||!v.every(validRevision))return false;continue}
   if(!v||typeof v!=='object'||Array.isArray(v))return false
   if(key==='native'){
    if(Object.keys(v).some(k=>!['role','version'].includes(k))||!['owner','admin','member'].includes(String(v.role))||!positive(v.version))return false
   }else if(!['source','line','grant','standing','delegation','approval','recording','route','qualification','rule','list','access'].includes(key)||Object.keys(v).some(k=>!['id','revision','ownerVersion'].includes(k))||!reference.test(String(v.id))||!positive(v.revision)||v.ownerVersion!==undefined&&!positive(v.ownerVersion))return false
  }
  return true
 }catch{return false}
}
export function policyRevision(applied:AppliedPolicy){
 const value=JSON.stringify({schema:'handset-authorization-v3',applied})
 if(!validPolicy(value))throw new Error('Invalid applied audit policy')
 return value
}
export const sourcePolicy=(source:{id:string;revision:number;owner_version:number;consent_access_id?:string|null}):AppliedPolicy=>({source:{id:source.id,revision:source.revision,ownerVersion:source.owner_version},...(source.consent_access_id?{access:{id:source.consent_access_id,revision:1}}:{})})
export function describePolicy(value:string){
 if(legacy.includes(value))return value+' (retained legacy policy)'
 const {applied}=JSON.parse(value) as {applied:AppliedPolicy}
 const describe=(r:Revision)=>`${r.id} revision ${r.revision}${r.ownerVersion?' · authorizing person version '+r.ownerVersion:''}`
 return ['Authorization schema v3',...Object.entries(applied).map(([key,v])=>key==='native'?`Native ${(v as AppliedPolicy['native'])!.role} version ${(v as AppliedPolicy['native'])!.version}`:key==='scopes'?`Number work ${((v as Revision[]).map(describe)).join('; ')}`:`${key} ${describe(v as Revision)}`)].join(' · ')
}
