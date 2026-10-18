// Regression coverage for bounded evidence, cancellation and streaming advisory checks.
import { test } from 'node:test';
process.env.DSH_ANSWER_GATE ??= "block"; // v32: default off; tests opt in
import assert from 'node:assert/strict';
import { collectAnswerEvidence, createAnswerGateState, checkAnswer, guardAnswerStream } from '../lib/answergate.js';
import { runJudge, parseJudgeOutput } from '../lib/judge.js';
const tool=(id,text)=>({role:'tool',toolCallId:id,content:[{type:'text',text}]});
const assemble=chunks=>chunks.filter(c=>c.type==='block-end').map(c=>c.block);
const collect=async stream=>{const a=[]; for await(const c of stream)a.push(c); return a;};
const bounded=(promise)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('operation did not settle')),200))]);

test('evidence does not retain full tool output or invent a truncated number',()=>{
  const e=collectAnswerEvidence([tool('large','123456789012345')],{maxChars:4,maxResultChars:4});
  assert.equal(e.outputs[0].text,undefined);
  assert.equal(e.outputs[0].numbers.has('1234'),false);
  assert.equal(e.incomplete,true);
  assert.equal(checkAnswer('999 items',e).issues.every(i=>i.severity==='warn'),true);
});
test('limited history cannot turn missing evidence into hard blocking',()=>{
  const e=collectAnswerEvidence([tool('old','999'),tool('new','1')],{maxResults:1});
  assert.equal(e.incomplete,true);
  assert.equal(checkAnswer('999 items',e).issues[0].severity,'warn');
});
test('numeric session budget evicts old evidence and lifecycle drop releases state',()=>{
  const state=createAnswerGateState({maxNumbers:2});
  state('s',[tool('a','1 2')]);
  const e=state('s',[tool('b','3 4')]).evidence;
  assert.equal(e.outputs.length,1);
  assert.equal(e.outputs[0].id,'b');
  assert.equal(e.incomplete,true);
  assert.equal(state.size(),1); state.drop('s'); assert.equal(state.size(),0);
});
test('answer instructions are injected once per session/mode and reset on disposal',()=>{
  const state=createAnswerGateState({maxSessions:2});
  assert.equal(state.remind('a','block'),true);
  assert.equal(state.remind('a','block'),false);
  assert.equal(state.remind('a','warn'),true);
  state.drop('a'); assert.equal(state.remind('a','block'),true);
  state.remind('b','block');state.remind('c','block'); assert.equal(state.size(),2);
});
test('changed result with same id invalidates cached numeric evidence',()=>{
  const state=createAnswerGateState(); state('s',[tool('a','111')]);
  const e=state('s',[tool('a','222')]).evidence;
  assert.equal(e.outputs[0].numbers.has('222'),true);
  assert.equal(e.outputs[0].numbers.has('111'),false);
});
test('warn publishes the first chunk without waiting for completion',async()=>{
  let resume; const pause=new Promise(r=>{resume=r;});
  async function* source(){yield {type:'text-delta',index:0,text:'999 items'}; await pause; yield {type:'block-end',index:0,block:{type:'text',text:'999 items'}};yield {type:'finish',reason:{kind:'stop'}};}
  const it=guardAnswerStream(source(),{mode:'warn',assemble});
  const first=await bounded(it.next()); assert.equal(first.value.type,'text-delta');
  resume(); const out=await collect(it); assert.match(JSON.stringify(out),/number|出处/);
});
test('warn audits live deltas even when final text differs',async()=>{
  async function* source(){yield {type:'text-delta',index:0,text:'999 items'}; yield {type:'block-end',index:0,block:{type:'text',text:'ok'}}; yield {type:'finish',reason:{kind:'stop'}};}
  const out=await collect(guardAnswerStream(source(),{mode:'warn',assemble}));
  assert.match(JSON.stringify(out),/数字无出处/);
});
for(const mode of ['block','warn']) test(`abort interrupts a never-resolving upstream (${mode})`,async()=>{
  const controller=new AbortController();
  const stream={ [Symbol.asyncIterator](){return {next:()=>new Promise(()=>{}),return:()=>Promise.resolve({done:true})};}};
  const pending=collect(guardAnswerStream(stream,{assemble,signal:controller.signal,mode}));
  setTimeout(()=>controller.abort(Error('user cancelled')),5);
  await assert.rejects(bounded(pending),/user cancelled/);
});
test('judge external cancellation does not wait for an unresponsive adapter',async()=>{
  const controller=new AbortController();
  const llm={stream(){return {[Symbol.asyncIterator](){return {next:()=>new Promise(()=>{})};}};}};
  const pending=runJudge({llm,route:{provider:'test',model:'test'},signal:controller.signal,timeoutMs:60000});
  setTimeout(()=>controller.abort(Error('user cancelled')),5);
  await assert.rejects(bounded(pending),/user cancelled/);
});
test('already cancelled judge does not start another model call',async()=>{
  const controller=new AbortController();controller.abort(Error('already cancelled'));let called=false;
  await assert.rejects(runJudge({llm:{stream(){called=true;}},route:{},signal:controller.signal}),/already cancelled/);
  assert.equal(called,false);
});
test('judge supports promised streams and rejects nonempty malformed selections',async()=>{
  async function* stream(){yield {type:'text-delta',text:'{"skills":[]}'};}
  const r=await runJudge({llm:{stream:()=>Promise.resolve(stream())},route:{}});
  assert.equal(r.text,'{"skills":[]}');
  for(const skills of [[{}],[null],[12],[{name:''}]])assert.equal(parseJudgeOutput(JSON.stringify({skills}),new Map()).ok,false);
  assert.equal(parseJudgeOutput('{"skills":[]}',new Map()).decision,'none');
});
