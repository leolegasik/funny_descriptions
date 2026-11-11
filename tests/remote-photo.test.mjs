import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { createRemoteGateway } from '../remote-gateway.mjs';
function req(port, route, {cookie, body, headers={}}={}) {
 return new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port,path:route,method:body?'POST':'GET',headers:{Host:'test.ru.tuna.am',...(cookie?{Cookie:cookie}:{}),...(body?{Origin:'https://test.ru.tuna.am','Content-Type':'application/json'}:{}),...headers}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));});r.on('error',reject);r.end(body?JSON.stringify(body):undefined);});
}
test('Tuna: simultaneous phones load bytes, reopening from a messenger and lost-cookie login work',async()=>{
 await mkdir('work',{recursive:true});const dataDir=await mkdtemp(path.resolve('work/remote-photo-'));
 await writeFile(path.join(dataDir,'state.json'),JSON.stringify({settings:{photoProvider:'picsum'},history:[]}));
 const bytes=Buffer.alloc(1024*1024,75);let downloads=0;
 const app=await createApp({dataDir,photoFetch:async()=>{downloads++;await new Promise(r=>setTimeout(r,50));return new Response(bytes,{headers:{'content-type':'image/jpeg'}});}});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));
 const gateway=await createRemoteGateway({appPort:app.address().port});
 try {
  const link=gateway.setOrigin('https://test.ru.tuna.am'), key=new URL(link).hash.slice(8);
  const login=await req(gateway.port,'/__access',{body:{key}});assert.equal(login.status,200);
  const cookie=login.headers['set-cookie'][0].split(';')[0];
  const entry=await req(gateway.port,'/',{cookie,headers:{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate'}});assert.equal(entry.status,200);assert.match(entry.bytes.toString(),/caption-form/);
  assert.equal((await req(gateway.port,'/api/state',{cookie,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  const rounds=await Promise.all([req(gateway.port,'/api/round',{cookie,body:{}}),req(gateway.port,'/api/round',{cookie,body:{}})]);
  assert.equal(downloads,1);const results=rounds.map(r=>{assert.equal(r.status,200);return JSON.parse(r.bytes);});assert.notEqual(results[0].id,results[1].id);
  for(const round of results){const image=await req(gateway.port,round.image,{cookie});assert.equal(image.status,200);assert.equal(image.headers['content-type'],'image/jpeg');assert.deepEqual(image.bytes,bytes);assert.equal((await req(gateway.port,round.image)).status,401);}
  const another = await req(gateway.port,'/__access',{body:{key}});
  assert.equal(another.status,200);
  const anotherCookie=another.headers['set-cookie'][0].split(';')[0];
  assert.equal((await req(gateway.port,results[0].image,{cookie:anotherCookie})).status,403);
  assert.equal((await req(gateway.port,'/api/judge',{cookie:anotherCookie,body:{roundId:results[0].id,caption:'test'}})).status,403);

  const created=await req(gateway.port,'/api/rooms/create',{cookie,body:{}});assert.equal(created.status,200);
  const room=JSON.parse(created.bytes).room;
  const joined=await req(gateway.port,'/api/rooms/join',{body:{room,name:'Guest'}});assert.equal(joined.status,200);
  const player=JSON.parse(joined.bytes).player;
  assert.equal((await req(gateway.port,'/group')).status,200);
  assert.equal((await req(gateway.port,'/api/rooms/create',{body:{},cookie:'fake=spoof'})).status,400);
  assert.equal((await req(gateway.port,'/api/rooms/create',{body:{room,player}})).status,200);
  assert.equal((await req(gateway.port,'/api/state')).status,401);
  assert.equal((await req(gateway.port,'/api/rooms/rejudge',{body:{room,player}})).status,401);
  const script=(await req(gateway.port,'/__entry.js')).bytes.toString();assert.ok(!script.includes('replaceState'));assert.ok(!script.includes("location.replace('/')"));
  assert.equal(gateway.link(),link);
 }finally{await gateway.close();app.closeAllConnections();await new Promise(r=>app.close(r));await rm(dataDir,{recursive:true,force:true});}
});
