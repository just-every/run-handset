import { Fault, object, text, integer, keys, type ObjectValue } from '../core'
import type { Connector } from './model'
import { hash } from './model'

// Official provider REST edges; tokens are request-local and never persisted.
const google='https://www.googleapis.com/drive/v3'
const box='https://api.box.com/2.0'
export interface Destination {folder:string;host?:string;port?:number;user?:string;hostKey?:string}
export function destination(provider:Connector['provider'],value:unknown):Destination {
 const v=object(value)
 if(provider==='sftp'){
  keys(v,['folder','host','port','user','hostKey'])
  const host=text(v.host,'host',253),user=text(v.user,'user',64),folder=text(v.folder,'folder',500),hostKey=text(v.hostKey,'hostKey',100)
  if(!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)||! /^[a-z_][a-z0-9_-]*$/i.test(user)||!/^\/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]*$/i.test(folder)||folder.split('/').includes('..')||!/^SHA256:[a-zA-Z0-9+/]{43}$/.test(hostKey))throw new Fault('invalid_sftp_destination')
  return {host,user,folder:folder.replace(/\/$/,''),port:integer(v.port??22,'port',1,65535),hostKey}
 }
 keys(v,['folder']);const folder=text(v.folder,'folder',500)
 if(provider==='dropbox'?!/^\/(?:[a-zA-Z0-9_. -]+\/)*[a-zA-Z0-9_. -]+$/.test(folder):! /^[a-zA-Z0-9_-]+$/.test(folder))throw new Fault('invalid_archive_folder')
 if(folder.split('/').some(p=>p==='.'||p==='..'))throw new Fault('invalid_archive_folder')
 return {folder}
}
async function wire(url:string,credential:string,init:RequestInit={}){
 try{return await fetch(url,{...init,headers:{authorization:'Bearer '+credential,...init.headers},redirect:'manual',signal:AbortSignal.timeout(15000)})}catch{throw new Fault('export_remote_response_lost',503)}
}
async function data(response:Response){if(response.status<200||response.status>=300)throw new Fault(response.status===401||response.status===403?'export_remote_access_refused':'export_remote_unavailable',response.status===401||response.status===403?403:503);return object(await response.json())}
const rpc=(path:string,credential:string,value:unknown)=>wire('https://api.dropboxapi.com/2/'+path,credential,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)})
export async function preview(provider:Connector['provider'],d:Destination,credential:string){
 if(provider==='sftp')return {provider,destination:d,verification:'Pinned host key is checked by the buyer OpenSSH command before any transfer.',scopes:'Buyer SSH identity restricted to this directory.',encryption:'AES-256-GCM before transfer; SSH in transit',retention:'Buyer-managed remote retention'}
 if(!credential)throw new Fault('scoped_credential_required')
 let account:unknown,name:unknown
 if(provider==='box'){
  const folder=await data(await wire(box+'/folders/'+encodeURIComponent(d.folder)+'?fields=id,name,type,permissions,owned_by',credential))
  if(folder.id!==d.folder||folder.type!=='folder'||object(folder.permissions).can_upload!==true)throw new Fault('export_destination_not_writable',403)
  account=object(folder.owned_by).id;name=folder.name
 }else if(provider==='google-drive'){
  const me=await data(await wire(google+'/about?fields=user',credential)),folder=await data(await wire(google+'/files/'+encodeURIComponent(d.folder)+'?fields=id,name,mimeType,capabilities&supportsAllDrives=true',credential))
  if(folder.id!==d.folder||folder.mimeType!=='application/vnd.google-apps.folder'||object(folder.capabilities).canAddChildren!==true)throw new Fault('export_destination_not_writable',403)
  account=object(me.user).permissionId;name=folder.name
 }else{
  const me=await data(await rpc('users/get_current_account',credential,null)),folder=await data(await rpc('files/get_metadata',credential,{path:d.folder}))
  if(folder['.tag']!=='folder')throw new Fault('export_destination_not_folder')
  account=me.account_id;name=folder.name
 }
 if(typeof account!=='string'||typeof name!=='string')throw new Fault('export_destination_identity_missing',502)
 return {provider,account,name,destination:d,encryption:'AES-256-GCM before transfer; TLS in transit',scopes:provider==='google-drive'?'Use a buyer token with drive.file access to this selected folder.':provider==='dropbox'?'Use a buyer app-folder token with metadata read and content read and write.':'Use a buyer token downscoped to this selected folder with base_explorer, base_upload and item_download.',retention:'Buyer-managed remote retention'}
}
export async function reserveDriveId(credential:string){const body=await data(await wire(google+'/files/generateIds?count=1&space=drive&type=files',credential));if(!Array.isArray(body.ids)||typeof body.ids[0]!=='string')throw new Fault('export_remote_id_missing',502);return body.ids[0]}
export async function lookup(c:Connector,credential:string,name:string,remoteId:string|null):Promise<string|null>{
 const d=JSON.parse(c.destination) as Destination
 if(c.provider==='dropbox'){
  const response=await rpc('files/get_metadata',credential,{path:d.folder+'/'+name})
  if(response.status===409){const responseBody=object(await response.json()),error=object(responseBody.error);if(error['.tag']==='path'&&object(error.path)['.tag']==='not_found')return null;throw new Fault('export_remote_lookup_failed',503)}
  const found=await data(response);if(found['.tag']!=='file'||typeof found.id!=='string')throw new Fault('export_remote_identity_mismatch',502);return found.id
 }
 if(c.provider==='google-drive'){
  if(!remoteId)throw new Fault('export_remote_id_required',409)
  const response=await wire(google+'/files/'+encodeURIComponent(remoteId)+'?fields=id,name,parents,trashed&supportsAllDrives=true',credential)
  if(response.status===404)return null
  const found=await data(response)
  if(found.id!==remoteId||found.name!==name||found.trashed===true||!Array.isArray(found.parents)||!found.parents.includes(d.folder))throw new Fault('export_remote_identity_mismatch',502)
  return remoteId
 }
 if(c.provider!=='box')throw new Fault('sftp_buyer_command_required',409)
 let offset=0,found:string|null=null
 while(true){const page=await data(await wire(box+'/folders/'+encodeURIComponent(d.folder)+'/items?fields=id,name,type&limit=1000&offset='+offset,credential));if(!Array.isArray(page.entries)||!Number.isSafeInteger(page.total_count))throw new Fault('export_remote_listing_invalid',502);for(const raw of page.entries){const entry=object(raw);if(entry.name===name){if(found||entry.type!=='file'||typeof entry.id!=='string')throw new Fault('export_remote_identity_ambiguous',409);found=entry.id}}offset+=page.entries.length;if(offset>=Number(page.total_count))return found;if(!page.entries.length)throw new Fault('export_remote_listing_incomplete',503)}
}
export async function upload(c:Connector,credential:string,name:string,bytes:Uint8Array,remoteId:string|null){
 const d=JSON.parse(c.destination) as Destination
 if(c.provider==='dropbox'){
  const response=await wire('https://content.dropboxapi.com/2/files/upload',credential,{method:'POST',headers:{'content-type':'application/octet-stream','Dropbox-API-Arg':JSON.stringify({path:d.folder+'/'+name,mode:'add',autorename:false,mute:true,strict_conflict:true})},body:new Uint8Array(bytes)})
  if(response.status===409)return
  await data(response);return
 }
 if(c.provider==='box'){
  const form=new FormData();form.append('attributes',JSON.stringify({name,parent:{id:d.folder}}));form.append('file',new Blob([new Uint8Array(bytes)],{type:'application/octet-stream'}),name)
  const response=await wire('https://upload.box.com/api/2.0/files/content',credential,{method:'POST',body:form});if(response.status===409)return;await data(response);return
 }
 if(c.provider!=='google-drive')throw new Fault('sftp_buyer_command_required',409)
 const boundary='handset_'+crypto.randomUUID().replaceAll('-',''),meta=JSON.stringify({id:remoteId,name,parents:[d.folder],mimeType:'application/octet-stream'}),start=new TextEncoder().encode('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+meta+'\r\n--'+boundary+'\r\nContent-Type: application/octet-stream\r\n\r\n'),end=new TextEncoder().encode('\r\n--'+boundary+'--\r\n'),body=new Uint8Array(start.length+bytes.length+end.length);body.set(start);body.set(bytes,start.length);body.set(end,start.length+bytes.length)
 const response=await wire('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',credential,{method:'POST',headers:{'content-type':'multipart/related; boundary='+boundary},body});if(response.status===409)return;await data(response)
}
export async function download(c:Connector,credential:string,remoteId:string,name:string){
 const d=JSON.parse(c.destination) as Destination
 let response:Response
 if(c.provider==='dropbox')response=await wire('https://content.dropboxapi.com/2/files/download',credential,{method:'POST',headers:{'Dropbox-API-Arg':JSON.stringify({path:d.folder+'/'+name})}})
 else if(c.provider==='google-drive')response=await wire(google+'/files/'+encodeURIComponent(remoteId)+'?alt=media&supportsAllDrives=true',credential)
 else if(c.provider==='box'){
  response=await wire(box+'/files/'+encodeURIComponent(remoteId)+'/content',credential)
  for(let hop=0;response.status===302&&hop<3;hop++){
   const target=new URL(response.headers.get('location')??'')
   if(target.protocol!=='https:'||!target.hostname.endsWith('.boxcloud.com')||target.username||target.password)throw new Fault('export_unsafe_download_redirect',502)
   response=await fetch(target,{redirect:'manual',signal:AbortSignal.timeout(15000)})
  }
 }else throw new Fault('sftp_buyer_command_required',409)
 if(response.status!==200)throw new Fault('export_readback_unavailable',503)
 const bytes=await boundedBytes(response)
 return {hash:await hash(bytes),size:bytes.length}
}
export async function boundedBytes(response:Response){
 const reader=response.body?.getReader();if(!reader)throw new Fault('export_empty_response',503)
 const chunks:Uint8Array[]=[];let size=0
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>11_000_000)throw new Fault('export_file_size_unqualified',413);chunks.push(part.value)}}finally{await reader.cancel()}
 const result=new Uint8Array(size);let at=0;for(const chunk of chunks){result.set(chunk,at);at+=chunk.length}return result
}
