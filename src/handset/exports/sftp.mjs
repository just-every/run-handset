#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const quote=value=>'"'+String(value).replaceAll('\\','\\\\').replaceAll('"','\\"')+'"'
async function execute(binary,args,input=''){
 return new Promise((done,fail)=>{
  const child=spawn(binary,args,{stdio:['pipe','pipe','pipe']}),chunks=[],errors=[]
  child.stdout.on('data',part=>chunks.push(part));child.stderr.on('data',part=>errors.push(part))
  child.once('error',()=>fail(new Error('SFTP executable could not start')))
  child.once('close',code=>done({code,output:Buffer.concat(chunks).toString(),error:Buffer.concat(errors).toString()}))
  child.stdin.on('error',()=>{});child.stdin.end(input)
 })
}
async function privateConfig(path){
 const info=await stat(path)
 if(!info.isFile()||(info.mode&0o077))throw new Error('Settings must be a private mode-0600 file')
 const value=JSON.parse(await readFile(path,'utf8'))
 const origin=new URL(value.origin)
 if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw new Error('An HTTPS Handset origin is required')
 if(typeof value.email!=='string')throw new Error('A native sign-in email is required')
 return {...value,origin:origin.origin}
}
async function request(config,path,body,cookie,network=fetch){
 return network(config.origin+path,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{...(body===undefined?{}:{origin:config.origin,'content-type':'application/json'}),...(cookie?{cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})})
}
async function json(response){if(!response.ok)throw new Error('Native export door refused the request (HTTP '+response.status+')');return response.json()}
async function authenticate(config){
 if(typeof config.confirmationToken!=='string')throw new Error('Add the token from the separately requested native email link to the private settings file')
 const response=await request(config,'/auth/confirm',{token:config.confirmationToken})
 if(response.status!==303)throw new Error('Native sign-in was refused; request a fresh email link')
 const cookie=response.headers.get('set-cookie')?.split(';')[0]
 if(!cookie)throw new Error('Native sign-in did not issue a session')
 return cookie
}
export async function runSftp(config,cookie,network=fetch){
 const api=(path,body)=>request(config,path,body,cookie,network)
 if(!/^[0-9a-f-]{36}$/.test(config.jobId)||! /^[a-f0-9]{64}$/.test(config.encryptionKey))throw new Error('An exact export ID and buyer AES-256 key are required')
 const root='/api/handset/exports/jobs/'+config.jobId,job=await json(await api(root)),d=job.destination?.destination
 if(job.destination?.provider!=='sftp'||!d||job.personId===undefined)throw new Error('Select an approved native SFTP archive')
 if(!['approved','interrupted','client_verified'].includes(job.state))throw new Error('The owner must approve the exact archive before transfer')
 if(!/^[a-z0-9][a-z0-9.-]*$/i.test(d.host)||! /^[a-z_][a-z0-9_-]*$/i.test(d.user)||!Number.isInteger(d.port)||d.port<1||d.port>65535||! /^\/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]*$/i.test(d.folder)||d.folder.split('/').includes('..'))throw new Error('Native SFTP destination is invalid')
 const known=resolve(config.knownHostsFile),identity=resolve(config.identityFile),directory=await mkdtemp(join(tmpdir(),'handset-sftp-'))
 try{
  const knownInfo=await stat(known),identityInfo=await stat(identity)
  if(!knownInfo.isFile()||!identityInfo.isFile()||(identityInfo.mode&0o077))throw new Error('Buyer SSH identity must be private and host keys must be a regular file')
  const host=d.port===22?d.host:'['+d.host+']:'+d.port,matched=await execute('/usr/bin/ssh-keygen',['-F',host,'-f',known])
  if(matched.code!==0)throw new Error('The buyer known-hosts file does not contain this exact destination')
  const pinned=join(directory,'known_hosts');await writeFile(pinned,matched.output,{mode:0o600})
  const fingerprints=await execute('/usr/bin/ssh-keygen',['-l','-E','sha256','-f',pinned])
  if(fingerprints.code!==0||!fingerprints.output.trim().split('\n').every(line=>line.split(/\s+/)[1]===d.hostKey))throw new Error('The SSH host key differs from the owner-approved fingerprint')
  const args=['-F','/dev/null','-b','-','-P',String(d.port),'-i',identity,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','GlobalKnownHostsFile=/dev/null','-o','UserKnownHostsFile='+pinned,'-o','ConnectTimeout=15',d.user+'@'+d.host]
  const sftp=async commands=>{const result=await execute('/usr/bin/sftp',args,commands+'\n');if(result.code!==0)throw new Error('SFTP transfer failed; the archive can be resumed with a fresh native sign-in');return result}
  // Listing failure stops before upload; a missing individual file is the only ignored get.
  await sftp('ls '+quote(d.folder))
  for(const f of job.files){
   if(f.state==='unavailable')continue
   if(!/^[a-z0-9.-]+$/.test(f.name)||! /^[a-z0-9-]+$/.test(f.fileKey))throw new Error('Native export filename is invalid')
   const response=await api(root+'/files/'+f.fileKey,{encryptionKey:config.encryptionKey})
   if(response.status===409){const fresh=await json(await api(root));if(fresh.files.find(row=>row.fileKey===f.fileKey)?.state==='unavailable')continue}
   if(!response.ok)throw new Error('Native artifact door refused release (HTTP '+response.status+')')
   const bytes=Buffer.from(await response.arrayBuffer()),expected=response.headers.get('x-handset-cipher-sha256')
   if(!expected||sha(bytes)!==expected)throw new Error('Native artifact checksum failed')
   const local=join(directory,'artifact.aes'),readback=join(directory,'readback.aes'),remote=d.folder+'/'+f.name
   await writeFile(local,bytes,{mode:0o600});await rm(readback,{force:true})
   await sftp('-get '+quote(remote)+' '+quote(readback))
   let exists=false
   try{const downloaded=await readFile(readback);exists=true;if(sha(downloaded)!==expected)throw new Error('Existing remote archive file has different content; refusing overwrite')}catch(error){if(error.code!=='ENOENT')throw error}
   if(!exists){
    // Recheck connector, session, exact approval and content grants immediately before writing.
    const checked=await api(root+'/files/'+f.fileKey,{encryptionKey:config.encryptionKey})
    if(!checked.ok||checked.headers.get('x-handset-cipher-sha256')!==expected)throw new Error('Native export authority changed before transfer')
    await checked.body?.cancel()
    const temporary=remote+'.partial'
    await sftp('put '+quote(local)+' '+quote(temporary)+'\nrename '+quote(temporary)+' '+quote(remote))
   }
   await sftp('get '+quote(remote)+' '+quote(readback))
   if(sha(await readFile(readback))!==expected)throw new Error('Independent SFTP download checksum failed')
   await json(await api(root+'/receipt',{fileKey:f.fileKey,cipherSha256:expected,remotePath:remote,confirm:'I independently downloaded and verified this encrypted SFTP file'}))
   process.stdout.write('Verified '+f.name+' SHA-256 '+expected+'\n')
  }
  const final=await json(await api(root))
  if(final.state!=='client_verified')throw new Error('Archive remains incomplete; inspect its native transfer state')
  process.stdout.write('Archive verified by buyer OpenSSH readback. External copies remain in separate buyer custody.\n')
 }finally{await rm(directory,{recursive:true,force:true})}
}
export async function main(args=process.argv.slice(2)){
 const [command,path]=args
 if(args.length!==2||!['request-login','run'].includes(command))throw new Error('Usage: node ./src/handset/exports/sftp.mjs request-login|run ./private-settings.json')
 const config=await privateConfig(path)
 if(command==='request-login'){
  const response=await request(config,'/auth/magic-link',{email:config.email,returnTo:'/app/exports'})
  if(response.status!==202)throw new Error('Native email sign-in request was refused')
  process.stdout.write('Check your native sign-in email. Put its confirmation token in the private settings file, then run this command with run. No browser session is copied.\n');return
 }
 await runSftp(config,await authenticate(config))
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1})
