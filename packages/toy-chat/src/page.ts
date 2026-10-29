// The whole toy-chat UI: one page, no build step. Text is rendered with textContent only (no HTML injection).
export const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Toy Chat</title><style>
:root{--bg:#fafaf9;--fg:#1c1917;--mute:#78716c;--line:#e7e5e4;--acc:#1f3a5f;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--mute:#a8a29e;--line:#44403c;--acc:#93b4dd;--card:#292524}}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg);display:grid;grid-template-columns:240px 1fr;height:100vh}
aside{border-right:1px solid var(--line);padding:12px;overflow:auto}main{display:flex;flex-direction:column;min-width:0}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:4px 10px;cursor:pointer}
input{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:6px 8px;width:100%}
.ch{padding:6px 8px;border-radius:6px;cursor:pointer}.ch.on{background:var(--acc);color:var(--bg)}
#log{flex:1;overflow:auto;padding:12px 16px}.m{padding:6px 0;border-bottom:1px solid var(--line)}.m .who{font-weight:600}.m .org{color:var(--mute);font-size:12px}
.m .t{white-space:pre-wrap;word-break:break-word}.reply{margin-left:24px;border-left:2px solid var(--line);padding-left:8px}.sys{color:var(--mute);font-style:italic}
.acts button{font-size:12px;padding:1px 6px;margin-right:4px}.rx{font-size:13px;margin-right:6px}form{display:flex;gap:8px;padding:12px;border-top:1px solid var(--line)}
small{color:var(--mute)}@media (max-width:640px){body{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line)}}
</style></head><body>
<aside><div><b>Toy Chat</b> <small id="org"></small></div>
<p><input id="me" placeholder="your name"></p>
<div id="chans"></div>
<p><button id="share">Share a new channel</button></p><p><input id="inv" placeholder="paste invite"><button id="acc" style="margin-top:6px">Accept invite</button></p>
<p><small id="note"></small></p></aside>
<main><div id="log"></div><form id="f"><input id="txt" placeholder="message (Markdown ok)" autocomplete="off"><button>Send</button></form></main>
<script>
const $=s=>document.querySelector(s);let S={channels:[]},cur=null,replyTo=null;
const uid=()=>me().toLowerCase().replace(/[^a-z0-9._-]/g,'')||'guest';const me=()=>{const n=$('#me').value.trim()||'guest';localStorage.setItem('me',n);return n};$('#me').value=localStorage.getItem('me')||'';
const api=(p,b)=>fetch('/api/'+p,{method:b?'POST':'GET',headers:{'content-type':'application/json'},body:b&&JSON.stringify(b)}).then(r=>r.json());
async function load(){S=await api('state');$('#org').textContent=S.org;if(!cur&&S.channels[0])cur=S.channels[0].id;draw()}
function el(t,c,txt){const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e}
function draw(){const cs=$('#chans');cs.replaceChildren(...S.channels.map(c=>{const d=el('div','ch'+(c.id===cur?' on':''),'# '+c.name+(c.state!=='open'?' ('+c.state+')':''));d.onclick=()=>{cur=c.id;draw()};return d}));
const c=S.channels.find(x=>x.id===cur);const log=$('#log');log.replaceChildren();if(!c)return;
const msgs=new Map,order=[];for(const e of c.events){const b=e.body||{};
 if(e.type==='message.create'){msgs.set(e.id,{e,text:b.text,rx:new Map,del:false});order.push(e.id)}
 else if(e.type==='message.edit'&&msgs.has(b.target))msgs.get(b.target).text=b.text+' (edited)';
 else if(e.type==='message.delete'&&msgs.has(b.target))msgs.get(b.target).del=true;
 else if(e.type.startsWith('reaction.')&&msgs.has(b.target)){const m=msgs.get(b.target),s=m.rx.get(b.emoji)||new Set;e.type==='reaction.add'?s.add(e.sender.id):s.delete(e.sender.id);m.rx.set(b.emoji,s)}
 else if(e.type.startsWith('peer.')||e.type.startsWith('channel.')){const x={e,sys:true};msgs.set(e.id,x);order.push(e.id)}}
const roots=order.filter(id=>!(msgs.get(id).e.body||{}).thread);
const kids=id=>order.filter(k=>(msgs.get(k).e.body||{}).thread===id);
for(const id of roots){row(msgs.get(id),log,false);for(const k of kids(id))row(msgs.get(k),log,true)}log.scrollTop=log.scrollHeight;
$('#txt').placeholder=replyTo?'reply in thread…  (Esc to cancel)':'message (Markdown ok)'}
function row(m,log,isReply){const e=m.e,d=el('div','m'+(isReply?' reply':''));
 if(m.sys){d.append(el('div','sys',e.type==='peer.join'?e.body.org+' joined':e.type==='peer.leave'?e.body.org+' left ('+e.body.reason+')':e.type));log.append(d);return}
 const h=el('div');h.append(el('span','who',e.sender.name),' ',el('span','org',e.origin));d.append(h);
 d.append(el('div','t',m.del?'(deleted)':m.text));const a=el('div','acts');
 for(const [k,s] of m.rx)if(s.size)a.append(el('span','rx',k+' '+s.size));
 if(!m.del){const mine=e.sender.id===uid()+'@'+S.org;
  const b=(t,f)=>{const x=el('button',null,t);x.onclick=f;a.append(x)};
  if(!isReply)b('reply',()=>{replyTo=e.id;draw();$('#txt').focus()});
  b('👀',()=>send('reaction.add',{target:e.id,emoji:'👀',name:'eyes'}));b('🎉',()=>send('reaction.add',{target:e.id,emoji:'🎉',name:'tada'}));
  if(mine){b('edit',()=>{const t=prompt('Edit',m.text.replace(/ \\(edited\\)$/,''));if(t)send('message.edit',{target:e.id,text:t})});b('delete',()=>send('message.delete',{target:e.id}))}}
 d.append(a);log.append(d)}
async function send(type,body){const r=await api('send',{channel:cur,type,body,user:uid(),name:me()});if(r.error)$('#note').textContent=r.error}
$('#f').onsubmit=async ev=>{ev.preventDefault();const t=$('#txt').value.trim();if(!t||!cur)return;$('#txt').value='';await send('message.create',replyTo?{text:t,thread:replyTo}:{text:t});replyTo=null;draw()};
$('#txt').onkeydown=e=>{if(e.key==='Escape'){replyTo=null;draw()}};
$('#share').onclick=async()=>{const n=prompt('Channel name','shared');if(!n)return;const r=await api('share',{name:n});cur=r.channel;$('#note').textContent='Invite: '+r.invite;await load()};
$('#acc').onclick=async()=>{const r=await api('accept',{invite:$('#inv').value.trim()});if(r.error)$('#note').textContent=r.error;else{cur=r.channel;$('#inv').value='';await load()}};
new EventSource('/api/stream').onmessage=()=>load();load();
</script></body></html>`;
