// Private to one Gopali server instance; keys are exact gata strings, not numeric IDs.
function createDailyLookup(clock=Date.now) {
  const records=new Map(), pending=new Map();
  const day=86400000, istOffset=19800000;
  let expires=0, timer;
  function clearDay() {
    records.clear(); expires=0; clearTimeout(timer);
  }
  return async function lookup(plotNo,load) {
    const now=clock();
    if (expires && now>=expires) clearDay();
    if (records.has(plotNo)) return {...records.get(plotNo),cache:"hit"};
    if (pending.has(plotNo)) return {...await pending.get(plotNo),cache:"shared"};
    const promise=load().then(data=>{
      const time=clock();
      if (!expires || time>=expires) {
        clearDay();
        expires=time+day-(time+istOffset)%day;
        timer=setTimeout(clearDay,expires-time);
        timer.unref();
      }
      const entry={data,fetchedAt:new Date(time).toISOString()};
      records.set(plotNo,entry);
      return entry;
    });
    pending.set(plotNo,promise);
    try { return {...await promise,cache:"miss"}; }
    finally { pending.delete(plotNo); }
  };
}

module.exports={createDailyLookup};
