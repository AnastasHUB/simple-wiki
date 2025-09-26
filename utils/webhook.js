import fetch from 'node-fetch';
import { get } from '../db.js';

async function send(url, payload){
  if(!url) return;
  try{
    await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
  }catch{}
}
export async function sendAdminEvent(title, data){
  const s = await get('SELECT admin_webhook_url FROM settings WHERE id=1');
  await send(s?.admin_webhook_url, { embeds:[{ title, timestamp: new Date().toISOString(), color: 0x5865F2, fields: Object.entries(data||{}).map(([k,v])=>({ name:k, value:'```json\n'+JSON.stringify(v,null,2)+'\n```' })) }] });
}
export async function sendFeedEvent(title, data){
  const s = await get('SELECT feed_webhook_url FROM settings WHERE id=1');
  await send(s?.feed_webhook_url, { embeds:[{ title, timestamp: new Date().toISOString(), color: 0x57F287, description: (data && data.page && data.page.title) ? `**${data.page.title}**` : '', fields: data? Object.entries(data).map(([k,v])=>({ name:k, value: typeof v==='string'? v : '```json\n'+JSON.stringify(v,null,2)+'\n```'})) : [] }] });
}
