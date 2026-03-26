const STATION = "SFB1203";
const BASE = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

/** Calendar span: 7 days before through 45 days after today (Pacific). */
const CALENDAR_DAY_MIN = -7;
const CALENDAR_DAY_MAX = 45;
/** Chronological left→right: past days, today, future. Initial scroll shows today; scroll left for older days. */
const CALENDAR_DAY_OFFSETS = Array.from({ length: CALENDAR_DAY_MAX - CALENDAR_DAY_MIN + 1 }, (_, i) => i + CALENDAR_DAY_MIN);
/** Full span in hours + buffer so edge Pacific days aren’t cut off (slack + merged hourly). */
const TOTAL_RANGE_HOURS = (CALENDAR_DAY_MAX - CALENDAR_DAY_MIN + 1) * 24 + 72;
/** NOAA hourly currents_predictions: max ~1 month per request; fetch in chunks and merge. */
const HOURLY_CHUNK_MAX_HOURS = 720;
/** Predicted speed below this → show Slack (tight so it is uncommon). */
const TRUE_SLACK_KT = 0.03;

/** Pacific local hour (0–23): typical good-wind window 2 PM – 7 PM. */
const WIND_WINDOW_H_START = 14;
const WIND_WINDOW_H_END = 19;

function pacificDatePartsWithOffset(dayOffset) {
  const t = new Date(Date.now() + dayOffset * 86400000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(t);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return { y, m, d, keyDashed: `${y}-${m}-${d}`, keyCompact: `${y}${m}${d}` };
}

function pacificYYYYMMDD() {
  return pacificDatePartsWithOffset(0).keyCompact;
}

function pacificDateKeyFromDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

function formatPacificWeekdayShort(dayOffset) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
  }).format(new Date(Date.now() + dayOffset * 86400000));
}

function formatPacificMonthDay(dayOffset) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.now() + dayOffset * 86400000));
}

function formatTodayLongPacific() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

function parseGmtTime(timeStr) {
  const iso = `${timeStr.replace(" ", "T")}:00Z`;
  return new Date(iso);
}

function formatPacific(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatPacificTimeParts(date) {
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "short",
  }).formatToParts(date);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value || "";
  return { time, tz };
}

function pacificHourOfDay(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const hp = parts.find((p) => p.type === "hour");
  return hp ? parseInt(hp.value, 10) : 0;
}

function formatHourLabel12(h) {
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const ap = h < 12 ? "AM" : "PM";
  return `${hour12} ${ap}`;
}

function buildHourlyByDayHourMap(hourly) {
  const byDay = new Map();
  for (const row of hourly) {
    const d = parseGmtTime(row.Time);
    const dayKey = pacificDateKeyFromDate(d);
    const hour = pacificHourOfDay(d);
    const v = Number(row.Velocity_Major);
    if (!byDay.has(dayKey)) byDay.set(dayKey, new Map());
    byDay.get(dayKey).set(hour, v);
  }
  return byDay;
}

function collectMaxFloodEbbForDays(byDay, dayKeys) {
  let maxF = 0;
  let maxE = 0;
  for (const dk of dayKeys) {
    const hm = byDay.get(dk);
    if (!hm) continue;
    for (let h = 0; h < 24; h++) {
      const v = hm.get(h);
      if (v === undefined) continue;
      if (v > maxF) maxF = v;
      if (v < 0) {
        const mag = Math.abs(v);
        if (mag > maxE) maxE = mag;
      }
    }
  }
  return { maxF, maxE };
}

