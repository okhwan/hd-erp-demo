/* ============================================================================
   hd-erp 포트폴리오 데모 — 백엔드 없이 화면만으로 동작하게 하는 모의 API
   · 화면의 모든 /api 요청을 브라우저 안에서 가로채 mock-data.json 으로 답한다
   · 목록 화면(서버 페이징)의 검색·기간·상태·정렬·페이지는 서버와 같은 규칙으로 여기서 계산한다
   · 날짜는 「오늘」 기준으로 옮겨서 보여 준다 (언제 들어와도 오늘·이번 달 데이터가 있다)
   · 등록·수정·삭제는 성공으로 답하지만 실제로 저장되지는 않는다 (읽기 전용 데모)
   ========================================================================== */
(function () {
  "use strict";
  var DATA_URL = "/mock-data.json";
  var ME_FALLBACK = "관리자";
  var OVERDUE_DAYS = 30;

  /* ── 로그인 생략: 만료되지 않는 가짜 토큰을 미리 넣어 둔다 ── */
  function b64(o) { return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"); }
  var TOKEN = b64({ alg: "none" }) + "." + b64({ sub: "demo", exp: 4102444800 }) + ".demo";
  try { localStorage.setItem("hderp_at", TOKEN); localStorage.setItem("hderp_rt", TOKEN); } catch (e) { /* 무시 */ }

  /* ── 날짜 옮기기 ── */
  function kstToday() { var d = new Date(Date.now() + 9 * 3600e3); return d.toISOString().slice(0, 10); }
  function addDays(iso, n) { var d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400e3); }
  var TODAY = kstToday();

  var DB = null, ME = ME_FALLBACK;
  var ready = window.__realFetch0 ? null : null;
  var realFetch = window.fetch.bind(window);
  ready = realFetch(DATA_URL, { cache: "force-cache" }).then(function (r) { return r.text(); }).then(function (txt) {
    var base = (txt.match(/"today":"(\d{4}-\d{2}-\d{2})"/) || [])[1] || TODAY;
    var off = daysBetween(base, TODAY);
    if (off !== 0) {
      /* 자료 전체(열쇠 포함)의 yyyy-MM-dd 를 off 일만큼 민다 */
      txt = txt.replace(/(^|[^\d])(20\d\d-[01]\d-[0-3]\d)(?!\d)/g, function (m, pre, d) { return pre + addDays(d, off); });
    }
    DB = JSON.parse(txt);
    DB.today = TODAY;
    var me = DB.fixed["/api/auth/me"]; if (me && me.name) ME = me.name;
    prep();
  });

  /* ── 공통 도구 ── */
  function norm(u) {
    var path = decodeURIComponent(u.pathname);
    var ent = []; u.searchParams.forEach(function (v, k) { ent.push([k, v, ent.length]); });
    ent.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[2] - b[2]; });
    return path + (ent.length ? "?" + ent.map(function (e) { return e[0] + "=" + e[1]; }).join("&") : "");
  }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function nz(s) { return s == null ? "" : String(s); }
  function low(s) { return nz(s).toLowerCase(); }
  function n(v) { return typeof v === "number" ? v : Number(v) || 0; }
  function csv(s) { return !s ? [] : s.split(",").map(function (x) { return x.trim(); }).filter(function (x) { return x && x !== "전체"; }); }
  function bool(s) { return s === "true" || s === "1"; }
  function inRange(d, f, t) { d = nz(d).slice(0, 10); if (f && d < f) return false; if (t && d > t) return false; return true; }
  function sortRows(rows, key, asc, dflt) {
    if (!key) { if (dflt) rows.sort(dflt); return rows; }
    var dir = asc ? 1 : -1;
    rows.sort(function (a, b) {
      var x = a[key], y = b[key];
      if (typeof x === "number" || typeof y === "number") { x = n(x); y = n(y); } else { x = nz(x); y = nz(y); }
      var c = x < y ? -1 : x > y ? 1 : 0;
      return c ? c * dir : (dflt ? dflt(a, b) : 0);
    });
    return rows;
  }
  function paged(rows, q, sumsFn) {
    var out = {};
    if (bool(q.get("all"))) out.rows = rows;
    else {
      var size = Math.max(1, Math.min(500, parseInt(q.get("size") || "30", 10))), page = Math.max(1, parseInt(q.get("page") || "1", 10));
      out.rows = rows.slice((page - 1) * size, (page - 1) * size + size);
    }
    if (bool(q.get("total")) || bool(q.get("all"))) { out.total = rows.length; if (sumsFn) out.sums = sumsFn(rows); }
    return out;
  }
  function sum(rows, f) { var s = 0; rows.forEach(function (r) { s += n(typeof f === "function" ? f(r) : r[f]); }); return s; }

  /* ── 자료 준비 ── */
  var ACC = {}, CAT = {};
  function prep() {
    (DB.fixed["/api/accounts"] || []).forEach(function (a) {
      var label = a.kind === "현금" ? (a.alias || "현금") : (a.alias || (nz(a.bank) + " " + nz(a.number)).trim());
      ACC[a.id] = { kind: a.kind || "통장", label: label };
    });
    var cats = DB.fixed["/api/fund/categories"] || [];
    (function walk(list, parent) {
      (list || []).forEach(function (c) {
        CAT[c.id] = { name: c.name, parentId: c.parentId != null ? c.parentId : parent };
        if (c.children) walk(c.children, c.id);
      });
    })(Array.isArray(cats) ? cats : (cats.list || []), null);
  }

  /* ── 목록 화면 흉내 ── */
  function ordersPage(q) {
    var S = DB.snap.orders, view = q.get("view") || "order";
    var est = view === "estimate", sales = view === "sales", salesDone = bool(q.get("salesDone"));
    var rows = (est ? S.estimate : view === "deleted" ? S.deleted : sales ? (salesDone ? S.sales1 : S.sales0) : S.order).slice();
    var noKey = est ? "estimateNo" : "orderNo";
    var dateOf = est ? function (r) { return r.estimateDate; } : (sales && salesDone) ? function (r) { return r.salesDate || r.orderDate; } : function (r) { return r.orderDate; };
    if (est) {
      var es = q.get("estStatus") || "전체";
      if (bool(q.get("estOnly")) || es === "견적") rows = rows.filter(function (r) { return r.status === "견적"; });
      else if (es === "수주전환됨") rows = rows.filter(function (r) { return r.status !== "견적"; });
    }
    var kw = low(q.get("kw")).trim(), type = q.get("type") || "all";
    if (kw) {
      var itemHit = function (r) {
        return low(r.item).indexOf(kw) >= 0 || (r.items || []).some(function (i) {
          return low(i.name).indexOf(kw) >= 0 || low(i.spec).indexOf(kw) >= 0 || low(i.code).indexOf(kw) >= 0
            || (i.goods || []).some(function (g) { return low(g).indexOf(kw) >= 0; });
        });
      };
      var noHit = function (r) { return low(r[noKey]).indexOf(kw) >= 0; };
      var goodsHit = function (r) {
        if (/^\d{1,5}$/.test(kw)) return nz(r.goodsNo).split(/[,\-]/).indexOf(kw) >= 0 || (r.items || []).some(function (i) { return (i.goods || []).some(function (g) { return low(g).indexOf(kw) >= 0; }); });
        return (r.items || []).some(function (i) { return low(i.code).indexOf(kw) >= 0 || (i.goods || []).some(function (g) { return low(g).indexOf(kw) >= 0; }); });
      };
      rows = rows.filter(function (r) {
        switch (type) {
          case "no": return noHit(r);
          case "customer": return low(r.customer).indexOf(kw) >= 0;
          case "registrant": return low(r.registrant).indexOf(kw) >= 0;
          case "item": return itemHit(r);
          case "itemNo": return goodsHit(r);
          default:
            return noHit(r) || low(r.customer).indexOf(kw) >= 0 || (!sales && low(r.registrant).indexOf(kw) >= 0) || itemHit(r);
        }
      });
    }
    var f = q.get("from"), t = q.get("to");
    if (f || t) rows = rows.filter(function (r) { var d = dateOf(r); return d && inRange(d, f, t); });
    var me = function (r) { return r.registrant === ME || r.registrant === ME_FALLBACK; };
    if (est) { if (bool(q.get("mineOnly"))) rows = rows.filter(me); }
    else if (sales) {
      var slip = q.get("slip") || "all";
      if (slip === "done") rows = rows.filter(function (r) { return !!r.slipPrintedAt; });
      if (slip === "none") rows = rows.filter(function (r) { return !r.slipPrintedAt; });
    } else {
      var st = csv(q.get("statuses")); if (st.length) rows = rows.filter(function (r) { return st.indexOf(r.status) >= 0; });
      var sl = q.get("sales") || "all";
      if (sl === "done") rows = rows.filter(function (r) { return r.salesRegistered; });
      if (sl === "none") rows = rows.filter(function (r) { return !r.salesRegistered; });
      if (bool(q.get("prodOnly"))) rows = rows.filter(function (r) { return r.status !== "생산완료" && (r.items || []).some(function (i) { return !i.isOption && n(i.producedQty) < n(i.qty); }); });
      if (bool(q.get("urgentOnly"))) rows = rows.filter(function (r) { return r.urgent && !r.salesRegistered; });
      if (bool(q.get("mineOnly"))) rows = rows.filter(me);
      if (bool(q.get("poWait"))) rows = rows.filter(function (r) { return (r.status === "수주" || r.status === "생산등록") && (r.items || []).some(function (i) { return /^\s*@/.test(nz(i.name)); }); });
      if (q.get("dueDays") != null && q.get("dueDays") !== "") {
        var lim = addDays(TODAY, Math.max(0, parseInt(q.get("dueDays"), 10) || 0));
        rows = rows.filter(function (r) { return r.status !== "생산완료" && r.deliveryDate && r.deliveryDate >= TODAY && r.deliveryDate <= lim; });
      }
      if (bool(q.get("overdue"))) {
        var a0 = addDays(TODAY, -OVERDUE_DAYS), a1 = addDays(TODAY, -1);
        rows = rows.filter(function (r) { return r.status !== "생산완료" && !r.salesRegistered && r.deliveryDate && r.deliveryDate >= a0 && r.deliveryDate <= a1; });
      }
    }
    var recent = function (a, b) { var c = nz(b.ver || b.registeredAt).localeCompare(nz(a.ver || a.registeredAt)); return c || (b.id - a.id); };
    var sortKey = q.get("sort"); var map = { supply: "supply", tax: "tax", price: "price", amount: "price", registeredAt: "registeredAt", modifiedAt: "modifiedAt" };
    sortRows(rows, sortKey ? (map[sortKey] || sortKey) : null, (q.get("dir") || "desc") === "asc", recent);
    return paged(rows, q, function (rs) { return { qty: sum(rs, "qty"), supply: sum(rs, "supply"), tax: sum(rs, "tax"), price: sum(rs, "price") }; });
  }

  function asPage(q) {
    var k = low(q.get("kw")).trim(), type = q.get("type") || "all";
    var f = q.get("from"), t = q.get("to");
    if (/^a\d{4,}$/.test(k) && (type === "all" || type === "asNo")) { f = null; t = null; }
    var st = csv(q.get("statuses"));
    var shown = function (r) { return r.status === "접수" && r.webChecked ? "확인" : r.status; };
    var has = function (s) { return low(s).indexOf(k) >= 0; };
    var rows = DB.snap.as.filter(function (r) {
      if ((f || t) && !inRange(r.recvDate, f, t)) return false;
      if (st.length && st.indexOf(shown(r)) < 0) return false;
      if (bool(q.get("visitToday")) && !(r.visitDate === TODAY && r.status !== "완료")) return false;
      if (bool(q.get("visitLate")) && !(r.visitDate && r.visitDate < TODAY && r.status !== "완료")) return false;
      if (!k) return true;
      switch (type) {
        case "customer": return has(r.customer);
        case "manager": return has(r.manager);
        case "symptom": return has(r.symptom);
        case "asNo": return has(r.asNo);
        default: return has(r.asNo) || has(r.customer) || has(r.manager) || has(r.symptom) || has(r.address) || has(r.goodsCode) || has(r.note);
      }
    });
    sortRows(rows, q.get("sort"), q.get("dir") === "asc", null);
    return paged(rows, q, function (rs) { return { cost: sum(rs, "cost"), billed: sum(rs, function (r) { return n(r.billed) + n(r.salesTotal); }), paid: sum(rs, function (r) { return n(r.paid) + n(r.collected); }) }; });
  }

  function collectionsPage(q) {
    var k = low(q.get("kw")).trim(), type = q.get("type") || "all", f = q.get("from"), t = q.get("to");
    var ms = csv(q.get("methods")), has = function (s) { return low(s).indexOf(k) >= 0; };
    var rows = DB.snap.collections.filter(function (r) {
      if ((f || t) && !inRange(r.payDate, f, t)) return false;
      if (ms.length && ms.indexOf(r.method) < 0) return false;
      if (bool(q.get("mineOnly")) && !(r.registrant === ME || r.registrant === ME_FALLBACK)) return false;
      if (bool(q.get("diffOnly")) && n(r.amount) === n(r.netAmount)) return false;
      if (!k) return true;
      switch (type) {
        case "customer": return has(r.customer);
        case "workplace": return has(r.workplace);
        case "registrant": return has(r.registrant);
        default: return has(r.customer) || has(r.workplace) || has(r.siteAddr) || has(r.registrant) || has(r.note);
      }
    });
    sortRows(rows, q.get("sort"), q.get("dir") === "asc", null);
    return paged(rows, q, function (rs) { return { amount: sum(rs, "amount"), netAmount: sum(rs, "netAmount") }; });
  }

  function fundPage(q) {
    var f = q.get("from"), t = q.get("to"), acc = q.get("accountId"), ks = csv(q.get("kinds")), io = q.get("io");
    var pid = q.get("parentId"), cid = q.get("categoryId"), ss = csv(q.get("sources")), k = low(q.get("kw")).trim();
    var rows = DB.snap.fund.filter(function (r) {
      if (!inRange(r.dealDate, f, t)) return false;
      if (acc && String(r.accountId) !== acc) return false;
      var a = ACC[r.accountId];
      if (ks.length && ks.indexOf(a ? a.kind : "통장") < 0) return false;
      if (io === "I" && !(n(r.income) > 0)) return false;
      if (io === "O" && !(n(r.expense) > 0)) return false;
      var c = r.categoryId != null ? CAT[r.categoryId] : null;
      if (cid) { if (String(r.categoryId) !== cid) return false; }
      else if (pid) { if (!c || String(c.parentId) !== pid) return false; }
      if (ss.length && ss.indexOf(r.source) < 0) return false;
      if (k) {
        var pName = "-", cName = "-";
        if (c) { var p = c.parentId != null ? CAT[c.parentId] : null; if (p) { pName = p.name; cName = c.name; } else pName = c.name; }
        var label = a ? a.label : "-";
        if (!(low(r.customer).indexOf(k) >= 0 || low(r.description).indexOf(k) >= 0 || low(label).indexOf(k) >= 0
          || low(pName).indexOf(k) >= 0 || low(cName).indexOf(k) >= 0)) return false;
      }
      return true;
    });
    return paged(rows, q, function (rs) { return { income: sum(rs, "income"), expense: sum(rs, "expense") }; });
  }

  function poPage(q) {
    var st = csv(q.get("statuses")), k = low(q.get("kw")).trim(), type = q.get("type") || "all", f = q.get("from"), t = q.get("to");
    var rows = DB.snap.po.filter(function (r) {
      if (st.length && st.indexOf(r.status) < 0) return false;
      if (bool(q.get("lateOnly")) && !((r.status === "발주" || r.status === "부분입고") && r.dueDate && r.dueDate < TODAY)) return false;
      if ((f || t) && !inRange(r.poDate, f, t)) return false;
      if (k) {
        var items = (r.items || []).map(function (i) { return nz(i.name); }).join(" ").toLowerCase();
        var no = low(r.poNo).indexOf(k) >= 0, vd = low(r.vendor).indexOf(k) >= 0, it = items.indexOf(k) >= 0;
        if (!(type === "no" ? no : type === "vendor" ? vd : type === "item" ? it : (no || vd || it))) return false;
      }
      return true;
    });
    return paged(rows, q, function (rs) { return { total: sum(rs.filter(function (r) { return r.status !== "취소"; }), "total") }; });
  }

  function purchasesPage(q) {
    var k = low(q.get("kw")).trim(), f = q.get("from"), t = q.get("to");
    var rows = DB.snap.purchases.filter(function (r) {
      if (!r.inDate) return false;
      if (!inRange(r.inDate, f, t)) return false;
      return !k || low(r.poNo).indexOf(k) >= 0 || low(r.vendor).indexOf(k) >= 0 || low(r.item).indexOf(k) >= 0;
    });
    var out = paged(rows, q, function (rs) { return { price: sum(rs, "price") }; });
    var origins = {}; var want = {}; out.rows.forEach(function (r) { if (r.poNo) want[r.poNo] = 1; });
    DB.snap.po.forEach(function (p) { if (want[p.poNo] && p.origin && !origins[p.poNo]) origins[p.poNo] = p.origin; });
    out.extra = { origins: origins };
    return out;
  }

  function purchaseItems(q) {
    var f = q.get("from"), t = q.get("to"), v = nz(q.get("vendor")).trim(), k = low(q.get("kw")).trim();
    var rows = DB.snap.purItems.filter(function (r) {
      if (!r.buyDate || !inRange(r.buyDate, f, t)) return false;
      if (v && nz(r.vendor).trim() !== v) return false;
      return !k || low(r.vendor).indexOf(k) >= 0 || low(r.item).indexOf(k) >= 0 || low(r.spec).indexOf(k) >= 0 || low(r.poNo).indexOf(k) >= 0;
    });
    return { rows: rows, total: rows.length, truncated: false, sums: { supply: sum(rows, "supply"), tax: sum(rows, "tax"), price: sum(rows, "price") } };
  }

  function goodsList(q) {
    var f = q.get("from"), t = q.get("to"), k = low(q.get("kw")).trim();
    var rows = (bool(q.get("withCancelled")) ? DB.snap.goods : DB.snap.goodsAll).filter(function (g) {
      if ((f || t) && !inRange(g.registeredAt, f, t)) return false;
      if (!k) return true;
      return low(g.code).indexOf(k) >= 0 || low(g.productName).indexOf(k) >= 0 || low(g.spec).indexOf(k) >= 0
        || low(g.customer).indexOf(k) >= 0 || low(g.orderNo).indexOf(k) >= 0 || (/^\d{1,5}$/.test(k) && String(g.seq) === k);
    });
    var out = paged(rows, q, null); out.total = rows.length; return out;
  }

  function goodsFind(q) {
    var raw = nz(q.get("q")).trim(), k = raw.toLowerCase();
    var list = !k ? [] : DB.snap.goodsAll.filter(function (g) { return /^\d{1,5}$/.test(k) ? String(g.seq) === k : low(g.code).indexOf(k) >= 0; }).slice(0, 50);
    return { q: raw, card: null, list: list };
  }

  /* ── 자동완성 ── */
  function uniq(a) { var s = {}, o = []; a.forEach(function (x) { x = nz(x).trim(); if (x && !s[x]) { s[x] = 1; o.push(x); } }); return o; }
  function suggest(kind, field, kw) {
    var k = low(kw).trim(); if (!k) return [];
    var vals = [];
    if (kind === "orders") {
      var all = DB.snap.orders.order.concat(DB.snap.orders.estimate);
      all.forEach(function (r) {
        if (field === "no") vals.push(r.orderNo);
        else if (field === "estimateNo") vals.push(r.estimateNo);
        else if (field === "customer") vals.push(r.customer);
        else if (field === "registrant") vals.push(r.registrant);
        else if (field === "item") (r.items || []).forEach(function (i) { vals.push(i.name); });
        else if (field === "itemNo") (r.items || []).forEach(function (i) { (i.goods || []).forEach(function (g) { vals.push(g); }); });
      });
    } else {
      DB.snap.collections.forEach(function (r) { vals.push(r[field]); });
    }
    return uniq(vals).filter(function (v) { return v.toLowerCase().indexOf(k) >= 0; }).slice(0, 30);
  }

  /* ── 묶음 조회 ── */
  function batch(name, keys, keyFn) {
    var out = {}, P = DB.per[name] || {};
    keys.forEach(function (k) { var v = P[keyFn ? keyFn(k) : k]; if (v !== undefined) out[k] = clone(v); });
    return out;
  }
  function rangeKey(per, name, f, t) {
    var P = DB.per[per] || {}, key = name + "|" + (f || "") + "|" + (t || "");
    if (P[key] !== undefined) return P[key];
    /* 같은 거래처의 가장 가까운 기간 */
    var best = null, bd = 1e9;
    Object.keys(P).forEach(function (k) {
      var p = k.split("|"); if (p[0] !== name) return;
      var dd = Math.abs(daysBetween(p[1] || "2000-01-01", f || "2000-01-01")) + Math.abs(daysBetween(p[2] || TODAY, t || TODAY));
      if (dd < bd) { bd = dd; best = k; }
    });
    return best ? P[best] : undefined;
  }

  /* ── 검색어 거르기 (keyword / q 가 붙은 일반 조회) ── */
  function textOf(o) { if (o == null) return ""; if (typeof o !== "object") return String(o); var s = ""; for (var k in o) { var v = o[k]; if (v != null && typeof v !== "object") s += " " + v; } return s; }
  function filterBy(data, kw) {
    var k = low(kw).trim(); if (!k) return data;
    var f = function (a) { return a.filter(function (x) { return low(textOf(x)).indexOf(k) >= 0; }); };
    if (Array.isArray(data)) return f(data);
    if (data && typeof data === "object") {
      var o = clone(data);
      ["rows", "list", "content", "items", "orders"].forEach(function (key) { if (Array.isArray(o[key])) o[key] = f(o[key]); });
      if (Array.isArray(o.rows) && typeof o.total === "number") o.total = o.rows.length;
      if (Array.isArray(o.content) && typeof o.totalElements === "number") o.totalElements = o.content.length;
      return o;
    }
    return data;
  }

  /* ── 가장 가까운 기록 ── */
  function nearest(path, q) {
    var best = null, bs = -1e9, F = DB.fixed;
    for (var key in F) {
      var i = key.indexOf("?"), p = i < 0 ? key : key.slice(0, i);
      if (p !== path) continue;
      var kp = new URLSearchParams(i < 0 ? "" : key.slice(i + 1)), s = 0;
      q.forEach(function (v, k) {
        var w = kp.get(k);
        if (w === null) { s -= 1; return; }
        if (w === v) { s += 10; return; }
        if (/^\d{4}-\d{2}(-\d{2})?$/.test(v) && /^\d{4}-\d{2}(-\d{2})?$/.test(w)) s += 5 - Math.min(5, Math.abs(daysBetween((w + "-01").slice(0, 10), (v + "-01").slice(0, 10))) / 30);
      });
      kp.forEach(function (v, k) { if (q.get(k) === null) s -= 1; });
      if (s > bs) { bs = s; best = key; }
    }
    return best ? F[best] : undefined;
  }

  /* ── 저장 흉내 (사용자 설정·즐겨찾기만 이 창에서 기억) ── */
  var LOCAL = {};
  var WRITE_RESULT = { id: 0, orderNo: "C-DEMO", estimateNo: "E-DEMO", poNo: "O-DEMO", invoiceNo: "DEMO", asNo: "A-DEMO" };

  var toastAt = 0;
  function toast() {
    if (Date.now() - toastAt < 4000) return; toastAt = Date.now();
    try {
      var el = document.createElement("div");
      el.textContent = "데모 사이트라서 등록·수정·삭제 내용은 실제로 저장되지 않습니다";
      el.style.cssText = "position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647;background:#111827;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:10px 16px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.3)";
      document.body.appendChild(el); setTimeout(function () { el.remove(); }, 3500);
    } catch (e) { /* 무시 */ }
  }

  var MISSES = window.__mockMisses = [];

  function route(method, u, body) {
    var path = decodeURIComponent(u.pathname), q = u.searchParams;
    /* 로그인 */
    if (path === "/api/auth/login") return { accessToken: TOKEN, refreshToken: TOKEN, user: clone(DB.fixed["/api/auth/me"]) };
    if (path === "/api/auth/refresh") return { accessToken: TOKEN };
    if (path === "/api/auth/logout") return {};
    if (method !== "GET") {
      if (path === "/api/me/favorites" || path === "/api/me/settings") { LOCAL[path] = body; return body; }
      if (path.indexOf("/api/me/") === 0 || path.indexOf("/api/chat/") === 0) return {};
      toast();
      if (/^\/api\/inventory\/(\d+\/delete|producible|bom|ensure)$/.test(path)) return [];
      if (/^\/api\/orders\/[^/]+\/(sales|production)$/.test(path) || path === "/api/attendance/employees") return 0;
      return clone(WRITE_RESULT);
    }
    if (LOCAL[path] !== undefined) return clone(LOCAL[path]);

    switch (path) {
      case "/api/orders/page": return ordersPage(q);
      case "/api/as/page": return asPage(q);
      case "/api/collections/page": return collectionsPage(q);
      case "/api/fund/entries/page": return fundPage(q);
      case "/api/purchase/orders/page": return poPage(q);
      case "/api/purchase/purchases/page": return purchasesPage(q);
      case "/api/purchase/purchases/items": return purchaseItems(q);
      case "/api/goods/list": return goodsList(q);
      case "/api/goods/find": return goodsFind(q);
      case "/api/receivables/customer-summary/batch": return batch("customer-summary", q.getAll("name"));
      case "/api/receivables/tax-source/batch": return batch("tax-source", q.getAll("partner"));
      case "/api/inventory/batch": return batch("inventory", q.getAll("ids"));
      case "/api/goods/order/batch": return batch("goods-order", q.getAll("ids"));
      case "/api/memos/batch": return batch("memos", q.getAll("docIds"));
      case "/api/attachments/batch": { var o = {}; q.getAll("refIds").forEach(function (i) { o[i] = []; }); return o; }
      case "/api/receivables/as-links/batch": return batch("as-links", q.getAll("id"));
      case "/api/receivables/ledger/batch": case "/api/purchase/ledger/vendor/range/batch": {
        var per = path.indexOf("receivables") > 0 ? "ledger" : "vendor-range", out = {};
        q.getAll("name").forEach(function (nm) { var v = rangeKey(per, nm, q.get("from"), q.get("to")); if (v !== undefined) out[nm] = clone(v); });
        return out;
      }
      case "/api/purchase/ledger/vendor/batch": {
        var out2 = {};
        q.getAll("name").forEach(function (nm) { var v = rangeKey("vendor", nm, q.get("from"), "") ; if (v !== undefined) out2[nm] = clone(v); });
        return out2;
      }
    }
    var m = path.match(/^\/api\/(orders|collections)\/suggest\/(\w+)$/);
    if (m) return suggest(m[1], m[2], q.get("keyword"));
    if (path === "/api/as/order-lookup") {
      var k = low(q.get("q")).trim();
      var ords = !k ? [] : DB.snap.orders.order.filter(function (r) { return low(r.orderNo).indexOf(k) >= 0 || low(r.customer).indexOf(k) >= 0 || low(r.phone).indexOf(k) >= 0; }).slice(0, 30);
      return { q: q.get("q"), orders: clone(ords) };
    }

    var key = norm(u);
    if (DB.fixed[key] !== undefined) return clone(DB.fixed[key]);
    /* 검색어가 붙은 조회 — 검색어 없이 받은 것에서 거른다 */
    var kwName = ["keyword", "q", "kw", "search"].filter(function (x) { return q.get(x) != null; })[0];
    if (kwName) {
      var q2 = new URLSearchParams(q); var kwv = q2.get(kwName); q2.set(kwName, "");
      var u2 = new URL(u.pathname + "?" + q2.toString(), location.origin);
      var base = DB.fixed[norm(u2)];
      if (base === undefined) { q2.delete(kwName); u2 = new URL(u.pathname + (q2.toString() ? "?" + q2.toString() : ""), location.origin); base = DB.fixed[norm(u2)]; }
      if (base === undefined) base = nearest(path, q2);
      if (base !== undefined) return filterBy(clone(base), kwv);
    }
    var near = nearest(path, q);
    if (near !== undefined) return clone(near);
    MISSES.push(key);
    if (window.console) console.warn("[demo] 기록 없는 조회:", key);
    return [];
  }

  /* ── fetch 가로채기 ── */
  function jsonRes(data, status) {
    return new Response(JSON.stringify({ success: true, data: data }), { status: status || 200, headers: { "Content-Type": "application/json" } });
  }
  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === "string" ? input : (input && input.url) || String(input);
    var u;
    try { u = new URL(url, location.origin); } catch (e) { return realFetch(input, init); }
    if (u.origin !== location.origin || u.pathname.indexOf("/api/") !== 0) return realFetch(input, init);
    var method = (init.method || (input && input.method) || "GET").toUpperCase();
    /* 메신저 실시간 연결 — 열어 두기만 하고 아무것도 보내지 않는다 */
    if (u.pathname === "/api/chat/stream") {
      return Promise.resolve(new Response(new ReadableStream({ start: function (c) {
        if (init.signal) init.signal.addEventListener("abort", function () { try { c.error(new DOMException("Aborted", "AbortError")); } catch (e) { /* 무시 */ } });
      } }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    }
    if (u.pathname === "/api/chat/wait") {
      return new Promise(function (res) { setTimeout(function () { res(jsonRes([])); }, 25000); });
    }
    if (u.pathname.indexOf("/api/public/") === 0 && !DB) { /* 아래에서 처리 */ }
    var body; try { body = init.body ? JSON.parse(init.body) : undefined; } catch (e) { body = undefined; }
    return ready.then(function () {
      var data;
      try { data = route(method, u, body); }
      catch (e) { console.error("[demo] 모의 응답 오류", u.pathname, e); data = []; }
      return new Promise(function (res) { setTimeout(function () { res(jsonRes(data)); }, 60 + Math.random() * 120); });
    });
  };

  /* ── 로그아웃·비밀번호 단추 숨기기 (로그인 없는 데모) ── */
  var css = document.createElement("style");
  css.textContent = ".demo-hide{display:none!important}";
  document.documentElement.appendChild(css);
  function hideAuthButtons() {
    var bs = document.querySelectorAll("button");
    for (var i = 0; i < bs.length; i++) {
      var t = (bs[i].innerText || "").trim();
      if (t === "로그아웃" || /^🔑\s*비밀번호$/.test(t) || t === "비밀번호") bs[i].classList.add("demo-hide");
    }
  }
  new MutationObserver(function () { hideAuthButtons(); }).observe(document.documentElement, { childList: true, subtree: true });
  /* 혹시 로그인 화면이 뜨면(토큰이 지워진 경우) 다시 넣고 새로 고침 */
  window.addEventListener("hderp:unauthorized", function () {
    try { localStorage.setItem("hderp_at", TOKEN); localStorage.setItem("hderp_rt", TOKEN); } catch (e) { /* 무시 */ }
    setTimeout(function () { location.reload(); }, 50);
  });
})();
