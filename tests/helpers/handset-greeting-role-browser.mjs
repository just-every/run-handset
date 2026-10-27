import assert from 'node:assert/strict'
import { post, signIn } from './handset-auth.mjs'
import { wavBytes } from './handset-prompts.mjs'

export async function greetingRoleJourney({runtime,page,proof,cookie}){
 const access='/api/handset/prompts/access',ownerHeaders={cookie},personId='synthetic-handset-2'
 const switchTo=async value=>{
  const [name,...rest]=value.split('=');await page.context().clearCookies()
  await page.context().addCookies([{name,value:rest.join('='),url:runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
 }
 const click=async(form,name)=>{await form.getByRole('button',{name,exact:true}).click();await page.waitForLoadState('load')}
 assert.equal((await post(runtime,'/auth/operator/status',{operatorId:personId,status:'active'},ownerHeaders)).status,200)
 await page.getByRole('link',{name:'Greeting role settings',exact:true}).click();await proof('greeting-role-empty')
 const create=page.locator('form[action="/app/prompts/access"]')
 await create.getByLabel('Role name',{exact:true}).fill('Front desk greetings')
 await create.getByLabel('Main greeting',{exact:true}).check()
 await create.getByLabel('I approve this greeting draft role and scope',{exact:true}).check();await click(create,'Create greeting role')
 await proof('greeting-role-created')
 let snapshot=await (await runtime.request(access,{headers:ownerHeaders})).json(),role=snapshot.roles[0]
 assert.deepEqual([role.name,JSON.parse(role.capabilities)],['Front desk greetings',['greeting.draft']])
 const assign=page.locator(`form[action="/app/prompts/access/${role.id}/assign"]`)
 await assign.getByLabel('Member',{exact:true}).selectOption({label:'Elliot Brooks'})
 await assign.getByRole('checkbox').check();await click(assign,'Assign greeting role');await proof('greeting-role-assigned')
 snapshot=await (await runtime.request(access,{headers:ownerHeaders})).json()
 assert.deepEqual(snapshot.members.map(m=>[m.person_id,m.state]),[[personId,'active']])
 const member=await signIn({...runtime,ownerEmail:personId+'@example.test'}),headers={cookie:member.cookie}
 await switchTo(member.cookie);await page.goto(runtime.origin+'/app/prompts');await proof('greeting-role-staff')
 assert.deepEqual(await page.locator('select[name="promptId"] option').allTextContents(),['Main greeting'])
 assert.equal(await page.getByRole('button',{name:'Approve this exact version',exact:true}).count(),0)
 assert.equal(await page.getByRole('link',{name:'Greeting role settings',exact:true}).count(),0)
 const author=page.locator('[data-prompt-author]')
 await author.getByLabel('Audio file',{exact:true}).setInputFiles({name:'front-desk-greeting.wav',mimeType:'audio/wav',buffer:wavBytes({seconds:1.5})})
 await click(author,'Add version');await proof('greeting-role-draft-saved')
 const catalog=await (await runtime.request('/api/handset/prompts',{headers})).json()
 assert.deepEqual(catalog.prompts.map(p=>p.name),['Main greeting'])
 assert.ok(catalog.versions.some(v=>v.author_name==='Elliot Brooks'&&v.state==='draft'))
 for(const path of ['/app/prompts/access','/app/exports','/app/numbers','/app/admin/bulk']){
  const response=await page.goto(runtime.origin+path);assert.equal(response.status(),403,path)
  assert.equal(await page.getByRole('alert').count(),1)
 }
 await proof('greeting-role-administration-refused')
 await switchTo(cookie);await page.goto(runtime.origin+'/app/prompts/access')
 const revise=page.locator(`form[action="/app/prompts/access/${role.id}"]`)
 await revise.getByLabel('Edit greeting drafts',{exact:true}).uncheck()
 await revise.getByLabel('I approve this greeting draft role and scope',{exact:true}).check();await click(revise,'Save role revision')
 assert.match(await page.locator('main').innerText(),/Elliot Brooks · suspended/);await proof('greeting-role-revised')
 await switchTo(member.cookie);assert.equal((await page.goto(runtime.origin+'/app/prompts')).status(),403)
 await proof('greeting-role-scope-withdrawn')
 const target=catalog.prompts[0].id,body={source:'upload',language:'en',variant:'always',audioBase64:wavBytes({rate:8000}).toString('base64')}
 assert.equal((await post(runtime,`/api/handset/prompts/${target}/versions`,body,headers)).status,403)
 assert.equal((await post(runtime,'/auth/operator/status',{operatorId:personId,status:'inactive'},ownerHeaders)).status,200)
 assert.equal((await post(runtime,`/api/handset/prompts/${target}/versions`,body,headers)).status,401)
 await page.goto(runtime.origin+'/app/prompts');await page.waitForURL(/\/signin\?/);await proof('greeting-role-person-removed')
 await switchTo(cookie)
}
