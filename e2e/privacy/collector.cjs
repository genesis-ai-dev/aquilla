const http=require('node:http'),zlib=require('node:zlib');
let records=[];
http.createServer((req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
 if(req.url==='/_reset'){records=[];res.end('{}');return}
 if(req.url==='/_audit'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(records));return}
 const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
  let body=Buffer.concat(chunks);if(body[0]===0x1f&&body[1]===0x8b)body=zlib.gunzipSync(body);
  let payload=body.toString();try{payload=JSON.parse(payload)}catch{}
  records.push({at:Date.now(),method:req.method,path:req.url,payload});if(records.length>5000)records.shift();
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify(req.method==='GET'?{hasFeatureFlags:false,sessionRecording:{sampleRate:1,minimumDurationMilliseconds:0,endpoint:'/s/'},capturePerformance:false}:{status:1}));
 });
}).listen(9999,'127.0.0.1',()=>process.stdout.write('Synthetic analytics collector on 127.0.0.1:9999\n'));
