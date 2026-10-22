import { Fault } from '../core'
import type { ProfileKind, RowError } from './model'

export const userColumns=['email','name','extension','location','emergencyAddress','role','numberId','queues','hours','ringRules','keys','greeting']
export const deviceColumns=['mac','name','extension','location','emergencyAddress','userEmail','numberId','queues','hours','ringRules','keys','greeting']
export interface CsvRow { file:ProfileKind; row:number; values:Record<string,string> }

// RFC 4180 field quoting, including embedded commas, quotes and newlines.
export function csv(source:unknown,kind:ProfileKind):{rows:CsvRow[];errors:RowError[]} {
 if(source===undefined||source==='')return {rows:[],errors:[]}
 if(typeof source!=='string'||source.length>500000)throw new Fault('invalid_csv')
 const input=source.replace(/^\uFEFF/,''), grid:string[][]=[], lineNumbers:number[]=[]
 let row:string[]=[],field='',quoted=false,closed=false,line=1,start=1
 const finish=()=>{row.push(field);if(row.some(v=>v!=='')){grid.push(row);lineNumbers.push(start)}row=[];field='';closed=false;start=line+1}
 for(let i=0;i<input.length;i++){
  const ch=input[i]
  if(quoted){if(ch==='"'){if(input[i+1]==='"'){field+='"';i++}else{quoted=false;closed=true}}else{field+=ch;if(ch==='\n')line++}continue}
  if(ch==='"'){if(field||closed)throw new Fault('malformed_csv');quoted=true;continue}
  if(ch===','){row.push(field);field='';closed=false;continue}
  if(ch==='\r'||ch==='\n'){if(ch==='\r'&&input[i+1]==='\n')i++;finish();line++;continue}
  if(closed)throw new Fault('malformed_csv')
  field+=ch
 }
 if(quoted)throw new Fault('malformed_csv')
 if(field||row.length)finish()
 if(!grid.length)return {rows:[],errors:[]}
 if(grid.length>201)throw new Fault('csv_row_limit')
 const headers=grid.shift()!.map(v=>v.trim()),allowed=kind==='user'?userColumns:deviceColumns
 const errors:RowError[]=[],issue=(row:number,field:string,code:string)=>errors.push({file:kind,row,field,code})
 for(const h of headers)if(!allowed.includes(h))issue(1,h,'unknown_column')
 if(new Set(headers).size!==headers.length)issue(1,'header','duplicate_column')
 for(const h of kind==='user'?['email','name','extension','location','emergencyAddress']:['mac','name','extension','location','emergencyAddress'])if(!headers.includes(h))issue(1,h,'missing_column')
 return {rows:grid.map((cells,index)=>{const row=lineNumbers[index+1];if(cells.length!==headers.length)issue(row,'row','column_count');return {file:kind,row,values:Object.fromEntries(headers.map((h,i)=>[h,(cells[i]??'').trim()]))}}),errors}
}
