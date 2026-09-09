const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const rooms = new Map();
const champRooms = new Map();
let questions = [];
try { questions = JSON.parse(fs.readFileSync(path.join(ROOT,'questions.json'),'utf8')); } catch(e) { questions=[]; }

function code(){ return crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase(); }
function makeCode(map){ let c; do { c=code(); } while(map.has(c)); return c; }
function pickQuestions(n){
  const a=[...questions];
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  return a.slice(0,n);
}
function json(res,status,obj){
  const body=JSON.stringify(obj);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});res.end(body);
}
function readBody(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>s+=c);req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch(e){reject(e)}});req.on('error',reject)})}
function publicPlayers(room){return [...room.players.values()].map(p=>({id:p.id,name:p.name,score:p.score||0,ready:!!p.ready}));}
function broadcast(room,msg){const raw=JSON.stringify(msg);for(const p of room.players.values()){if(p.ws&&p.ws.readyState===WebSocket.OPEN)p.ws.send(raw)}}
function roomState(room){broadcast(room,{type:'room_state',code:room.code,name:room.name,players:publicPlayers(room)})}
function send(p,msg){if(p?.ws?.readyState===WebSocket.OPEN)p.ws.send(JSON.stringify(msg))}

const server=http.createServer(async (req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host}`);
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});return res.end();}
  if(u.pathname==='/health'){return json(res,200,{ok:true,service:'BRASIL QUIZ BIBLICO',questions:questions.length})}
  if(u.pathname==='/questions.json'){return json(res,200,questions)}
  if(req.method==='POST' && u.pathname==='/api/rooms/create'){
    try{
      const b=await readBody(req); const c=makeCode(rooms);
      const room={code:c,name:String(b.name||'Sala Bíblica').slice(0,50),maxPlayers:2,players:new Map(),questionIndex:0,questions:pickQuestions(5),answers:new Map(),started:false};
      rooms.set(c,room); return json(res,200,{code:c});
    }catch(e){return json(res,400,{error:'Dados inválidos.'})}
  }
  if(req.method==='POST' && u.pathname==='/api/championship/rooms/create'){
    try{
      const b=await readBody(req); const c=makeCode(champRooms); const mode=['individual','team1','team2','team4'].includes(b.mode)?b.mode:'individual';
      const maxPlayers=mode==='individual'?10:mode==='team4'?8:mode==='team2'?4:2;
      champRooms.set(c,{code:c,mode,maxPlayers,players:new Map(),questions:pickQuestions(30),index:0,ready:false,answers:new Map(),scores:new Map()});
      return json(res,200,{code:c});
    }catch(e){return json(res,400,{error:'Dados inválidos.'})}
  }
  if(req.method==='POST' && (u.pathname==='/api/pix/create'||u.pathname==='/api/store/create')){
    return json(res,501,{error:'Pagamento ainda não configurado no servidor. Primeiro publique o jogo; depois configuramos o Pix/Mercado Pago.'});
  }
  if(req.method==='GET' && (u.pathname.startsWith('/api/pix/status/')||u.pathname.startsWith('/api/store/status/'))){return json(res,200,{status:'pending',approved:false});}

  // Static files for the browser.
  let filePath = u.pathname==='/' ? path.join(ROOT,'index_atualizado.html') : path.join(ROOT,u.pathname.replace(/^\/+/,''));
  filePath=path.normalize(filePath);
  if(!filePath.startsWith(ROOT))return json(res,403,{error:'Forbidden'});
  fs.stat(filePath,(err,st)=>{
    if(err||!st.isFile())return json(res,404,{error:'Not Found'});
    const ext=path.extname(filePath).toLowerCase();
    const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-cache':'public, max-age=3600'});fs.createReadStream(filePath).pipe(res);
  });
});

const wss=new WebSocket.Server({server,path:'/ws'});
wss.on('connection',(ws,req)=>{
  const u=new URL(req.url,'http://localhost'); const c=(u.searchParams.get('code')||'').toUpperCase();
  const pid=u.searchParams.get('playerId')||crypto.randomUUID(); const name=(u.searchParams.get('name')||'Jogador').slice(0,30);
  const room=rooms.get(c);
  if(!room){ws.send(JSON.stringify({type:'room_error',message:'Sala não encontrada ou expirada.'}));return ws.close();}
  if(room.players.size>=room.maxPlayers && !room.players.has(pid)){ws.send(JSON.stringify({type:'room_error',message:'A sala já está cheia.'}));return ws.close();}
  let p=room.players.get(pid); if(!p){p={id:pid,name,ws,score:0,ready:false};room.players.set(pid,p)} else {p.ws=ws;p.name=name;}
  ws.room=room;ws.player=p; roomState(room);
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw.toString())}catch(e){return}
    if(m.type==='rtc_signal'){
      for(const other of room.players.values())if(other.id!==p.id)send(other,{type:'rtc_signal',data:m.data});
      return;
    }
    if(m.type==='ready'){
      p.ready=true;roomState(room);
      if(room.players.size===2 && [...room.players.values()].every(x=>x.ready)){
        room.started=true;room.questionIndex=0;room.answers.clear();room.questions=pickQuestions(5);
        for(const x of room.players.values()){x.score=0;x.ready=false;}
        broadcast(room,{type:'battle_start',questions:room.questions});roomState(room);
      }
      return;
    }
    if(m.type==='answer' && room.started){
      if(room.answers.has(p.id))return;
      const idx=Number(m.index); const q=room.questions[room.questionIndex]; if(!q)return;
      const correct=idx===Number(q[2]); if(correct)p.score+=10; room.answers.set(p.id,{selectedIndex:idx,correct});
      const scores={};for(const x of room.players.values())scores[x.id]=x.score;
      send(p,{type:'answer_result',correct,correctIndex:Number(q[2]),selectedIndex:idx,scores,allAnswered:room.answers.size===room.players.size});
      if(room.answers.size===room.players.size){
        setTimeout(()=>{
          room.questionIndex++;
          if(room.questionIndex>=room.questions.length){
            const vals=[...room.players.values()]; let winner=null;
            if(vals.length===2)winner=vals[0].score===vals[1].score?null:(vals[0].score>vals[1].score?vals[0].id:vals[1].id);
            const scores={};for(const x of vals)scores[x.id]=x.score;
            broadcast(room,{type:'battle_end',winner,scores});room.started=false;room.answers.clear();roomState(room);
          }else{room.answers.clear();broadcast(room,{type:'next_question',index:room.questionIndex});}
        },700);
      }
      return;
    }
  });
  ws.on('close',()=>{if(room.players.get(p.id)?.ws===ws){p.ws=null;p.ready=false;roomState(room)}});
});

// Championship WebSocket uses the same server endpoint but a /champ/<code> path.
const champWss=new WebSocket.Server({noServer:true});
server.on('upgrade',(req,socket,head)=>{
  const u=new URL(req.url,'http://localhost'); if(u.pathname!=='/champ-ws')return;
  champWss.handleUpgrade(req,socket,head,ws=>champWss.emit('connection',ws,req));
});
champWss.on('connection',(ws,req)=>{
  const u=new URL(req.url,'http://localhost'); const c=(u.searchParams.get('code')||'').toUpperCase(); const pid=u.searchParams.get('playerId')||crypto.randomUUID(); const name=(u.searchParams.get('name')||'Jogador').slice(0,30);
  const room=champRooms.get(c); if(!room){ws.send(JSON.stringify({type:'champ_error',message:'Sala de campeonato não encontrada.'}));return ws.close();}
  if(room.players.size>=room.maxPlayers && !room.players.has(pid)){ws.send(JSON.stringify({type:'champ_error',message:'Sala cheia.'}));return ws.close();}
  let p=room.players.get(pid);if(!p){p={id:pid,name,ws,ready:false,score:0};room.players.set(pid,p)}else{p.ws=ws;p.name=name}
  const state=()=>({type:'champ_state',code:room.code,mode:room.mode,title:room.mode==='individual'?'CAMPEONATO INDIVIDUAL':'CAMPEONATO',maxPlayers:room.maxPlayers,players:[...room.players.values()].map(x=>({id:x.id,name:x.name,host:[...room.players.keys()][0]===x.id,ready:x.ready}))});
  const bc=m=>{const raw=JSON.stringify(m);for(const x of room.players.values())if(x.ws?.readyState===WebSocket.OPEN)x.ws.send(raw)};
  ws.send(JSON.stringify(state()));bc(state());
  ws.on('message',raw=>{let m;try{m=JSON.parse(raw.toString())}catch(e){return}
    if(m.type==='champ_ready'){p.ready=true;bc(state());if(room.players.size===room.maxPlayers&&[...room.players.values()].every(x=>x.ready)){room.index=0;room.questions=pickQuestions(30);room.answers.clear();for(const x of room.players.values()){x.score=0;x.ready=false}bc({type:'champ_start',questions:room.questions});bc(state())}}
    else if(m.type==='champ_answer'||m.type==='champ_timeout'){
      if(room.answers.has(p.id))return; const q=room.questions[room.index]; if(!q)return; const idx=m.type==='champ_timeout'?-1:Number(m.index); const correct=idx===Number(q[2]);if(correct)p.score+=10;room.answers.set(p.id,{idx,correct});
      send(p,{type:'champ_answer_result',correct,myScore:p.score,selectedIndex:idx});
      if(room.answers.size===room.players.size){setTimeout(()=>{room.index++;room.answers.clear();if(room.index>=room.questions.length){const results=[...room.players.values()].sort((a,b)=>b.score-a.score).map((x,i)=>({position:i+1,name:x.name,score:x.score,prize:i===0?500:i===1?250:i===2?125:0}));bc({type:'champ_end',results});room.players.forEach(x=>x.ready=false)}else bc({type:'champ_next',index:room.index});},700)}
    }
  });
  ws.on('close',()=>{if(room.players.get(p.id)?.ws===ws){p.ws=null;p.ready=false;bc(state())}});
});

server.listen(PORT,'0.0.0.0',()=>console.log(`BRASIL QUIZ BIBLICO rodando na porta ${PORT}`));
