import { spawn } from "node:child_process"
const child = spawn(process.argv[2], ["app-server"], { stdio: ["pipe","pipe","ignore"] })
let id=0; const pending=new Map()
const req=(m,p)=>new Promise((res,rej)=>{const i=++id;pending.set(i,{res,rej});child.stdin.write(JSON.stringify({id:i,method:m,params:p})+"\n");setTimeout(()=>rej(new Error(m+" timeout")),20000)})
let buf=""
child.stdout.on("data",c=>{buf+=c;let n;while((n=buf.indexOf("\n"))!==-1){const l=buf.slice(0,n).trim();buf=buf.slice(n+1);if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}
if(m.id!==undefined&&(m.result!==undefined||m.error!==undefined)){const w=pending.get(m.id);if(w){pending.delete(m.id);m.error?w.rej(new Error(JSON.stringify(m.error).slice(0,200))):w.res(m.result)}}}})
await req("initialize",{clientInfo:{name:"resume-test",title:"t",version:"0"},capabilities:{experimentalApi:true}})
const r = await req("thread/resume",{threadId: process.argv[3]})
console.log("RESUME OK", JSON.stringify(r).slice(0,150))
child.kill(); process.exit(0)
