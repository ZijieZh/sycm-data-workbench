const demoData = {
  month: {
    label: "8月自然月",
    kpis: [
      ["支付金额", "¥ 8,421,680", "+12.8% 同比"],
      ["净支付金额", "¥ 7,906,430", "+10.4% 同比"],
      ["累加访客", "1,286,420", "+6.3% 同比"],
      ["累加买家", "28,640", "+8.7% 同比"],
      ["支付转化率", "2.23%", "+0.05个百分点"],
    ],
    current: [19, 22, 20, 27, 25, 31, 29, 35, 33, 39, 37, 43, 48, 44, 51, 49, 56, 54, 61, 57, 65, 63, 71, 68, 76, 73, 82, 79, 88, 85, 94],
    previous: [17, 18, 19, 21, 22, 24, 23, 27, 28, 29, 31, 33, 32, 36, 37, 38, 40, 42, 43, 45, 46, 47, 50, 52, 53, 55, 57, 58, 60, 62, 64],
    mix: [38, 29, 20, 13],
  },
  "30d": {
    label: "近30天",
    kpis: [
      ["支付金额", "¥ 8,106,240", "+11.6% 同比"],
      ["净支付金额", "¥ 7,588,910", "+9.8% 同比"],
      ["累加访客", "1,231,870", "+5.9% 同比"],
      ["累加买家", "27,950", "+8.1% 同比"],
      ["支付转化率", "2.27%", "+0.04个百分点"],
    ],
    current: [21, 23, 19, 26, 28, 31, 27, 35, 34, 40, 38, 42, 47, 45, 50, 52, 54, 58, 61, 60, 67, 65, 70, 74, 72, 80, 78, 85, 83, 91],
    previous: [18, 19, 18, 22, 24, 23, 25, 27, 29, 30, 31, 34, 35, 36, 38, 39, 41, 43, 45, 46, 48, 49, 51, 52, 55, 56, 58, 60, 62, 64],
    mix: [36, 30, 21, 13],
  },
  "7d": {
    label: "近7天",
    kpis: [
      ["支付金额", "¥ 2,146,820", "+18.2% 同比"],
      ["净支付金额", "¥ 2,008,450", "+16.7% 同比"],
      ["累加访客", "305,740", "+9.4% 同比"],
      ["累加买家", "7,460", "+13.1% 同比"],
      ["支付转化率", "2.44%", "+0.08个百分点"],
    ],
    current: [56, 63, 59, 72, 68, 81, 92],
    previous: [47, 50, 52, 55, 58, 61, 64],
    mix: [41, 27, 19, 13],
  },
};

const seriesScale = { all: 1, premium: 0.38, core: 0.29 };
const mixNames = ["高端系列", "核心系列", "有机系列", "其他系列"];
const palette = ["#0e7c72", "#e9583f", "#3d6de7", "#f1c94d"];

function compactCurrency(value) {
  const parsed = Number(String(value).replace(/[^0-9.]/g, ""));
  const prefix = String(value).includes("¥") ? "¥ " : "";
  if (parsed > 1000000) return `${prefix}${(parsed / 1000000).toFixed(2)}M`;
  if (parsed > 1000) return `${prefix}${(parsed / 1000).toFixed(1)}K`;
  return `${prefix}${Math.round(parsed).toLocaleString()}`;
}

function scaledKpis(data, series) {
  if (series === "all") return data.kpis;
  const scale = seriesScale[series];
  return data.kpis.map((item, index) => {
    if (index === 4) return item;
    const value = item[1].replace(/[^0-9.]/g, "");
    return [item[0], compactCurrency(Number(value) * scale), item[2]];
  });
}

function renderKpis(data, series) {
  document.querySelector("#kpi-row").innerHTML = scaledKpis(data, series).map(([name, value, delta]) => `
    <div class="kpi-card"><span>${name}</span><b>${value}</b><em class="${delta.startsWith("-") ? "down" : ""}">${delta}</em></div>
  `).join("");
}

