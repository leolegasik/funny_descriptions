import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createApp} from '../server.mjs';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
const close=s=>new Promise(r=>{s.closeAllConnections();s.close(r)});
test('AI photo selection, rejudge persistence, retry safety and private examples',async()=>{
 await mkdir('work',{recursive:true});const dir=await mkdtemp(path.resolve('work/features-'));
 let inputs=[],photos=0,fail=false,potentials=[20,75];
 const lm=http.createServer(async(req,res)=>{
  let raw='';for await(const x of req)raw+=x;const input=JSON.parse(raw);inputs.push(input);
  const selection=input.response_format.json_schema.name==='photo_potential';
  const revised=input.messages[1].content.at(-1)?.text?.includes('Пересмотри');
  const content=fail?'invalid':JSON.stringify(selection?{potential:potentials.shift()??30}:{scene:'Человек за столом',comment:'Смешно',explanation:'Контраст',techniques:['ирония'],relevance:20,surprise:20,humor:revised?30:10,delivery:10});
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content}}]}));
 });
 const endpoint=await listen(lm);
 await writeFile(path.join(dir,'state.json'),JSON.stringify({settings:{endpoint:endpoint+'/v1',model:'vision',photoProvider:'picsum',smartPhotos:true},history:[],memories:[]}));
 let app=await createApp({dataDir:dir,photoFetch:async()=>new Response(Buffer.from([255,216,++photos,217]),{headers:{'content-type':'image/jpeg'}})});
 let base=await listen(app);
 const api=async(route,body,headers={})=>{const r=await fetch(base+route,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{'Content-Type':'application/json',...headers}});return {status:r.status,data:await r.json()}};
 try{
  const round=(await api('/api/round',{})).data;assert.equal(photos,2);assert.equal(inputs.length,2);
  assert.equal(Buffer.from(await(await fetch(base+round.image)).arrayBuffer())[2],2);
  const first=(await api('/api/judge',{roundId:round.id,caption:'Опять созвон'})).data;assert.equal(first.score,60);
  assert.equal((await api('/api/rejudge',{roundId:round.id,comment:''})).status,400);
  const revised=(await api('/api/rejudge',{roundId:round.id,comment:'Это отсылка к моему офису'})).data;
  assert.equal(revised.id,first.id);assert.equal(revised.score,80);assert.equal(revised.previousScore,60);
  assert.match(inputs.at(-1).messages[1].content.at(-1).text,/моему офису/);
  let saved=(await api('/api/state')).data;assert.equal(saved.history.length,1);assert.equal(saved.memories[0].score,80);
  const before=inputs.length;await api('/api/rejudge',{roundId:round.id,comment:'Это отсылка к моему офису'});assert.equal(inputs.length,before);
  fail=true;assert.equal((await api('/api/rejudge',{roundId:round.id,comment:'Другое пояснение'})).status,502);
  saved=(await api('/api/state')).data;assert.equal(saved.history[0].score,80);assert.equal(saved.memories[0].feedbackComment,'Это отсылка к моему офису');
  const fallback=(await api('/api/round',{})).data;assert.match(fallback.source.selectionNote,/недоступен/);fail=false;
  await api('/api/judge',{roundId:fallback.id,caption:'Гость'},{'X-Podpis-Remote':'1'});assert.ok(!inputs.at(-1).messages[0].content.includes('моему офису'));
  const upload=(await api('/api/upload',{image:'data:image/jpeg;base64,/9j/2Q=='})).data;
  await api('/api/judge',{roundId:upload.id,caption:'Офис'});assert.match(inputs.at(-1).messages[0].content,/моему офису/);
  await close(app);app=await createApp({dataDir:dir});base=await listen(app);
  saved=(await api('/api/state')).data;assert.equal(saved.history[0].score,80);assert.equal(saved.memories[0].score,80);
  assert.equal((await api('/api/rejudge',{roundId:round.id,comment:'Старый кадр'})).status,410);
 }finally{await close(app);await close(lm);await rm(dir,{recursive:true,force:true})}
});
