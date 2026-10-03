(function(root){"use strict";
  const clean=v=>String(v??"").replace(/[\u00a0\t\r\n ]+/g," ").trim();
  const exact=(a,b)=>clean(a)===clean(b);
  const csv=v=>{const s=String(v??"");const safe=/^[=+\-@]/.test(s)?`'${s}`:s;return /[",\r\n]/.test(safe)?`"${safe.replace(/"/g,'""')}"`:safe};
  const toCsv=(headers,rows)=>"\ufeff"+[headers,...rows].map(r=>r.map(csv).join(",")).join("\r\n");
  function rowName(row){return clean(row.querySelector(".goodsName a[title],.goodsName a")?.getAttribute("title")||row.querySelector(".goodsName a")?.textContent||"")}
  function rowIds(row){const ids=new Set();for(const el of [row,...row.querySelectorAll("[data-item-id],[data-id],[data-product-id]")])for(const a of ["data-item-id","data-id","data-product-id","data-row-key"])if(el.getAttribute?.(a))ids.add(clean(el.getAttribute(a)).replace(/^item_/i,""));for(const a of row.querySelectorAll("a[href]")){try{const u=new URL(a.href);for(const k of ["id","itemId","item_id","itemid","goodsId","goods_id"])if(u.searchParams.get(k))ids.add(clean(u.searchParams.get(k)))}catch{}}return [...ids]}
  function matchRow(row,item){const ids=rowIds(row);const idMatch=item.id&&ids.includes(clean(item.id));const nameMatch=item.name&&exact(rowName(row),item.name);return {idMatch,nameMatch,ids,name:rowName(row)}}
  function detailValues(headers,cells,kind){
    const value=name=>cells[headers.findIndex(h=>clean(h)===name)]||"";
    return {competitorName:value("商品名称"),shopName:value("所属店铺"),
      lossIndex:kind==="browse"?value("流失指数"):"",lossPopularity:kind==="browse"?value("流失人气"):"",
      searchCompetitionIndex:kind==="search"?value("搜索竞争指数"):"",searchPeople:kind==="search"?value("搜索人数"):"",
      searchFavoriteIndex:kind==="search"?value("搜索收藏指数"):"",searchCartIndex:kind==="search"?value("搜索加购指数"):"",
      searchTransactionIndex:kind==="search"?value("搜索交易指数"):""};
  }
  const cellText=cell=>clean(cell?.innerText)||clean(cell?.querySelector?.("a[title]")?.getAttribute("title"))||clean(cell?.textContent);
  const detailCells=row=>[...row.querySelectorAll("td")].map(cellText);
  function competitorRedirect(row){
    const href=(row.querySelector(".goodsName a[href]") || row.querySelector("a.goodsImg[href]"))?.href;
    if(!href)return "";
    try{const u=new URL(href);return productIdFromUrl(u.href)||(u.hostname==="sycm.taobao.com"&&/^\/mc\/common\/(tm|tb)_item_redirect\.htm$/.test(u.pathname)&&u.searchParams.get("mi_id"))?u.href:""}catch{return ""}
  }
  function productIdFromUrl(url){
    try{const u=new URL(url);return ["detail.tmall.com","item.taobao.com"].includes(u.hostname)&&u.pathname==="/item.htm"&&/^\d{8,20}$/.test(u.searchParams.get("id")||"")?u.searchParams.get("id"):""}catch{return ""}
  }
  const missingDetailFields=values=>[["竞品商品名称",values.competitorName],["所属店铺",values.shopName]].filter(([,value])=>!clean(value)).map(([name])=>name);
  const isRiskText=text=>/访问(?:过于|太)?频繁|操作(?:过于|太)?频繁|请完成(?:安全|滑块|人机)验证|请先进行安全验证|检测到异常访问|异常访问行为|触发安全机制|限制访问/.test(String(text||""));
  const shouldReloadDatePage=({displayed,hasView,attempted})=>!attempted&&(!displayed||!hasView);
  root.CompetitorCore={clean,exact,csv,toCsv,rowName,rowIds,matchRow,detailValues,cellText,detailCells,competitorRedirect,productIdFromUrl,missingDetailFields,isRiskText,shouldReloadDatePage};
  if(typeof module!=="undefined"&&module.exports)module.exports=root.CompetitorCore;
})(typeof window!=="undefined"?window:globalThis);
