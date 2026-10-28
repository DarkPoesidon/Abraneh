import { Env } from './types.js';

export async function listReceipts(env: Env, chatId: string) {
  const { results } = await env.DB.prepare(`SELECT cm.user_id AS userId, COALESCE(r.delivered_at,0) AS deliveredAt,
    COALESCE(r.delivered_id,'') AS deliveredId, COALESCE(r.read_at,0) AS readAt, COALESCE(r.read_id,'') AS readId
    FROM chat_members cm LEFT JOIN chat_receipts r ON r.chat_id = cm.chat_id AND r.user_id = cm.user_id WHERE cm.chat_id = ?`)
    .bind(chatId).all();
  return results;
}

export async function saveReceipt(env: Env, chatId: string, userId: string, messageId: string, read: boolean) {
  const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
  let message: { id: string; created_at: number } | null = null;
  try { message = await (await room.fetch('https://internal/message?id=' + encodeURIComponent(messageId))).json(); } catch { /* Use the global copy. */ }
  if (!message) message = await env.DB.prepare('SELECT id,created_at FROM messages WHERE chat_id = ? AND id = ?').bind(chatId, messageId).first();
  if (!message) return null;
  const time = message.created_at;
  await env.DB.prepare(`INSERT INTO chat_receipts (chat_id,user_id,delivered_at,delivered_id,read_at,read_id) VALUES (?,?,?,?,?,?)
    ON CONFLICT(chat_id,user_id) DO UPDATE SET
    delivered_id = CASE WHEN excluded.delivered_at > delivered_at OR (excluded.delivered_at = delivered_at AND excluded.delivered_id > delivered_id) THEN excluded.delivered_id ELSE delivered_id END,
    delivered_at = MAX(delivered_at,excluded.delivered_at),
    read_id = CASE WHEN excluded.read_at > read_at OR (excluded.read_at = read_at AND excluded.read_id > read_id) THEN excluded.read_id ELSE read_id END,
    read_at = MAX(read_at,excluded.read_at)`)
    .bind(chatId, userId, time, messageId, read ? time : 0, read ? messageId : '').run();
  const receipt = (await listReceipts(env, chatId)).find(row => row.userId === userId)!;
  try { await room.fetch('https://internal/receipts', { method: 'POST', body: JSON.stringify({ event: 'receipt', chatId, ...receipt }) }); }
  catch { /* Clients also poll the stored watermarks. */ }
  return receipt;
}
