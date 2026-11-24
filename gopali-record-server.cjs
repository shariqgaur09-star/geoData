const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const service = "https://upbhunaksha.gov.in/bhunakshaserver/MapInfo/getPlotInfo";
const meta = '<meta id="recordEndpoint" content="">';
const apiPath = "/api/plot-record";
const onRender = process.env.RENDER==="true";
const assets = new Set(["gopali-live-parcels.js","gopali-current.js","gopali-registered-preview.png"]);
if (!onRender) for (const file of ["gopali-sheet-candidates.js","gopali-preview.js","gopali-refresh-report.json","gopali-2026-11-24-gis.zip"])
  assets.add(file);
const types = {".js":"text/javascript", ".png":"image/png", ".json":"application/json", ".zip":"application/zip"};

class RecordError extends Error {
  constructor(status,message) { super(message); this.status=status; }
}

function parsePlotInfo(text,plotNo) {
  const accounts=new Map();
  let group;
  if (!text.trim() || /^(?:ROR information not available|no records? found)[.!]?$/i.test(text.trim()))
    throw new RecordError(404,"No public record was returned for this gata.");
  for (const line of text.split(/\r\n?|\n/).map(s=>s.trim()).filter(Boolean)) {
    const land=/^Khata\s+No\s*:\s*(\S+)\s+Plot\s+No\s*:\s*(.+?)\s+Area\s*:\s*(\d+(?:\.\d+)?)\s+Hectares?\.?$/i.exec(line);
    if (land) {
      const [,khata,gata,areaHa]=land;
      if (gata!==plotNo) throw new RecordError(502,"UP BhuNaksha returned a different gata; its record was discarded.");
      if (accounts.has(khata) && accounts.get(khata).areaHa!==areaHa)
        throw new RecordError(502,"UP BhuNaksha returned conflicting areas for the same khata.");
      if (!accounts.has(khata)) accounts.set(khata,{khata,areaHa,holders:[]});
      group=null; continue;
    }
    const heading=/^Owner\s+Details\s+For\s+Khata\s+No\.?\s*:\s*-?\s*(\S+)$/i.exec(line);
    if (heading && accounts.has(heading[1])) { group=accounts.get(heading[1]); continue; }
    // Discard guardian and residence fields here, before the response reaches the browser.
    const holder=/^\d+\s*:\s*-\s*नाम\s*:\s*(.*?)\s*(?:संरक्षक\s+का\s+नाम|निवास\s+स्थान)\s*:/u.exec(line);
    if (group && holder?.[1].trim()) { group.holders.push(holder[1].trim()); continue; }
    throw new RecordError(502,"Unrecognized UP BhuNaksha record format; no partial record is displayed.");
  }
  return {villageCode:"110216",plotNo,accounts:[...accounts.values()]};
}