function mixRgb(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

/** Flood = muted red, ebb = muted green; stronger emphasis near peak (t^1.35). */
function hourlyCellStyle(v, maxF, maxE) {
  const bgBase = { r: 19, g: 26, b: 36 };
  const floodHi = { r: 188, g: 78, b: 82 };
  const ebbHi = { r: 52, g: 138, b: 98 };
  if (v === undefined || v === null || Number.isNaN(v)) {
    return "background: #0c1118; color: #6b7a92;";
  }
  if (v > 0) {
    const t = maxF > 0 ? Math.min(1, v / maxF) : 0;
    const curve = Math.pow(t, 1.35);
    const blend = 0.02 + curve * 0.94;
    const m = mixRgb(bgBase, floodHi, blend);
    const alpha = 0.34 + curve * 0.58;
    return `background: rgba(${m.r},${m.g},${m.b},${alpha}); color: #f2e8e8;`;
  }
  const mag = Math.abs(v);
  const t = maxE > 0 ? Math.min(1, mag / maxE) : 0;
  const curve = Math.pow(t, 1.35);
  const blend = 0.02 + curve * 0.94;
  const m = mixRgb(bgBase, ebbHi, blend);
  const alpha = 0.34 + curve * 0.58;
  return `background: rgba(${m.r},${m.g},${m.b},${alpha}); color: #e8f2ec;`;
}

/** True when speed is in the top ~15% of flood or ebb range for this table (peaks pop in UI). */
function isNearPeakCurrent(v, maxF, maxE) {
  if (v === undefined || v === null || Number.isNaN(v)) return false;
  const peakRatio = 0.85;
  if (v > 0 && maxF > 0) return v / maxF >= peakRatio;
  if (v < 0 && maxE > 0) return Math.abs(v) / maxE >= peakRatio;
  return false;
}

function phaseFromVelocity(v) {
  if (Math.abs(v) < TRUE_SLACK_KT) return "slack";
  return v > 0 ? "flood" : "ebb";
}

function approxCompass(deg) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(Number(deg) / 45) % 8;
  return dirs[idx];
}

function predictedNowDirectionText(v, sample) {
  const phase = phaseFromVelocity(v);
  if (phase === "slack") {
    return "Direction: transitioning (slack water)";
  }
  const deg = phase === "flood" ? sample.meanFloodDir : sample.meanEbbDir;
  if (deg === undefined || deg === null || Number.isNaN(Number(deg))) {
    return "Direction: —";
  }
  const flow = phase === "flood" ? "flood" : "ebb";
  return `Mean ${flow} flow ${deg}° (${approxCompass(deg)})`;
}

function evType(ev) {
  return (ev.Type || "").toLowerCase();
}

/**
 * Four cycle states from MAX_SLACK timeline (flood builds → eases → ebb builds → eases),
 * plus "Slack" only when predicted speed is ~true slack.
 */
function predictedNowCycleLabel(now, sortedEvents, v) {
  if (Number.isFinite(v) && Math.abs(v) < TRUE_SLACK_KT) return "Slack";

  if (!sortedEvents?.length) {
    return v > 0 ? "Flood Building" : "Ebb Building";
  }

  const tNow = now.getTime();
  const tAt = (i) => parseGmtTime(sortedEvents[i].Time).getTime();

  if (sortedEvents.length === 1) {
    const L = evType(sortedEvents[0]);
    if (L === "flood") return "Flood Easing";
    if (L === "ebb") return "Ebb Easing";
    return v > 0 ? "Flood Building" : "Ebb Building";
  }

  if (tNow < tAt(0)) {
    const L = evType(sortedEvents[0]);
    const R = evType(sortedEvents[1]);
    if (L === "slack" && R === "flood") return "Ebb Easing";
    if (L === "slack" && R === "ebb") return "Flood Easing";
    if (L === "flood") return "Flood Building";
    if (L === "ebb") return "Ebb Building";
    return v > 0 ? "Flood Building" : "Ebb Building";
  }

  const lastIdx = sortedEvents.length - 1;
  if (tNow >= tAt(lastIdx)) {
    const L = evType(sortedEvents[lastIdx]);
    if (L === "slack" && lastIdx >= 1) {
      const prevT = evType(sortedEvents[lastIdx - 1]);
      if (prevT === "ebb") return "Flood Building";
      if (prevT === "flood") return "Ebb Building";
    }
    if (L === "flood") return "Flood Easing";
    if (L === "ebb") return "Ebb Easing";
    return v > 0 ? "Flood Building" : "Ebb Building";
  }

  for (let k = 0; k < lastIdx; k++) {
    const t0 = tAt(k);
    const t1 = tAt(k + 1);
    if (tNow >= t0 && tNow < t1) {
      const L = evType(sortedEvents[k]);
      const R = evType(sortedEvents[k + 1]);
      if (L === "slack" && R === "flood") return "Flood Building";
      if (L === "flood" && R === "slack") return "Flood Easing";
      if (L === "slack" && R === "ebb") return "Ebb Building";
      if (L === "ebb" && R === "slack") return "Ebb Easing";
      return v > 0 ? "Flood Building" : "Ebb Building";
    }
  }

  return v > 0 ? "Flood Building" : "Ebb Building";
}

