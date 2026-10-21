import { headers } from '../core'
export const xml=(body:string,reason?:string)=>new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,{headers:{...headers,'content-type':'application/xml; charset=utf-8',...(reason?{'x-handset-protection-reason':reason}:{})}})
