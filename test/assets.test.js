import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Etchv, EtchvError } from '../src/index.js';
const record=JSON.parse(readFileSync(new URL('assets.json',import.meta.url)));
test('asset requests preserve filters, versions, downloads and deletion semantics',async()=>{
 const calls=[];
 const client=new Etchv({apiKey:'test-key',fetch:async(url,init)=>{
  assert.equal(init.headers['X-API-Key'],'test-key'); assert.equal(init.redirect,'manual'); calls.push({url,init});
  if(url.searchParams.has('cursor'))return Response.json({detail:'changed'},{status:409});
  if(init.method==='PATCH'){assert.deepEqual(JSON.parse(init.body),{version:1,name:'renamed'});return Response.json({...record,name:'renamed',version:2});}
  if(init.method==='DELETE')return new Response(null,{status:204});
  if(init.method==='POST'){assert.deepEqual(JSON.parse(init.body),{asset_ids:[record.id]});return new Response(null,{status:204});}
  if(url.pathname.endsWith('/content'))return new Response('file');
  return Response.json(url.pathname==='/assets'?{items:[record],next_cursor:'next-page'}:record);
 }});
 assert.equal((await client.listAssets({kind:'watermarked'})).next_cursor,'next-page');
 assert.equal(calls[0].url.searchParams.get('kind'),'watermarked');
 assert.equal((await client.getAsset(record.id)).metadata.campaign,'launch');
 assert.equal((await client.updateAsset(record.id,{version:1,name:'renamed'})).version,2);
 assert.equal(new TextDecoder().decode(await client.downloadAsset(record.id)),'file');
 await client.deleteAsset(record.id);await client.deleteAssets([record.id]);
 await assert.rejects(client.listAssets({cursor:'next-page'}),e=>e instanceof EtchvError&&e.statusCode===409);
 const before=calls.length; await assert.rejects(client.getAsset('../other')); assert.equal(calls.length,before);
});