function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function drawLine(context, values, width, height, color, max, padding) {
  const step = (width - padding * 2) / Math.max(1, values.length - 1);
  context.beginPath();
  values.forEach((value, index) => {
    const x = padding + index * step;
    const y = height - padding - (value / max) * (height - padding * 2);
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.lineWidth = 2;
  context.strokeStyle = color;
  context.stroke();
}

function drawTrend(data, series) {
  const canvas = document.querySelector("#trend-chart");
  const { context, width, height } = fitCanvas(canvas);
  context.clearRect(0, 0, width, height);
  const scale = seriesScale[series];
  const current = data.current.map((value) => value * scale);
  const previous = data.previous.map((value) => value * scale);
  const max = Math.max(...current, ...previous) * 1.15;
  const padding = 28;
  context.strokeStyle = "#e6e8e4";
  context.lineWidth = 1;
  for (let row = 0; row < 4; row += 1) {
    const y = padding + row * ((height - padding * 2) / 3);
    context.beginPath(); context.moveTo(padding, y); context.lineTo(width - padding, y); context.stroke();
  }
  drawLine(context, previous, width, height, "#c7ccc8", max, padding);
  drawLine(context, current, width, height, "#0e7c72", max, padding);
  const last = current[current.length - 1];
  const x = width - padding;
  const y = height - padding - (last / max) * (height - padding * 2);
  context.beginPath(); context.arc(x, y, 4, 0, Math.PI * 2); context.fillStyle = "#e9583f"; context.fill();
}

function drawMix(data, series) {
  const canvas = document.querySelector("#mix-chart");
  const { context, width, height } = fitCanvas(canvas);
  context.clearRect(0, 0, width, height);
  let values = [...data.mix];
  if (series !== "all") values = series === "premium" ? [100, 0, 0, 0] : [0, 100, 0, 0];
  const total = values.reduce((sum, value) => sum + value, 0);
  const radius = Math.min(width, height) * .3;
  const cx = width / 2;
  const cy = height / 2;
  let start = -Math.PI / 2;
  values.forEach((value, index) => {
    if (!value) return;
    const end = start + (value / total) * Math.PI * 2;
    context.beginPath(); context.arc(cx, cy, radius, start, end); context.arc(cx, cy, radius * .58, end, start, true); context.closePath(); context.fillStyle = palette[index]; context.fill();
    start = end;
  });
  context.fillStyle = "#26342f"; context.textAlign = "center"; context.font = "700 20px IBM Plex Sans, sans-serif"; context.fillText("100%", cx, cy + 2);
  context.fillStyle = "#8b948f"; context.font = "9px IBM Plex Sans, sans-serif"; context.fillText("支付金额", cx, cy + 18);
  document.querySelector("#mix-legend").innerHTML = values.map((value, index) => `
    <div><span><i style="background:${palette[index]}"></i>${mixNames[index]}</span><b>${value}%</b></div>
  `).join("");
}

function renderInsights(series) {
  const subject = series === "premium" ? "高端系列" : series === "core" ? "核心系列" : "全店";
  const insights = [
    ["增长来源", `${subject}支付金额同比提升，买家规模贡献高于客单价贡献。`],
    ["结构变化", "大规格组合占比提升 3.2 个百分点，是本期主要正向结构。"],
    ["风险提醒", "自然搜索访客增速低于成交增速，需继续观察流量承接。"],
    ["建议动作", "周会优先复盘高增长组合，并核查两个下滑商品的流量来源。"],
  ];
  document.querySelector("#insight-list").innerHTML = insights.map(([title, text]) => `<div class="insight"><b>${title}</b>${text}</div>`).join("");
}

const attributionRows = [
  ["高端系列 × 6罐 × 新客", "¥ 1,486,200", "+26.8%", 100, "+¥ 314,000"],
  ["核心系列 × 2罐 × 老客", "¥ 1,126,800", "+14.2%", 64, "+¥ 140,000"],
  ["有机系列 × 单罐 × 新客", "¥ 842,600", "+8.4%", 37, "+¥ 65,000"],
  ["核心系列 × 单罐 × 新客", "¥ 693,400", "-9.7%", -31, "-¥ 74,000"],
  ["其他系列 × 2罐 × 老客", "¥ 428,900", "-16.3%", -46, "-¥ 83,000"],
];

const productRows = [
  ["旗舰配方奶粉 6罐装", "高端系列", "¥ 986,420", "+34.5%", "增长主力"],
  ["经典配方奶粉 2罐装", "核心系列", "¥ 724,860", "+11.8%", "稳定贡献"],
  ["有机配方奶粉 单罐", "有机系列", "¥ 506,300", "+8.2%", "客单提升"],
  ["经典配方奶粉 单罐", "核心系列", "¥ 342,180", "-12.4%", "流量下滑"],
  ["试用装组合", "其他系列", "¥ 116,520", "-18.9%", "转化承压"],
];

function renderTables() {
  document.querySelector("#attribution-body").innerHTML = attributionRows.map(([name, gmv, growth, width, contribution]) => `
    <tr><td>${name}</td><td>${gmv}</td><td><b style="color:${growth.startsWith("-") ? "#e9583f" : "#0e7c72"}">${growth}</b></td><td>${contribution}</td><td class="bar-cell"><i class="mini-bar ${width < 0 ? "negative" : ""}" style="width:${Math.abs(width)}px"></i>${Math.abs(width)}%</td></tr>
  `).join("");
  document.querySelector("#product-body").innerHTML = productRows.map(([name, series, gmv, growth, diagnosis], index) => `
    <tr><td><b>SPU-DEMO-${String(index + 1).padStart(3, "0")}</b><br>${name}</td><td>${series}</td><td>${gmv}</td><td style="color:${growth.startsWith("-") ? "#e9583f" : "#0e7c72"}">${growth}</td><td>${diagnosis}</td></tr>
  `).join("");
}

function refreshDashboard() {
  const period = document.querySelector("#period-select").value;
  const series = document.querySelector("#series-select").value;
  const data = demoData[period];
  renderKpis(data, series);
  drawTrend(data, series);
  drawMix(data, series);
  renderInsights(series);
}

document.querySelectorAll(".bi-nav button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".bi-nav button").forEach((item) => { item.classList.remove("active"); item.setAttribute("aria-selected", "false"); });
    document.querySelectorAll(".bi-view").forEach((panel) => panel.classList.remove("active"));
    button.classList.add("active"); button.setAttribute("aria-selected", "true");
    document.querySelector(`[data-panel="${button.dataset.view}"]`).classList.add("active");
    const titles = { overview: ["经营总览", "核心结果与增长来源"], attribution: ["多维归因", "结构变化与贡献拆解"], products: ["商品诊断", "商品明细与问题定位"], governance: ["数据治理", "覆盖、质量与审计状态"] };
    document.querySelector("#bi-kicker").textContent = titles[button.dataset.view][0];
    document.querySelector("#bi-title").textContent = titles[button.dataset.view][1];
  });
});

document.querySelector("#period-select").addEventListener("change", refreshDashboard);
document.querySelector("#series-select").addEventListener("change", refreshDashboard);
window.addEventListener("resize", () => requestAnimationFrame(refreshDashboard));

renderTables();
refreshDashboard();
