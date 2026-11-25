const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {setTimeout:delay} = require("node:timers/promises");
const {createDailyLookup} = require("./gopali-record-cache.cjs");

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

function retryDelay(header) {
  if (header===null) return 750;
  return /^\d+$/.test(header) ? Number(header)*1000 : Math.max(0,Date.parse(header)-Date.now());
}

async function getRecord(plotNo,signal,fetchPlot,reserveRetry) {
  try {
    for (let attempt=1;;attempt++) {
      const source=await fetchPlot(service,{method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({gisCode:"13200704110216",plotNo}), redirect:"error", signal});
      if (source.ok) return parsePlotInfo(await readText(source.body,1024*1024,
        new RecordError(502,"Source record exceeds the display limit.")),plotNo);
      await source.body?.cancel();
      if (attempt===1 && source.status===503) {
        const wait=retryDelay(source.headers.get("retry-after"));
        if (wait<=2000) {
          await delay(wait,undefined,{signal});
          if (reserveRetry()) continue;
        }
      }
      throw new RecordError(503,`UP BhuNaksha returned HTTP ${source.status}; no live record is available.`);
    }
  } catch (err) {
    if (signal.aborted) throw new RecordError(504,"The request to UP BhuNaksha timed out.");
    if (err instanceof RecordError) throw err;
    throw new RecordError(503,"Could not reach or read UP BhuNaksha. Try again later.");
  }
}

async function getIprRecord(plotNo,signal,fetchPlot,key,requireReader) {
  const malformed=()=>new RecordError(502,"India Property Register returned an unreadable or mismatched record.");
  async function get(resource) {
    try {
      signal.throwIfAborted();
      requireReader();
      const r=await fetchPlot(`https://indiapropertyregister.com/api/v1/${resource}`,{
        method:"GET",headers:{Accept:"application/json",Authorization:`Bearer ${key}`},redirect:"error",signal
      });
      if (!r.ok) {
        await r.body?.cancel();
        const errors={401:"The site's IPR key was not accepted.",403:"IPR did not permit this request.",
          402:"The site's IPR wallet has insufficient credit.",404:"No IPR record found.",429:"IPR's call limit has been reached."};
        throw new RecordError([402,404,429].includes(r.status) ? r.status : 503,errors[r.status] || `IPR returned HTTP ${r.status}.`);
      }
      if (!r.headers.get("content-type")?.includes("application/json")) { await r.body?.cancel(); throw malformed(); }
      const raw=await readText(r.body,1024*1024,new RecordError(502,"The IPR record exceeds the display limit."));
      try { return JSON.parse(raw); } catch { throw malformed(); }
    } catch (err) {
      if (signal.aborted) throw new RecordError(504,"The IPR lookup timed out or was cancelled.");
      if (err instanceof RecordError) throw err;
      throw new RecordError(503,"India Property Register could not be reached.");
    }
  }
  const found=await get(`village/110216/plots?${new URLSearchParams({plot:plotNo})}`);
  if (String(found?.village?.lgd)!=="110216" || !Array.isArray(found.matches)) throw malformed();
  const exact=found.matches.filter(m=>m?.plot_no===plotNo);
  if (!exact.length) throw new RecordError(404,"No exact IPR match for this Gopali gata. Related subdivisions were not substituted.");
  if (exact.length!==1 || !/^P[0-9a-f]{16}$/i.test(exact[0].ipr_id)) throw malformed();
  const id=exact[0].ipr_id, plot=await get(`plot/${id}`);
  if (plot?.ipr_id!==id || plot.plot_no!==plotNo || String(plot.village?.lgd)!=="110216" ||
      !Array.isArray(plot.land_records) || (plot.holders!=null && !Array.isArray(plot.holders))) throw malformed();
  const text=v=>typeof v==="string" && v.trim() ? v.trim() : null;
  const area=a=>text(a?.as_printed) ?? ((Number.isFinite(a?.value) || text(a?.value)) && text(a?.unit) ? `${a.value} ${a.unit}` : null);
  const records=plot.land_records.filter(r=>r?.record_system==="up_khatauni").map(r=>({
    khata:text(r.khata_no),area:area(r.area),landClass:text(r.land_class),source:text(r.source?.name),
    recordDate:text(r.record_date),readOn:text(r.read_on)
  }));
  if (!records.length) throw new RecordError(404,"IPR has a plot entry but no dated UP Khatauni record for this gata.");
  const holders=(plot.holders ?? []).filter(h=>h && !h.until).map(h=>({
    name:text(h.name),share:text(h.share),area:area(h.area)
  }));
  return {provider:"ipr",villageCode:"110216",plotNo,records,holders};
}

