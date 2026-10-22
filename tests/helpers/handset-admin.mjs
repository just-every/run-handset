import assert from 'node:assert/strict'
import { post, signIn } from './handset-auth.mjs'

const encode=value=>'"'+String(value).replaceAll('"','""')+'"'
const serialize=(columns,rows)=>[columns.join(','),...rows.map(row=>columns.map(c=>encode(row[c]??'')).join(','))].join('\r\n')

// Synthetic installation records, submitted through the actual public CSV door.
export function adminCsv({users=60,devices=40,broken=false}={}) {
 const people=Array.from({length:users},(_,i)=>({email:`synthetic-handset-${1000+i}@example.test`,name:`${['Rosa García','Elliot Brooks','Mara Patel','Daniel Kim'][i%4]} ${i+1}`,extension:String(1000+i),location:i%2?'Austin office':'San Antonio office',emergencyAddress:i%2?'110 Congress Avenue, Floor 2, Austin TX 78701':'200 Main Plaza, Suite 3, San Antonio TX 78205',role:i===users-1?'greeting':'member',queues:i%2?'Spanish support':'Front desk'}))
 const hardware=Array.from({length:devices},(_,i)=>({mac:(0x020000000000+i).toString(16).padStart(12,'0').toUpperCase(),name:`${i%2?'Recepción':'Front desk'} ${i+1}`,extension:String(2000+i),location:'Austin office',emergencyAddress:'110 Congress Avenue, Floor 2, Austin TX 78701',userEmail:people.length?people[i%people.length].email:''}))
 if(broken){people[1].extension=people[0].extension;hardware[1].mac=hardware[0].mac;hardware[2].emergencyAddress=''}
 return {usersCsv:serialize(['email','name','extension','location','emergencyAddress','role','queues'],people),devicesCsv:serialize(['mac','name','extension','location','emergencyAddress','userEmail'],hardware),people,hardware}
}
export async function adminFixture(runtime,{users=60,devices=40,cookie}={}) {
 cookie??=(await signIn(runtime)).cookie
 const headers={cookie},base='/api/handset/admin'
 const send=(path,data)=>post(runtime,base+path,data,headers)
 async function result(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json()}
 const preview=async(csv=adminCsv({users,devices}))=>result(await send('/bulk/preview',{usersCsv:csv.usersCsv,devicesCsv:csv.devicesCsv}),201)
 const approve=async plan=>result(await send('/plans/'+plan.id+'/approve',{planHash:plan.hash,confirm:'approve exact local configuration'}))
 const apply=async(plan,limit=25)=>result(await send('/plans/'+plan.id+'/apply',{planHash:plan.hash,limit}))
 async function finish(plan){for(let i=0;i<=plan.snapshot.rows.length&&plan.status!=='completed';i++)plan=await apply(plan);assert.equal(plan.status,'completed');return plan}
 const read=async path=>result(await runtime.request(base+path,{headers}))
 const create=async(path,data)=>result(await send(path,data),201)
 return {cookie,headers,base,send,result,preview,approve,apply,finish,read,create,csv:adminCsv({users,devices})}
}
