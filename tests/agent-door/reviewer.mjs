import {remember} from './owner.mjs';
/** The signed Business roster sends a native invitation; consume its actual mail. */
export default async function ({request,origin,label,mail}) {
 const messages=await mail.read({limit:20});
 const message=messages.at(-1);
 const link=(message?.text??'').match(/https:\/\/[^\s<>]+\/auth\/confirm\?token=[A-Za-z0-9_-]+/);
 if(!link)throw new Error('Native invitation unavailable');
 const token=new URL(link[0]).searchParams.get('token');
 const response=await request(new URL('/auth/confirm',origin).href,{method:'POST',redirect:'manual',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token})});
 if(response.status!==303)throw new Error('Native invitation not confirmed');
 remember(label,response);
 return response;
}