async function readText(stream,limit,tooLarge) {
  if (!stream) return "";
  const chunks=[];
  let size=0;
  for await (const chunk of stream) {
    size+=chunk.length;
    if (size>limit) throw tooLarge;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function getRecord(plotNo,signal,fetchPlot) {
  try {
    const source=await fetchPlot(service,{method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({gisCode:"13200704110216",plotNo}), redirect:"error", signal});
    if (!source.ok) {
      await source.body?.cancel();
      throw new RecordError(503,`UP BhuNaksha returned HTTP ${source.status}; no live record is available.`);
    }
    return parsePlotInfo(await readText(source.body,1024*1024,new RecordError(502,"Source record exceeds the display limit.")),plotNo);
  } catch (err) {
    if (signal.aborted) throw new RecordError(504,"The request to UP BhuNaksha timed out.");
    if (err instanceof RecordError) throw err;
    throw new RecordError(503,"Could not reach or read UP BhuNaksha. Try again later.");
  }
}

function createPortalServer(fetchPlot=fetch) {
  let starts=[], active=0;
  return http.createServer(async (req,res)=>{
    const route=req.url.split("?")[0];
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Referrer-Policy","no-referrer");
    res.setHeader("Cache-Control","no-store");
    try {
      if (route===apiPath) {
        if (req.method!=="POST") { res.setHeader("Allow","POST"); throw new RecordError(405,"Use POST."); }
        if (req.headers["sec-fetch-site"]==="cross-site") throw new RecordError(403,"Use the Gopali portal to request a record.");
        if (req.headers["content-type"]?.split(";")[0].trim()!=="application/json") throw new RecordError(415,"Expected JSON.");
        const raw=await readText(req,512,new RecordError(413,"Supply one gata number."));
        let input;
        try { input=JSON.parse(raw); } catch { throw new RecordError(400,"Invalid JSON."); }
        const plotNo=input?.plotNo;
        if (typeof plotNo!=="string" || plotNo!==plotNo.trim() || !/^\p{Nd}[\p{Nd}\p{L}\p{M} ./()-]{0,47}$/u.test(plotNo) ||
            Object.keys(input).length!==1) throw new RecordError(400,"Supply only one gata number, for example 373 or 0012/क.");
        const now=Date.now();
        starts=starts.filter(t=>now-t<60000);
        if (starts.length>=30 || active>=4) throw new RecordError(429,"Too many record requests. Please retry later.");
        starts.push(now); active++;
        const request=new AbortController(), abort=()=>request.abort();
        const timer=setTimeout(abort,10000);
        res.once("close",abort);
        try {
          const data=await getRecord(plotNo,request.signal,fetchPlot);
          if (!res.destroyed) res.writeHead(200,{"Content-Type":"application/json; charset=utf-8"}).end(JSON.stringify(data));
        } finally {
          clearTimeout(timer); res.off("close",abort); active--;
        }
        return;
      }
      if (!["GET","HEAD"].includes(req.method)) { res.setHeader("Allow","GET, HEAD"); throw new RecordError(405,"Use GET or HEAD."); }
      if (route==="/" || route==="/gopali-portal.html") {
        const html=await fs.promises.readFile(path.join(__dirname,"gopali-portal.html"),"utf8");
        res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
        res.end(req.method==="HEAD" ? undefined : html.replace(meta,`<meta id="recordEndpoint" content=".${apiPath}">`));
        return;
      }
      const name=route.slice(1);
      if (!assets.has(name)) throw new RecordError(404,"Not found.");
      const file=path.join(__dirname,name), {size}=await fs.promises.stat(file);
      res.writeHead(200,{"Content-Type":types[path.extname(file)],"Content-Length":size});
      if (req.method==="HEAD") { res.end(); return; }
      const stream=fs.createReadStream(file);
      res.once("close",()=>stream.destroy());
      stream.on("error",()=>res.destroy()); stream.pipe(res);
    } catch (err) {
      if (res.destroyed) return;
      const status=err instanceof RecordError ? err.status : err.code==="ENOENT" ? 404 : 500;
      res.writeHead(status,{"Content-Type":"application/json; charset=utf-8"}).end(JSON.stringify({
        error:err instanceof RecordError ? err.message : status===404 ? "Not found." : "The local server could not complete this request."
      }));
    }
  });
}

module.exports = {createPortalServer};
if (require.main===module) {
  if (onRender && fs.readFileSync(path.join(__dirname,"gopali-portal.html"),"utf8").includes("<!-- workspace-only -->"))
    throw Error("Deploy the standalone Gopali pilot export on Render, not the workspace.");
  const host=onRender ? "0.0.0.0" : "127.0.0.1";
  const port=Number(process.env.PORT ?? (onRender ? 10000 : 8765)), server=createPortalServer();
  server.on("error",err=>{ console.error(`Cannot start Gopali portal: ${err.message}`); process.exitCode=1; });
  server.listen(port,host,()=>console.log(`Gopali portal: http://${host}:${server.address().port}/ (Ctrl+C to stop)`));
}