function phaseClassForCycleLabel(label) {
  if (label === "Slack") return "today-now__phase--slack";
  if (label.startsWith("Flood")) return "today-now__phase--flood";
  if (label.startsWith("Ebb")) return "today-now__phase--ebb";
  return "today-now__phase--flood";
}

function interpolateVelocity(now, series) {
  if (!series.length) return null;
  const t = now.getTime();
  const pts = series
    .map((p) => ({
      t: parseGmtTime(p.Time).getTime(),
      v: Number(p.Velocity_Major),
      raw: p,
    }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return null;
  if (t <= pts[0].t) {
    return { value: pts[0].v, sample: pts[0].raw };
  }
  if (t >= pts[pts.length - 1].t) {
    const last = pts[pts.length - 1];
    return { value: last.v, sample: last.raw };
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (t >= a.t && t <= b.t) {
      const frac = (t - a.t) / (b.t - a.t);
      const value = a.v + frac * (b.v - a.v);
      return { value, sample: frac < 0.5 ? a.raw : b.raw };
    }
  }
  return null;
}

function showError(msg) {
  const banner = document.getElementById("errorBanner");
  if (banner) {
    banner.textContent = msg;
    banner.hidden = false;
  }
  const el = document.getElementById("errorToast");
  if (el) {
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(showError._t);
    showError._t = setTimeout(() => {
      el.hidden = true;
    }, 12000);
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("NOAA returned a non-JSON response. Try again later.");
  }
  if (!res.ok) throw new Error(data?.error?.message || res.statusText || "Request failed");
  if (data.error) throw new Error(data.error.message || "API error");
  return data;
}

function buildUrl(product, interval, range, beginDate) {
  const params = new URLSearchParams({
    begin_date: beginDate ?? pacificYYYYMMDD(),
    range: String(range),
    station: STATION,
    product,
    units: "english",
    time_zone: "gmt",
    interval,
    format: "json",
  });
  return `${BASE}?${params}`;
}

function mergeHourlyPredictions(rows) {
  const byTime = new Map();
  for (const row of rows) {
    if (row?.Time) byTime.set(row.Time, row);
  }
  return Array.from(byTime.values()).sort((a, b) => parseGmtTime(a.Time) - parseGmtTime(b.Time));
}

async function fetchHourlyCurrentsMerged() {
  let offset = CALENDAR_DAY_MIN;
  let hoursLeft = TOTAL_RANGE_HOURS;
  const chunks = [];
  while (hoursLeft > 0) {
    const h = Math.min(HOURLY_CHUNK_MAX_HOURS, hoursLeft);
    const begin = pacificDatePartsWithOffset(offset).keyCompact;
    const data = await fetchJson(buildUrl("currents_predictions", "60", h, begin));
    const cp = data.current_predictions?.cp;
    if (cp?.length) chunks.push(...cp);
    hoursLeft -= h;
    offset += Math.floor(h / 24);
    if (hoursLeft > 0) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return mergeHourlyPredictions(chunks);
}

function sortSlackCp(slack) {
  if (!slack?.length) return [];
  return [...slack].sort((a, b) => parseGmtTime(a.Time) - parseGmtTime(b.Time));
}

function eventLabel(ev, nextEv) {
  const t = (ev.Type || "").toLowerCase();
  if (t === "flood") return "Max Flood";
  if (t === "ebb") return "Max Ebb";
  if (t === "slack") {
    const nt = nextEv ? (nextEv.Type || "").toLowerCase() : "";
    if (nt === "flood") return "Slack, Flood Begins";
    if (nt === "ebb") return "Slack, Ebb Begins";
    return "Slack";
  }
  return t || "Event";
}

function iconKindFromEv(ev, nextEv) {
  const t = (ev.Type || "").toLowerCase();
  if (t === "flood") return "max-flood";
  if (t === "ebb") return "max-ebb";
  if (t === "slack") {
    const nt = nextEv ? (nextEv.Type || "").toLowerCase() : "";
    if (nt === "flood") return "slack-flood";
    if (nt === "ebb") return "slack-ebb";
    return "slack";
  }
  return "max-flood";
}

function eventIconSvg(kind) {
  const s = "stroke=\"currentColor\" fill=\"none\" stroke-width=\"1.65\" stroke-linecap=\"round\" stroke-linejoin=\"round\"";
  const wrap = (inner) =>
    `<svg class="event-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">${inner}</svg>`;
  if (kind === "max-flood") {
    return wrap(`<circle cx="12" cy="12" r="9" ${s}/><path d="M12 16V8M9 11l3-3 3 3" ${s}/>`);
  }
  if (kind === "max-ebb") {
    return wrap(`<circle cx="12" cy="12" r="9" ${s}/><path d="M12 8v8M9 13l3 3 3-3" ${s}/>`);
  }
  if (kind === "slack-flood") {
    return wrap(`<line x1="5" y1="14" x2="19" y2="14" ${s}/><path d="M12 14V8M9 11l3-3 3 3" ${s}/>`);
  }
  if (kind === "slack-ebb") {
    return wrap(`<line x1="5" y1="10" x2="19" y2="10" ${s}/><path d="M12 10v6M9 13l3 3 3-3" ${s}/>`);
  }
  return wrap(`<circle cx="12" cy="12" r="9" ${s}/>`);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createEventRow(ev, nextEv, { highlight }) {
  const kind = iconKindFromEv(ev, nextEv);
  const label = eventLabel(ev, nextEv);
  const d = parseGmtTime(ev.Time);
  const v = Number(ev.Velocity_Major);
  const { time, tz } = formatPacificTimeParts(d);
  const speedStr = `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(2)} kt`;
  const row = document.createElement("div");
  row.className = `event-row event-row--kind-${kind}${highlight ? " event-row--highlight" : ""}`;
  row.setAttribute("role", "listitem");
  const timeHtml = `<strong class="event-row__time-bold">${escapeHtml(time)}</strong> <span class="event-row__tz">${escapeHtml(tz)}</span>`;
  row.innerHTML = `
      <div class="event-row__icon">${eventIconSvg(kind)}</div>
      <div class="event-row__label">${escapeHtml(label)}</div>
      <div class="event-row__time">${timeHtml}</div>
      <div class="event-row__speed">${speedStr}</div>
    `;
  return row;
}

function highlightIndexForDay(sortedFull, dayKey, now) {
  const indices = [];
  for (let i = 0; i < sortedFull.length; i++) {
    if (pacificDateKeyFromDate(parseGmtTime(sortedFull[i].Time)) === dayKey) indices.push(i);
  }
  if (!indices.length) return null;
  const pos = indices.findIndex((i) => parseGmtTime(sortedFull[i].Time).getTime() > now.getTime());
  const chosenPos = pos === -1 ? indices.length - 1 : pos;
  return indices[chosenPos];
}

function renderTodayEventList(container, sortedFull, todayKey, now) {
  if (!container) return;
  container.replaceChildren();
  if (!sortedFull.length) {
    const p = document.createElement("p");
    p.className = "event-list-empty";
    p.textContent = "MAX_SLACK event data unavailable.";
    container.appendChild(p);
    return;
  }
  const indices = [];
  for (let i = 0; i < sortedFull.length; i++) {
    if (pacificDateKeyFromDate(parseGmtTime(sortedFull[i].Time)) === todayKey) indices.push(i);
  }
  if (!indices.length) {
    const p = document.createElement("p");
    p.className = "event-list-empty";
    p.textContent = "No slack / max events for today in this forecast window.";
    container.appendChild(p);
    return;
  }
  const hi = highlightIndexForDay(sortedFull, todayKey, now);
  indices.forEach((i) => {
    const ev = sortedFull[i];
    const nextEv = sortedFull[i + 1];
    const highlight = hi !== null && i === hi;
    container.appendChild(createEventRow(ev, nextEv, { highlight }));
  });
}

function renderHourlyWeekTable(hourly, now) {
  const host = document.getElementById("calendarGrid");
  if (!host) return;
  host.replaceChildren();

  if (!hourly?.length) {
    const p = document.createElement("p");
    p.className = "event-list-empty";
    p.textContent = "No hourly data.";
    host.appendChild(p);
    return;
  }

  const byDay = buildHourlyByDayHourMap(hourly);
  const dayKeys = CALENDAR_DAY_OFFSETS.map((o) => pacificDatePartsWithOffset(o).keyDashed);
  const { maxF, maxE } = collectMaxFloodEbbForDays(byDay, dayKeys);
  const hourNow = pacificHourOfDay(now);

  const wrap = document.createElement("div");
  wrap.className = "calendar-table-wrap";

  const table = document.createElement("table");
  table.className = "hourly-table";

  const caption = document.createElement("caption");
  caption.className = "visually-hidden";
  caption.textContent =
    "Hourly predicted current speed in knots at the top of each hour, Pacific time. About seven days of history and forty-five days ahead; scroll horizontally. The view starts on today’s column. Today’s column has a yellow outline; the current Pacific hour on today has a brighter outline. A blue box marks 2 PM–7 PM Pacific as a typical peak wind window.";
  table.appendChild(caption);

  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  const thCorner = document.createElement("th");
  thCorner.scope = "col";
  thCorner.className = "hourly-table__corner";
  thCorner.innerHTML =
    '<span class="hourly-table__corner-stack"><span class="hourly-table__corner-line">Hour</span><span class="hourly-table__corner-line hourly-table__corner-line--sub">Pacific</span></span>';
  trHead.appendChild(thCorner);

  CALENDAR_DAY_OFFSETS.forEach((off) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.className = "hourly-table__day-head";
    if (off === 0) th.classList.add("hourly-table__col-today");
    th.innerHTML = `<span class="hourly-table__th-dow">${escapeHtml(
      formatPacificWeekdayShort(off),
    )}</span><span class="hourly-table__th-dmy">${escapeHtml(formatPacificMonthDay(off))}</span>`;
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const lastDayIdx = CALENDAR_DAY_OFFSETS.length - 1;
  const tbody = document.createElement("tbody");
  for (let h = 0; h < 24; h++) {
    const tr = document.createElement("tr");
    const inWind = h >= WIND_WINDOW_H_START && h <= WIND_WINDOW_H_END;
    const thRow = document.createElement("th");
    thRow.scope = "row";
    thRow.className = "hourly-table__hour-label";
    thRow.textContent = formatHourLabel12(h);
    if (inWind) {
      thRow.classList.add("hourly-table__wind-hour");
      if (h === WIND_WINDOW_H_START) thRow.classList.add("hourly-table__wind-hour--top");
      if (h === WIND_WINDOW_H_END) thRow.classList.add("hourly-table__wind-hour--bottom");
    }
    tr.appendChild(thRow);

    CALENDAR_DAY_OFFSETS.forEach((off, dayIdx) => {
      const dk = pacificDatePartsWithOffset(off).keyDashed;
      const hm = byDay.get(dk);
      const v = hm?.get(h);
      const td = document.createElement("td");
      td.className = "hourly-table__cell";
      if (off === 0) td.classList.add("hourly-table__col-today");
      if (v !== undefined && !Number.isNaN(v)) {
        td.textContent = `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(2)}`;
        if (Math.abs(v) >= 0.05) td.classList.add("hourly-table__cell--strong");
        if (isNearPeakCurrent(v, maxF, maxE)) td.classList.add("hourly-table__cell--peak");
      } else {
        td.textContent = "—";
      }
      td.setAttribute("style", hourlyCellStyle(v, maxF, maxE));
      if (off === 0 && h === hourNow) {
        td.classList.add("hourly-table__cell--now");
      }
      if (inWind) {
        td.classList.add("hourly-table__wind-cell");
        if (h === WIND_WINDOW_H_START) td.classList.add("hourly-table__wind-cell--top");
        if (h === WIND_WINDOW_H_END) td.classList.add("hourly-table__wind-cell--bottom");
        if (dayIdx === lastDayIdx) td.classList.add("hourly-table__wind-cell--right");
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  host.appendChild(wrap);
  requestAnimationFrame(() => {
    const todayTh = wrap.querySelector("thead th.hourly-table__col-today");
    const firstDayTh = wrap.querySelector("thead th.hourly-table__day-head");
    if (todayTh && firstDayTh) {
      wrap.scrollLeft = todayTh.offsetLeft - firstDayTh.offsetLeft;
    }
  });
}

async function load() {
  const beginDate = pacificDatePartsWithOffset(CALENDAR_DAY_MIN).keyCompact;
  const slackUrl = buildUrl("currents_predictions", "MAX_SLACK", TOTAL_RANGE_HOURS, beginDate);

  const hourly = await fetchHourlyCurrentsMerged();
  let slackData = null;
  try {
    slackData = await fetchJson(slackUrl);
  } catch (slackErr) {
    console.warn("MAX_SLACK request failed:", slackErr);
  }
  const slackRaw = slackData?.current_predictions?.cp;
  if (!hourly?.length) throw new Error("No hourly current data returned.");

  const sortedFull = sortSlackCp(slackRaw);
  const now = new Date();
  const todayKey = pacificDatePartsWithOffset(0).keyDashed;

  const todayLine = document.getElementById("todayDateLine");
  if (todayLine) {
    todayLine.textContent = `${formatTodayLongPacific()} · Pacific`;
  }

  const nowStrip = document.getElementById("todayNowStrip");
  const interp = interpolateVelocity(now, hourly);
  if (nowStrip) {
    if (interp) {
      const v = interp.value;
      const phaseLine = predictedNowCycleLabel(now, sortedFull, v);
      const phaseMod = phaseClassForCycleLabel(phaseLine);
      const dirHtml = escapeHtml(predictedNowDirectionText(v, interp.sample));
      nowStrip.innerHTML = `<span class="today-now__label">Predicted now</span> <span class="today-now__speed">${Math.abs(v).toFixed(2)} kt</span> <span class="today-now__phase ${phaseMod}">${escapeHtml(phaseLine)}</span><span class="today-now__dir">${dirHtml}</span>`;
    } else {
      nowStrip.textContent = "";
    }
  }

  renderTodayEventList(document.getElementById("todayEventList"), sortedFull, todayKey, now);
  renderHourlyWeekTable(hourly, now);

  const errBanner = document.getElementById("errorBanner");
  if (errBanner) errBanner.hidden = true;

  document.getElementById("updatedLine").textContent = `Updated ${formatPacific(now)} · Pacific time`;
}

function localServerHint() {
  return " Serve this folder over HTTP (not as a file): run `python3 -m http.server 8080` here, then open http://localhost:8080/";
}

load().catch((e) => {
  console.error(e);
  let msg = e instanceof Error ? e.message : String(e);
  const isFile = typeof location !== "undefined" && location.protocol === "file:";
  const looksNet =
    /failed to fetch|networkerror|load failed|network request failed|aborted|timed out/i.test(msg);
  if (isFile) {
    msg =
      (msg ? `${msg} ` : "") +
      "Pages opened as file:// often cannot load NOAA; use a local server instead." +
      localServerHint();
  } else if (looksNet) {
    msg += localServerHint();
  }
  showError(msg || "Could not load NOAA data.");
  const todayList = document.getElementById("todayEventList");
  if (todayList) todayList.replaceChildren();
  const grid = document.getElementById("calendarGrid");
  if (grid) grid.replaceChildren();
  const todayLine = document.getElementById("todayDateLine");
  if (todayLine) todayLine.textContent = "";
  const nowStrip = document.getElementById("todayNowStrip");
  if (nowStrip) nowStrip.textContent = "";
});
