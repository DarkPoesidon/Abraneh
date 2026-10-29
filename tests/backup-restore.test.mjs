import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Cloudflare } from '../installer/cloudflare.mjs';
import { APP_MARKER } from '../installer/deploy.mjs';
import { validateBackup, restoreBackup } from '../installer/backup.mjs';

const accountId='a'.repeat(32),name='restored-chat',version='1.4.2',cloudToken='cloud_test_token_'.repeat(3);
const roomColumns={messages:['id','chat_id','sender_id','text','created_at','client_msg_id'],message_keys:['sender_id','client_msg_id','message_id'],room_meta:['key','value'],sync_queue:['message_id','chat_id'],message_details:['message_id','reply_to','edited_at','deleted_at','revision'],message_reactions:['message_id','user_id','emoji']};
const manifest={tables:{messages:{columns:['id','chat_id','text'],dependencies:['chats']},chats:{columns:['id','creator_id'],dependencies:['users']},user_totp:{columns:['user_id','secret','last_step'],dependencies:['users']},session_policy:{columns:['user_id','legacy_disabled'],dependencies:['users']},users:{columns:['id','username'],dependencies:[]}},roomTables:Object.fromEntries(Object.entries(roomColumns).map(([name,columns])=>[name,{columns}]))};
function snapshot(){
  const tables=Object.fromEntries(Object.entries(manifest.tables).map(([name,{columns}])=>[name,{columns,rows:[]}])) ,room=Object.fromEntries(Object.entries(roomColumns).map(([name,columns])=>[name,{columns,rows:[]}]));
  tables.users.rows=[['alice','alice']];tables.chats.rows=[['room-1','alice']];tables.messages.rows=Array.from({length:40},(_,i)=>['message-'+i,'room-1',"Text '+DROP TABLE users; -- "+i]);tables.user_totp.rows=[['alice','encrypted-ciphertext',42]];
  room.messages.rows=[['room-only','room-1','alice','Durable-only history',123,'client-id']];room.message_keys.rows=[['alice','client-id','room-only']];room.room_meta.rows=[['dedupe-v1','done']];
  return {format:1,appVersion:version,tables,rooms:{'room-1':room},secrets:{JWT_SECRET:'backed-up-secret-'.repeat(4),TELEGRAM_KEY:'a'.repeat(64)}};
}
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'wihm-restore-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'release.json'),JSON.stringify({appVersion:version}));await writeFile(join(directory,'backup-schema.json'),JSON.stringify(manifest));return directory;
}
function mock(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL);
    CREATE TABLE chats(id TEXT PRIMARY KEY,creator_id TEXT REFERENCES users(id));
    CREATE TABLE messages(id TEXT PRIMARY KEY,chat_id TEXT REFERENCES chats(id),text TEXT);
    CREATE TABLE user_totp(user_id TEXT PRIMARY KEY REFERENCES users(id),secret TEXT,last_step INTEGER);
    CREATE TABLE session_policy(user_id TEXT PRIMARY KEY REFERENCES users(id),legacy_disabled INTEGER);
    CREATE TABLE service_restore(id INTEGER PRIMARY KEY,digest TEXT,state TEXT,created_at INTEGER);
    CREATE TABLE wihm_installation(id INTEGER PRIMARY KEY,app TEXT,worker_name TEXT);
    CREATE TABLE user_sessions(id TEXT);CREATE TABLE session_security(id TEXT);CREATE TABLE security_challenges(id TEXT);`);
  db.prepare('INSERT INTO wihm_installation VALUES (1,?,?)').run(APP_MARKER,name);
  const state={calls:[],queries:[],secrets:{},secretWrites:[],rooms:{},roomCalls:[],failQuery:false,failRoom:false,failFinish:false,unowned:false};
  const api=new Cloudflare(cloudToken,async(url,options)=>{
    const path=new URL(url).pathname.replace('/client/v4',''),body=options.body?JSON.parse(options.body):undefined;
    state.calls.push({path,method:options.method});let result;
    if(path.endsWith('/settings'))result={bindings:[{name:'WIHM_INSTALLER',text:state.unowned?'another-app':APP_MARKER},{name:'WIHM_VERSION',text:version},{name:'DB',type:'d1',id:'12345678-1234-1234-1234-123456789abc'},{name:'CHAT_ROOM',type:'durable_object_namespace',class_name:'ChatRoom'}]};
    else if(path.endsWith('/workers/subdomain'))result={subdomain:'test-account'};
    else if(path.endsWith('/query')){
      state.queries.push(body);assert.ok(body.params.length<=100);
      const rows=db.prepare(body.sql).all(...body.params);result=[{success:true,results:rows}];
      if(state.failQuery && body.sql.startsWith('INSERT INTO "messages"')){state.failQuery=false;throw Error('lost reply after successful D1 mutation');}
    }else if(path.endsWith('/secrets')){assert.equal(options.method,'PUT');state.secrets[body.name]=body.text;state.secretWrites.push({...body});result={};}
    else if(path.endsWith('/secrets/RESTORE_TOKEN')){assert.equal(options.method,'DELETE');delete state.secrets.RESTORE_TOKEN;result={};}
    else throw Error('Unexpected request: '+path);
    return Response.json({success:true,result});
  });
  const fetcher=async(url,options)=>{
    assert.equal(new URL(url).origin,'https://restored-chat.test-account.workers.dev');assert.equal(options.headers.Authorization,'Bearer '+state.secrets.RESTORE_TOKEN);assert.ok(!options.headers.Authorization.includes(cloudToken));assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body),marker=db.prepare('SELECT * FROM service_restore WHERE id=1').get();assert.equal(body.digest,marker.digest);assert.equal(marker.state,'importing');
    if(url.endsWith('/room')){
      state.roomCalls.push(body);const room=state.rooms[body.chatId] ||= {};
      if(body.offset===0)room[body.table]=[];assert.equal(room[body.table].length,body.offset);room[body.table].push(...body.rows);
      if(state.failRoom){state.failRoom=false;throw Error('lost reply after accepted room import');}
      return Response.json({ok:true});
    }
    assert.ok(url.endsWith('/finish'));
    for(const [table,count] of Object.entries(body.tables))assert.equal(db.prepare('SELECT count(*) AS n FROM "'+table+'"').get().n,count);
    for(const room of body.rooms)for(const [table,count] of Object.entries(room.counts))assert.equal(state.rooms[room.chatId][table].length,count);
    db.exec('DELETE FROM user_sessions;DELETE FROM session_security;DELETE FROM security_challenges;');
    db.exec('INSERT OR REPLACE INTO session_policy SELECT id,1 FROM users;');
    db.prepare("UPDATE service_restore SET state='complete' WHERE id=1").run();
    if(state.failFinish){state.failFinish=false;throw Error('lost reply after successful completion');}
    return Response.json({ok:true});
  };
  return {db,state,api,fetcher};
}
test('whole backup validates before cloud writes, including exact trusted manifest, rooms, version and secrets',async t=>{
  const payloadDir=await fixture(t),backup=snapshot(),plan=await validateBackup(backup,payloadDir);assert.equal(plan.roomCount,1);assert.equal(plan.tables.messages,40);assert.ok(!JSON.stringify(plan).includes(backup.secrets.JWT_SECRET));
  const changes=[value=>value.format=2,value=>value.appVersion='99.0.0',value=>value.tables['users; DROP TABLE chats']=value.tables.users,value=>value.tables.users.columns[0]='id);DELETE FROM users;--',value=>value.tables.users.rows[0][0]={object:true},value=>delete value.rooms['room-1'],value=>value.secrets.CF_TOKEN=cloudToken,value=>value.secrets.JWT_SECRET='short',value=>value.rooms['room-1'].room_meta.rows.push(['call-v1','stale call']),value=>delete value.tables.messages];
  for(const change of changes){const value=structuredClone(backup);change(value);let calls=0;await assert.rejects(restoreBackup({api:{request(){calls++;throw Error('must not contact Cloudflare');}},accountId,name,backup:value,payloadDir}));assert.equal(calls,0);}
  const bad=structuredClone(manifest);bad.tables.users.dependencies=['messages'];await writeFile(join(payloadDir,'backup-schema.json'),JSON.stringify(bad));await assert.rejects(validateBackup(backup,payloadDir),/وابستگی/);
});
test('restore imports bound rows in FK order, includes Durable-only history and exact secrets, verifies counts, then removes restore token',async t=>{
  const payloadDir=await fixture(t),backup=snapshot(),{api,state,db,fetcher}=mock(t),phases=[];
  const result=await restoreBackup({api,accountId,name,backup,payloadDir,fetcher,progress:value=>phases.push(value)});
  assert.equal(result.restored,true);assert.equal(result.verified,true);assert.equal(result.version,version);assert.ok(!JSON.stringify(result).includes(backup.secrets.JWT_SECRET));
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n,40);assert.equal(db.prepare('SELECT text FROM messages WHERE id=?').get('message-0').text,backup.tables.messages.rows[0][2]);
  assert.deepEqual(state.rooms['room-1'].messages,backup.rooms['room-1'].messages.rows);assert.equal(state.secrets.JWT_SECRET,backup.secrets.JWT_SECRET);assert.equal(state.secrets.TELEGRAM_KEY,backup.secrets.TELEGRAM_KEY);assert.ok(!state.secrets.RESTORE_TOKEN);assert.equal(state.secrets.CF_TOKEN,undefined);
  assert.equal(db.prepare('SELECT legacy_disabled FROM session_policy WHERE user_id=?').get('alice').legacy_disabled,1);assert.equal(db.prepare('SELECT state FROM service_restore').get().state,'complete');
  assert.deepEqual(phases,['restore-secrets','restore-database','restore-rooms','restore-verify']);
  const insertOrder=state.queries.filter(row=>row.sql.startsWith('INSERT INTO')).map(row=>row.sql.match(/INSERT INTO "(\w+)"/)[1]);assert.ok(insertOrder.indexOf('users')<insertOrder.indexOf('chats'));assert.ok(insertOrder.indexOf('chats')<insertOrder.indexOf('messages'));assert.ok(insertOrder.filter(table=>table==='messages').length>1);
  assert.ok(state.queries.filter(row=>/^(DELETE|INSERT INTO)/.test(row.sql)).every(row=>row.sql.includes("state='importing'")));
});
test('an unrelated Worker, existing user data, or a different partial restore is never replaced',async t=>{
  const payloadDir=await fixture(t),backup=snapshot(),{api,state,db,fetcher}=mock(t);state.unowned=true;
  await assert.rejects(restoreBackup({api,accountId,name,backup,payloadDir,fetcher}),/مقصد/);assert.equal(state.secretWrites.length,0);
  state.unowned=false;db.prepare('INSERT INTO users VALUES (?,?)').run('existing','existing');
  await assert.rejects(restoreBackup({api,accountId,name,backup,payloadDir,fetcher}),/خالی/);assert.equal(state.secretWrites.length,0);assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM service_restore').get().n,0);
  db.prepare("INSERT INTO service_restore VALUES (1,?,'importing',1)").run('different-digest');
  await assert.rejects(restoreBackup({api,accountId,name,backup,payloadDir,fetcher}),/دیگری/);assert.equal(state.secretWrites.length,0);assert.equal(db.prepare('SELECT id FROM users').get().id,'existing');
});
test('interrupted D1 and room imports restart safely with the same digest and stable in-memory token',async t=>{
  for(const fault of ['failQuery','failRoom']){
    await t.test(fault,async t=>{
      const payloadDir=await fixture(t),backup=snapshot(),{api,state,db,fetcher}=mock(t);state[fault]=true;
      await assert.rejects(restoreBackup({api,accountId,name,backup,payloadDir,fetcher}));assert.equal(db.prepare('SELECT state FROM service_restore').get().state,'importing');assert.ok(state.secrets.RESTORE_TOKEN);
      const result=await restoreBackup({api,accountId,name,backup,payloadDir,fetcher});assert.equal(result.restored,true);assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n,40);assert.equal(state.rooms['room-1'].messages.length,1);
      const values=state.secretWrites.filter(row=>row.name==='RESTORE_TOKEN').map(row=>row.text);assert.equal(new Set(values).size,1);
    });
  }
});
test('a lost completion response is retried without resetting completed data or reviving restore access',async t=>{
  const payloadDir=await fixture(t),backup=snapshot(),{api,state,db,fetcher}=mock(t);state.failFinish=true;
  await assert.rejects(restoreBackup({api,accountId,name,backup,payloadDir,fetcher}));assert.equal(db.prepare('SELECT state FROM service_restore').get().state,'complete');
  db.prepare('INSERT INTO messages VALUES (?,?,?)').run('new-data','room-1','Created after completed restore');
  const deletes=state.queries.filter(row=>row.sql.startsWith('DELETE')).length,uploads=state.roomCalls.length;
  assert.equal((await restoreBackup({api,accountId,name,backup,payloadDir,fetcher})).restored,true);assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n,41);assert.equal(state.queries.filter(row=>row.sql.startsWith('DELETE')).length,deletes);assert.equal(state.roomCalls.length,uploads);assert.ok(!state.secrets.RESTORE_TOKEN);
});
