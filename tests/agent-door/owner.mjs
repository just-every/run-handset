// Keep native reviewer admission available until the signed roster is installed.
let initialize;
const sessions=new Map();
export const remember=(label,response)=>sessions.set(label,{status:response.status,headers:new Headers(response.headers)});
export async function admitReviewer(label,owner){
 await initialize(label,owner);
 const saved=sessions.get(label);return new Response(null,saved);
}
export default async function ({request,origin,token,displayName,returnTo,reviewers}) {
 initialize=reviewers.initialize;
 const response=await request(new URL('/auth/bootstrap',origin).href,{method:'POST',redirect:'manual',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token,displayName,returnTo})});
 return response;
}