function createPortalServer(fetchPlot=fetch,iprKey=process.env.IPR_API_KEY?.trim(),clock=Date.now) {
  let starts=[], iprStarts=[], active=0;
  const lookup=createDailyLookup(clock), paidAttempts=createDailyLookup(clock);
  const readers=new Map();
  function requireReader(plotNo) {
    if (![...(readers.get(plotNo) ?? [])].some(res=>!res.destroyed && !res.socket?.destroyed))
      throw new RecordError(409,"Plot request no longer active; paid lookup stopped.");
  }
  function reserveStart() {
    const now=clock();
    starts=starts.filter(t=>now-t<60000);
    if (starts.length>=30) return false;
    starts.push(now); return true;
  }
  async function fallback(plotNo) {
    const {data}=await paidAttempts(plotNo,async ()=>{
      requireReader(plotNo);
      const now=clock();
      iprStarts=iprStarts.filter(t=>now-t<3600000);
      if (iprStarts.length>=5) throw new RecordError(429,"BhuNaksha unavailable; the demo's hourly IPR allowance is used up.");
      iprStarts.push(now);
      try { return {record:await getIprRecord(plotNo,AbortSignal.timeout(16000),fetchPlot,iprKey,()=>requireReader(plotNo))}; }
      catch (err) {
        // Even a failed detail read may follow a billed plot-ID search. Reserve the attempt for today.
        return {error:err instanceof RecordError ? err : new RecordError(502,"Unreadable India Property Register response.")};
      }
    });
    if (data.error) throw new RecordError(data.error.status,`BhuNaksha unavailable. ${data.error.message} IPR will not be retried for this gata until tomorrow (IST).`);
    return data.record;
  }
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
        async function load() {
          if (active>=4 || !reserveStart()) throw new RecordError(429,"Too many record requests. Please retry later.");
          active++;
          try {
            return await getRecord(plotNo,AbortSignal.timeout(10000),fetchPlot,reserveStart);
          } catch (err) {
            if (!(err instanceof RecordError)) throw err;
            if (!iprKey) throw new RecordError(err.status,`${err.message} IPR fallback is not configured on this server.`);
            return await fallback(plotNo);
          } finally { active--; }
        }
        const group=readers.get(plotNo) ?? new Set();
        readers.set(plotNo,group); group.add(res);
        function release() {
          group.delete(res);
          if (!group.size && readers.get(plotNo)===group) readers.delete(plotNo);
        }
        res.once("close",release);
        let result;
        try { result=await lookup(plotNo,load); }
        finally { res.off("close",release); release(); }
        if (res.destroyed) return;
        res.setHeader("X-Record-Cache",result.cache);
        res.setHeader("X-Record-Fetched-At",result.fetchedAt);
        res.writeHead(200,{"Content-Type":"application/json; charset=utf-8"}).end(JSON.stringify(result.data));
        return;
      }
      if (!["GET","HEAD"].includes(req.method)) { res.setHeader("Allow","GET, HEAD"); throw new RecordError(405,"Use GET or HEAD."); }
      if (route==="/" || route==="/gopali-portal.html") {
        const html=await fs.promises.readFile(path.join(__dirname,"gopali-portal.html"),"utf8");
        res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
        const page=html.replace(meta,`<meta id="recordEndpoint" content=".${apiPath}">`);
        res.end(req.method==="HEAD" ? undefined : page);
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
