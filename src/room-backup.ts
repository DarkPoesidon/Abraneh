export const ROOM_BACKUP_TABLES=['messages','message_keys','room_meta','sync_queue','message_details','message_reactions'];
const columns=(sql:SqlStorage,table:string)=>sql.exec(`PRAGMA table_info("${table}")`).toArray().map(row=>String(row.name));
export function roomBackupPage(sql:SqlStorage,table:string,offset:number) {
  if(!ROOM_BACKUP_TABLES.includes(table)||!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid room backup page');
  const names=columns(sql,table),rows=sql.exec(`SELECT * FROM "${table}" ORDER BY rowid LIMIT 32 OFFSET ?`,offset).toArray().filter(row=>table!=='room_meta'||!String(row.key).startsWith('call'));
  return {columns:names,rows:rows.map(row=>names.map(name=>row[name])),scanned:sql.exec(`SELECT count(*) AS n FROM (SELECT rowid FROM "${table}" ORDER BY rowid LIMIT 32 OFFSET ?)`,offset).toArray()[0].n,total:sql.exec(`SELECT count(*) AS n FROM "${table}"`).toArray()[0].n};
}
export function restoreRoomTable(ctx:DurableObjectState,body:any) {
  const {table,offset,rows}=body;
  if(!ROOM_BACKUP_TABLES.includes(table)||!Number.isSafeInteger(offset)||offset<0||!Array.isArray(rows)||rows.length>64)throw Error('Invalid restore page');
  const names=columns(ctx.storage.sql,table);
  if(JSON.stringify(names)!==JSON.stringify(body.columns)||rows.some((row:any)=>!Array.isArray(row)||row.length!==names.length||row.some((v:any)=>v!==null&&typeof v!=='string'&&typeof v!=='number')))throw Error('Invalid restore columns');
  ctx.storage.transactionSync(()=>{
    if(offset===0)ctx.storage.sql.exec(`DELETE FROM "${table}"`);
    const count=Number(ctx.storage.sql.exec(`SELECT count(*) AS n FROM "${table}"`).toArray()[0].n);
    if(count!==offset)throw Error('Restore offset differs');
    for(const row of rows)ctx.storage.sql.exec(`INSERT INTO "${table}" (${names.map(n=>'"'+n+'"').join(',')}) VALUES (${names.map(()=>'?').join(',')})`,...row);
  });
  return {count:Number(ctx.storage.sql.exec(`SELECT count(*) AS n FROM "${table}"`).toArray()[0].n)};
}
