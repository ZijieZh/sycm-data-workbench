/**
 * content.js —— 唯一 DOM 操作者（在生参取数页的**同源 iframe 内**运行）
 *
 * ⚠️ 重建说明（2026-09-14）：本文件原版在"临时改一行再还原"的操作中被误删，且无 git/无备份、
 *    回收站也没有，**无法从内存/磁盘恢复**。本版本依据以下**可核验依据**重建：
 *      · 会话内已读到的原文片段（工具函数、selectRadio、日历/周/月选择器、额外筛选、executeTask 主流程）
 *      · 调用方（`background.js`）对每条消息的**响应契约**（字段名与判定条件）
 *      · 已有证据里记录的**步骤名清单**（session_manifest 的 exportEvidence.steps）与实机行为
 *    因此本文件是"**行为等价的重写**"，不是逐字节还原；重建后必须重跑门禁 + 实机回归（见 README）。
 *
 * 设计原则（源自全部实测教训，见 README「已知交互陷阱」）：
 *   1. 每个动作后**必须回读断言**，绝不假设点击生效
 *   2. 结果视图判定**不看 URL**（提交后是同 iframe 内 SPA 切换），只看「下载报表」按钮
 *   3. 指标「全部」是**双向开关**，绝不在已全选状态下再点
 *   4. 日期**不用键盘输入**，走日历点选 + 回读
 *   5. 每次轮询都检查登录/风控/禁止词，命中即停
 *   6. 本文件不含任何网络请求、不含反检测逻辑
 */

(function () {
  'use strict';

  const SR = (typeof globalThis !== 'undefined' && globalThis.SR) || null;
  if (!SR) {
    console.error('[SR] selectors.js 未加载，content.js 退出');
    return;
  }
  // 纯函数核心层（manifest 里在 content.js 之前加载）：深链接回执摘要要用它（加固②）
  const CORE = (typeof globalThis !== 'undefined' && globalThis.SRCore) || null;

  // ---------------------------------------------------------------- 幂等守卫
  // ⚠️ 内容脚本可能被重复注入（SPA 内部导航 / 扩展重载）→ 每个 realm 只装一次引擎
  const GUARD = '__srFormEngineLoadedV1';
  if (globalThis[GUARD]) return;

  // ---------------------------------------------------------------- 基础工具
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.getClientRects) return false;
    if (el.getClientRects().length === 0) return false;
    const st = el.ownerDocument.defaultView.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }

  function fire(el, type, win) {
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: win || el.ownerDocument.defaultView, button: 0,
    }));
  }

  /** 完整点击序列：本平台控件监听 mousedown，只发 click 往往无效 */
  function realClick(el, win) {
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((t) => fire(el, t, win));
  }

  const popupGuard = globalThis.SRPopupGuard && globalThis.SRPopupGuard.create(document, { click: realClick });
  let popupChecksActive = false;
  let popupSubmissionStarted = false;
  async function checkTaskPopups() {
    if (!popupChecksActive || popupSubmissionStarted) return;
    const local = popupGuard ? await popupGuard.check() : { ok: false, reason: '[弹窗阻挡]弹窗组件未加载，请刷新取数页' };
    let result = local;
    if (local.ok && window !== window.top) {
      let timer;
      try {
        result = await Promise.race([
          chrome.runtime.sendMessage({ type: 'SR_CHECK_SHELL_POPUPS', localClosed: local.closed }),
          new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, reason: '[弹窗阻挡]外层页面检查超时' }), 5000); }),
        ]);
      } catch (error) { result = { ok: false, reason: `[弹窗阻挡]外层页面连接失败：${error.message}` }; }
      finally { clearTimeout(timer); }
    }
    if (!result || !result.ok) {
      const error = new Error(result && result.reason || '[弹窗阻挡]未收到页面检查结果');
      error.popupBlocked = true;
      throw error;
    }
  }

  /**
   * 「控件在、但一个选项都没渲染出来」时的等待上限（2026-09-18 新增，见 selectRadio）。
   *
   * 为什么需要：微应用会在挂载后**异步水合重渲染**，短暂把单选组清空；
   * 会话第一个任务正好落在这个窗口里就会报「「数据粒度」下没有选项「店铺」，可选：」（可选列表为空）。
   * 这类"空"是**暂时的**，等几百毫秒就好；而"选项有、只是没有目标值"才是真配置错（那不该等）。
   */
  const SELECT_RADIO_READY_WAIT_MS = 5000;

  /** 原生 setter 写入（React 受控组件必须这样写才生效） */
  function setNativeValue(el, value) {
    const w = el.ownerDocument.defaultView;
    const desc = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value');
    desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * 通用等待：轮询 check()；每轮先做安全门禁检查（登录/风控/禁止词）
   * 返回 { ok, value, reason }
   */
  async function waitUntil(check, timeoutMs, label, intervalMs) {
    const iv = intervalMs || 400;
    const deadline = Date.now() + (timeoutMs || 15000);
    let lastReason = '未满足条件';
    while (Date.now() < deadline) {
      await checkTaskPopups();
      const gate = assertNoStopWords();
      if (!gate.ok) return { ok: false, value: null, reason: gate.reason };
      try {
        const v = check();
        if (v) return { ok: true, value: v, reason: '' };
      } catch (e) {
        lastReason = String(e && e.message || e);
      }
      await sleep(iv);
    }
    return { ok: false, value: null, reason: `等待超时(${label || '未命名'})：${lastReason}` };
  }

  // ---------------------------------------------------------------- 安全门禁
  function bodyText() {
    return (document.body && document.body.innerText) || '';
  }

  function assertNoStopWords() {
    const t = bodyText();
    for (const w of SR.STOP_WORDS.login) if (t.includes(w)) return { ok: false, reason: `检测到登录失效文案：${w}` };
    for (const w of SR.STOP_WORDS.risk) if (t.includes(w)) return { ok: false, reason: `检测到风控/验证文案：${w}` };
    return { ok: true, reason: '' };
  }

  // ---------------------------------------------------------------- 表单读取
  const item = (labelPrefix) => SR.findFormItem(document, labelPrefix);
  const byPh = (ph) => SR.inputByPlaceholder(document, ph);

  function SEL_ANY(parts) { return parts.join(','); }

  /**
   * 当前 frame 是否**取数微应用 frame**（背景层定向发送的依据）。
   *
   * ⚠️ 2026-09-14 收尾 ③ 实机更正：原来只认「表单视图」那一个 path
   *   （`/lyone/auto_analysis/datafetch/create`），但**结果视图的 frame 不匹配它** ——
   *   实测（NUDGE8）：催单消息已经送到 frame，却被它自己回
   *   `{ok:false, frame:'other', reason:'当前 frame 不是取数表单 frame'}` 拒掉，
   *   于是"催单成功"分支永远走不到。改为认**整个取数微应用**前缀；
   *   外壳页（`/adm/v3/...`）依旧不会被误认，视图差异由 `readFormState().view` 表达。
   */
  function isFormFrame() {
    try {
      const p = String(location.pathname || '');
      const formPath = SR.PAGE.formFramePath;
      const appPath = SR.PAGE.microAppPath || formPath;
      // ❗ 2026-09-20：微应用当顶层页时，结果视图的 path 是 `/auto_analysis/datafetch/…`（不带 /lyone）
      //    —— 不认它 → 结果视图里 frame 不再自报身份 → 催单/下载那一段没人应答（RT3 实测 21/22 期失败）。
      const resultPath = SR.PAGE.microAppResultPath || '';
      return p.indexOf(formPath) === 0 || p.indexOf(appPath) === 0 || (resultPath && p.indexOf(resultPath) === 0);
    } catch (e) { return false; }
  }

  function readRadioGroup(labelPrefix) {
    const it = item(labelPrefix);
    if (!it) return { exists: false, current: null, options: [] };
    const wrappers = Array.from(it.querySelectorAll(SEL_ANY([SR.SEL.radioWrapper, SR.SEL.checkboxWrapper])));
    const options = wrappers.map((e) => (e.innerText || '').trim()).filter(Boolean);
    const cur = wrappers.find((e) => SR.isChecked(e));
    // ⭐ 2026-09-16（客户/品类开发）：原先只回 `current`（第一个勾上的），**无法区分单选/多选**，
    //    于是"平台默认=全选"只能靠猜（探针里的 `selectedCount` 曾被写死成 1）。
    //    现在**实读**勾选数量与 wrapper 种类（radio / checkbox）。
    //    ⚠️ 只作证据与逐控件建模，**不参与判定**（判定仍只看选项集 + 显式声明的 defaultChosen）。
    const checkedList = wrappers.filter((e) => SR.isChecked(e));
    const kinds = Array.from(new Set(wrappers.map((e) => {
      const cls = String((e && e.className) || '');
      if (/checkbox/.test(cls)) return 'checkbox';
      if (/radio/.test(cls)) return 'radio';
      return 'unknown';
    })));
    return {
      exists: true,
      current: cur ? (cur.innerText || '').trim() : null,
      options,
      checkedCount: checkedList.length,
      checkedLabels: checkedList.map((e) => (e.innerText || '').trim()),
      wrapperKinds: kinds,
      looksMultiSelect: kinds.includes('checkbox'),
    };
  }

  /**
   * 读「选择指标」计数。
   *
   * ⚠️ 2026-09-14 实测两条关键事实（都写进判据里了）：
   *   ① 那段 `选择 N/M` 文字**是权威**（它和导出文件的列数一致：117 ↔ 119 列 / 100 ↔ 102 列…）。
   *   ② DOM 里的指标 checkbox 是**窗口化渲染**的 —— 同一时刻可能只挂了 57 个（总数 117）。
   *      所以"数一遍 DOM 勾选数"**不能当作通过/失败判据**（会把正常运行判成失败），
   *      只能作为**采样证据**回报，并显式标出 `domWindowed`。
   */
  function readMetricCount() {
    const it = item('选择指标');
    if (!it) return { exists: false, selected: null, total: null, raw: '', domChecked: null, domItems: null, domWindowed: null };
    const raw = (it.innerText || '').replace(/\s+/g, ' ');
    const m = raw.match(/选择\s*(\d+)\s*\/\s*(\d+)/);
    const wraps = Array.from(it.querySelectorAll(SEL_ANY([SR.SEL.checkboxWrapper, SR.SEL.radioWrapper])));
    // 「全部」这类汇总项不带 checkbox-group-item，「全部」以外的每个指标都带
    const groupItems = wraps.filter((w) => w.classList && w.classList.contains('dt-oui-checkbox-group-item'));
    const domChecked = groupItems.filter((w) => SR.isChecked(w)).length;
    const total = m ? Number(m[2]) : null;
    return {
      exists: true,
      selected: m ? Number(m[1]) : null,
      total,
      raw,
      domItems: groupItems.length,
      domChecked,
      // 窗口化判定：DOM 里的项数少于总数 → 只能信文字，DOM 计数仅作采样
      domWindowed: total != null ? groupItems.length < total : null,
    };
  }

  /**
   * 读取提示（toast）
   * ✅ 实测：平台把「信息填写不完整」这类 toast 渲染在**顶层 frame**，
   *    只扫 iframe 会漏掉真实报错（曾因此把"校验失败"误判为"等待结果视图超时"）
   */
  function readToasts() {
    const out = [];
    const push = (d) => {
      try {
        Array.from(d.querySelectorAll(SR.SEL.toast)).forEach((el) => {
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (t) out.push(t);
        });
      } catch (e) { /* 跨域或已卸载：忽略 */ }
    };
    push(document);
    try {
      if (window.top && window.top !== window && window.top.document) push(window.top.document);
    } catch (e) { /* 顶层跨域：忽略 */ }
    return Array.from(new Set(out));
  }

  /** 字段级报错（iframe 内）：比 toast 精确，优先级更高 */
  function readFieldErrors() {
    return Array.from(document.querySelectorAll(SR.SEL.fieldError))
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  /** 结果视图判定：**必须要求按钮可见**（否则会命中上一次结果视图的残留 DOM，假阳性） */
  function inResultView() {
    return !!findDownloadButton();
  }

  /**
   * 读**平台自报的导出总行数 / 超限警告**（用于 10 万行静默截断的检出）。
   *
   * ✅ 两条页面侧判据（都实测过，缺一不可；原文见 `selectors.js` 的 `SR.PLATFORM`）：
   *    ① 正常量级：`共31条数据，预览最多显示前30条数据` —— 预览表只挂前 30 行，
   *       所以"数 DOM 行数"永远得不到真实行数，只有这段文字是权威。
   *    ② **超限时**平台换成一句明示警告：`当前数据量已超过单次最大可下载数据量10万条。…`
   *       —— 此时**不再出现**判据①（TRUNC1 场次实测，第一版只认① → 漏判）。
   *
   * @returns {{rowCount:number|null, raw:string|null, overCap:boolean, overCapRaw:string|null, text:string}}
   */
  function readResultRowCount() {
    let text = '';
    try { text = (document.body && document.body.innerText) || ''; } catch (e) { text = ''; }
    const re = (SR.PLATFORM && SR.PLATFORM.rowCountText) || /共\s*([\d,]+)\s*条数据/;
    const m = re.exec(text);
    const rowCount = m ? Number(String(m[1]).replace(/,/g, '')) : null;
    const warnRe = (SR.PLATFORM && SR.PLATFORM.rowCapWarningText)
      || /已超过单次最大可下载数据量\s*([\d.]+)\s*万条/;
    const w = warnRe.exec(text);
    return {
      rowCount: Number.isFinite(rowCount) ? rowCount : null,
      raw: m ? m[0] : null,
      overCap: !!w,
      overCapRaw: w ? w[0] : null,
      text: text.replace(/\s+/g, ' ').slice(-300),
    };
  }

  function findSubmitButton() {
    return Array.from(document.querySelectorAll(SR.SEL.primaryButton))
      .find((b) => (b.innerText || '').trim() === SR.SEL.submitButtonText && isVisible(b)) || null;
  }

  function findDownloadButton() {
    return Array.from(document.querySelectorAll('button,[class*=btn]'))
      .find((b) => (b.innerText || '').trim() === SR.SEL.downloadButtonText && isVisible(b)) || null;
  }

  /**
   * 读页面表单状态（供调度层预检/店铺一致性校验/残留结果视图清场）
   * `isFormFrame` / `visibilityState` 两个标记都是**实机必需的**：
   *   · isFormFrame → 广播兜底路径用来从多个 frame 应答里挑出表单 frame
   *   · visibilityState → 不能再退化到 window.focused（"标签在非聚焦窗口里"依然算可见）
   */
  function readFormState() {
    const dim = readRadioGroup('数据维度');
    const storeItem = item('来源店铺');
    const storeText = storeItem ? (storeItem.innerText || '').replace(/\s+/g, ' ').trim() : '';    // ❗ 2026-09-20：**店铺 ID 是可读的**（旧代码误以为读不到、要求手填）——
    //    「来源店铺」控件的勾选框 `value` 就是 shopSystemId，`checked` 表示当前选中的店铺；
    //    实测 DOM：LABEL.dt-oui-checkbox-wrapper「生参旗舰店」> INPUT.dt-oui-checkbox-input value="000000" checked。
    //    判定规则放 core 纯函数（有单测）：**恰好一个勾选项**才认，0/多个一律 null（不猜）。
    const storeIdEntries = storeItem
      ? Array.from(storeItem.querySelectorAll('input[type=checkbox]')).map((i) => ({ value: i.value, checked: !!i.checked }))
      : [];
    const coreApi = (typeof globalThis !== 'undefined' && globalThis.SRCore) ? globalThis.SRCore : null;
    const storeId = coreApi && coreApi.pickStoreIdFromCheckboxValues
      ? coreApi.pickStoreIdFromCheckboxValues(storeIdEntries)
      : null;
    // ❗❗ 2026-09-22 修（Codex 复核报的真 bug）：店铺名**优先从勾选框的 label 读**。
    //    旧实现只从「来源店铺」整块文本里按"最长片段"猜 → 实测该块文本形如
    //      `全部 选择1/1重置连接更多店铺 生参旗舰店`
    //    噪声词表是**整词相等**过滤，`选择1/1重置连接更多店铺`（12 字）不是整词命中 ⇒
    //    它比真店铺名（8 字）长 ⇒ **工作台把"选择1/1重置连接更多店铺"当成了店铺名**（用户截图实况）。
    //    现在与 storeId **同源**取（同一个勾选框的 label 文本），文本兜底只在拿不到 label 时用。
    const storeNameFromLabel = (() => {
      if (!storeItem) return null;
      const checkedInputs = Array.from(storeItem.querySelectorAll('input[type=checkbox]'))
        .filter((i) => i.checked && /^\d{3,}$/.test(String(i.value || '')));
      if (checkedInputs.length !== 1) return null;   // 0/多个一律不猜（与 storeId 同一规则）
      const label = checkedInputs[0].closest('label') || checkedInputs[0].parentElement;
      const text = label ? (label.innerText || '').replace(/\s+/g, ' ').trim() : '';
      // label 里可能同时含店名与其它字样；去掉纯数字/选择计数碎片后取最长片段
      const picked = pickStoreName(text);
      return picked || text || null;
    })();
    const metric = readMetricCount();
    // ⭐ 2026-09-18 新增「控件就绪读数」（取数侧修冷页面竞态）：
    //    背景：`waitForFormFrame` 只保证**表单 frame 挂了**，不保证**里面的控件渲染好了**。
    //    实测症状：新会话第 1 个任务报「数据粒度（「数据粒度」下没有选项「店铺」，可选：）」——
    //    frame 已就绪，但 数据粒度/数据维度/时间粒度 三个必需单选组还没渲染出来；
    //    该任务被计一次失败，3 次后**永久留缺口**（真丢一期数据）。
    //    所以要把"必需控件各有选项"做成**可判定的就绪信号**（供 background 的 ⓪-d 闸门轮询）。
    const gran = readRadioGroup('数据粒度');
    const grain = readRadioGroup('时间粒度');
    const readiness = {
      granularityOptions: gran.options.length,
      dimensionOptions: dim.options.length,
      timeGrainOptions: grain.options.length,
      hasStore: !!storeItem,
      ready: gran.options.length > 0 && dim.options.length > 0 && grain.options.length > 0,
    };
    return {
      isFormFrame: isFormFrame(),
      path: String(location.pathname || ''),
      visibilityState: document.visibilityState,
      focused: document.hasFocus ? document.hasFocus() : null,
      inResultView: inResultView(),
      hasSubmit: !!findSubmitButton(),
      dimension: dim.current,
      metric,
      readiness,
      // 结果视图里平台自报的导出行数（用于 10 万行截断检出；不在结果视图时为 null）
      rowCount: inResultView() ? readResultRowCount().rowCount : null,
      storeText: storeText.slice(0, 200),
      storeName: storeNameFromLabel || pickStoreName(storeText),
      storeNameSource: storeNameFromLabel ? 'form-store-checkbox-label' : (pickStoreName(storeText) ? 'store-block-text' : null),
      storeId,
      storeIdSource: storeId ? 'form-store-checkbox' : null,
      storeCheckedCount: storeIdEntries.filter((e) => e.checked).length,
      toasts: readToasts().slice(-3),
      fieldErrors: readFieldErrors().slice(-3),
    };
  }

  /**
   * 从「来源店铺」区块文本里挑出店铺名（**兜底路径**；首选是勾选框 label，见 readFormState）。
   *
   * 实测该区块文本形如：`全部 选择1/1重置连接更多店铺 生参旗舰店`。
   * ❗❗ 2026-09-22 修（Codex 复核报的真 bug）：旧实现按"排除已知噪声词后取最长片段"来挑，
   *    而噪声表是**整词相等**过滤 ⇒ 复合噪声词（`选择1/1重置连接更多店铺`，12 字）不会命中，
   *    它又比真店铺名（8 字）长 ⇒ 结果把噪声当店名（用户截图实况：工作台显示"选择1/1重置连接更多店铺"）。
   *    现在改成：**包含**任一噪声片段即丢弃（子串匹配），拿不到就返回 null（不猜）。
   */
  function pickStoreName(text) {
    const s = String(text || '');
    if (!s) return null;
    const noiseWords = ['全部', '店铺', '当前店铺', '来源店铺'];
    // 子串级噪声：选择1/1、重置、连接更多…（这些字眼绝不会出现在真实店铺名里）
    const noiseFrag = /(选择\s*\d+\s*\/\s*\d+|重置|连接更多|切换|更多店铺)/;
    const parts = s.split(/\s+/)
      .map((x) => x.trim())
      .filter((x) => x
        && !noiseWords.includes(x)
        && !noiseFrag.test(x)
        && !/^选择\d+\/\d+$/.test(x)
        && !/^\d+$/.test(x));
    if (parts.length === 0) return null;
    return parts.sort((a, b) => b.length - a.length)[0];
  }

  // ---------------------------------------------------------------- 动作：选项控件（单选组 / 多选组）
  function readOptionWrappers(labelPrefix) {
    const it = item(labelPrefix);
    if (!it) return { exists: false, wrappers: [], chosen: [] };
    const wrappers = Array.from(it.querySelectorAll(SEL_ANY([SR.SEL.radioWrapper, SR.SEL.checkboxWrapper])));
    return {
      exists: true,
      wrappers,
      chosen: wrappers.filter((e) => SR.isChecked(e)).map((e) => (e.innerText || '').trim()).filter(Boolean),
    };
  }

  /**
   * 选中某个单选组里的指定选项，并回读断言。
   * 返回 { ok, reason }
   */
  async function selectRadio(labelPrefix, optionText, forceClick = false) {
    const it = item(labelPrefix);
    if (!it) return { ok: false, reason: `找不到字段：${labelPrefix}` };
    let wrappers = Array.from(it.querySelectorAll(SEL_ANY([SR.SEL.radioWrapper, SR.SEL.checkboxWrapper])));
    let target = wrappers.find((w) => (w.innerText || '').trim() === optionText);
    // ⭐ 2026-09-18 新增：控件**存在但选项为空**时先等再判（修冷页面/异步重渲染竞态）。
    //   实测（COLD1 场次，会话第一个任务）：开始前闸门与预检都通过，但微应用随后**水合重渲染**
    //   把「数据粒度」「时间粒度」短暂清空 → 正好落在这一步，报「下没有选项「店铺」，可选：」（可选列表为空）。
    //   原实现直接把"选项为空"当永久失败，于是任务白丢一次尝试（3 次后永久留缺口 = 丢一期数据）。
    //   这里只在"**一个可点选项都没有**"时等待（最长 SELECT_RADIO_READY_WAIT_MS），
    //   选项本来就有、只是没有目标值的情况仍立即报错（那是真配置错，不该等）。
    if (wrappers.length === 0) {
      const ready = await waitUntil(
        () => Array.from(it.querySelectorAll(SEL_ANY([SR.SEL.radioWrapper, SR.SEL.checkboxWrapper]))).length > 0,
        SELECT_RADIO_READY_WAIT_MS,
        `${labelPrefix} 选项渲染`,
      );
      if (ready.ok) {
        wrappers = Array.from(it.querySelectorAll(SEL_ANY([SR.SEL.radioWrapper, SR.SEL.checkboxWrapper])));
        target = wrappers.find((w) => (w.innerText || '').trim() === optionText);
      } else {
        return { ok: false, reason: `「${labelPrefix}」的选项在 ${SELECT_RADIO_READY_WAIT_MS} 毫秒内未渲染出来（等待后仍为空：${ready.reason}）` };
      }
    }
    if (!target) {
      const opts = wrappers.map((w) => (w.innerText || '').trim());
      return { ok: false, reason: `「${labelPrefix}」下没有选项「${optionText}」，可选：${opts.join('/')}` };
    }
    if (!forceClick && SR.isChecked(target) && readRadioGroup(labelPrefix).current === optionText) {
      return { ok: true, reason: '' }; // 已是目标态，不重复点击
    }
    realClick(target.querySelector('label') || target.querySelector('input') || target, document.defaultView);
    const w = await waitUntil(() => readRadioGroup(labelPrefix).current === optionText, 6000, `${labelPrefix}=${optionText}`);
    if (!w.ok) return { ok: false, reason: `选中失败：${w.reason}` };
    return { ok: true, reason: '' };
  }

  /** 该表单项是否存在于当前页面（不同维度渲染的表单项不同，不能静态写死） */
  function hasField(labelPrefix) {
    return !!item(labelPrefix);
  }

  /**
   * 额外筛选的**显式覆盖**（严格覆盖）。
   *
   * ⚠️ 实机更正（EFV1 场次，2026-09-14）：「关键词 → 分词类型」这类筛选控件是**多选组且默认全选**
   *    （实测 6 个 wrapper 全部 `dt-oui-checkbox-wrapper-checked`：全部/搜索词/长尾词/品类词/修饰词/品牌词），
   *    所以"只把目标值点上"是**空操作** —— 语义上真正要做的是**只保留指定的值**（其余全部取消）。
   *    证据：KW1 导出文件（未覆盖）的 `关键词类型` 列有 5 种取值（搜索词 4073 / 长尾词 3533 / 修饰词 3506 /
   *    品牌词 3473 / 品类词 2214），证明"平台默认 = 全选"，等价于没筛。
   *    → 因此对**多选组**（wrapper 带 `dt-oui-checkbox-group-item`）采用**严格语义**：
   *      ① 先取消所有非目标项；② 再确保目标项被选中；③ 终态断言 = 选中集合**恰等于**目标集合。
   *      单选组（无该 class，如「来源类型」）不做取消，只确认到达目标值。
   *
   * 未在覆盖配置里的控件**保持平台默认值**（只回读留证，不做任何点击）。
   *
   * @param {string} labelPrefix           控件所在表单项（如「分词类型」）
   * @param {string[]} wanted              需要保留的值（非空；空数组属配置错误，由 core 层拦截）
   * @returns {{ok:boolean, reason?:string, chosen?:string[], options?:string[], mode?:string, unchecked?:string[]}}
   */
  async function applyOptionValues(labelPrefix, wanted) {
    const target = Array.isArray(wanted) ? wanted.map((v) => String(v).trim()).filter(Boolean) : [];
    if (target.length === 0) return { ok: false, reason: `「${labelPrefix}」的覆盖值列表为空（配置错误）` };

    // 控件本身可能还要等一拍才渲染（维度刚切换完）
    const ready = await waitUntil(() => readOptionWrappers(labelPrefix).wrappers.length > 0, 8000, `「${labelPrefix}」选项渲染`);
    if (!ready.ok) return { ok: false, reason: `找不到「${labelPrefix}」的任何选项：${ready.reason}` };

    const state0 = readOptionWrappers(labelPrefix);
    const options = state0.wrappers.map((e) => (e.innerText || '').trim()).filter(Boolean);
    const missing = target.filter((t) => !options.includes(t));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `「${labelPrefix}」下没有选项「${missing.join('/')}」，可选：${options.join('/')}`,
        options,
      };
    }

    // 判定控件语义：多选组 = 组内项带 checkbox-group-item class（「全部」这类汇总项不带）
    const isMulti = state0.wrappers.some((w) => w.classList && w.classList.contains('dt-oui-checkbox-group-item'));
    const groupItems = isMulti
      ? state0.wrappers.filter((w) => w.classList && w.classList.contains('dt-oui-checkbox-group-item'))
      : state0.wrappers;
    const unchecked = [];

    // ---- ① 严格覆盖：取消所有非目标项（只对多选组；单选组不点，点错会变成"没得选"）
    if (isMulti) {
      for (const w of groupItems) {
        const text = (w.innerText || '').trim();
        if (target.includes(text)) continue;
        if (!SR.isChecked(w)) continue;
        realClick(w.querySelector('label') || w.querySelector('input') || w, document.defaultView);
        const gone = await waitUntil(
          () => !readOptionWrappers(labelPrefix).chosen.includes(text),
          5000,
          `「${labelPrefix}」取消 ${text}`,
        );
        if (!gone.ok) {
          return {
            ok: false,
            reason: `「${labelPrefix}」无法取消非目标项「${text}」：${gone.reason}（严格覆盖无法生效，已中止不提交）`,
            options, mode: 'multi-strict', unchecked,
          };
        }
        unchecked.push(text);
      }
    }

    // ---- ② 确保目标项被选中（已在选中态就不点）
    for (const want of target) {
      const cur = readOptionWrappers(labelPrefix);
      const hit = cur.wrappers.find((w) => (w.innerText || '').trim() === want);
      if (!hit) return { ok: false, reason: `「${labelPrefix}」的目标选项「${want}」在点击前消失了`, options };
      if (SR.isChecked(hit)) continue;   // ⚠️ 已在目标态：绝不重复点（多选组上再点会**取消**）
      realClick(hit.querySelector('label') || hit.querySelector('input') || hit, document.defaultView);
      const w = await waitUntil(
        () => readOptionWrappers(labelPrefix).chosen.includes(want),
        6000,
        `「${labelPrefix}」= ${want}`,
      );
      if (!w.ok) {
        const now = readOptionWrappers(labelPrefix).chosen;
        return { ok: false, reason: `「${labelPrefix}」选中「${want}」失败：${w.reason}（当前选中：${now.join('+') || '空'}）`, options };
      }
    }

    // ---- ③ 终态断言：选中集合必须**恰等于**目标集合（"精确控制"的全部意义就在这里）
    const after = readOptionWrappers(labelPrefix).chosen;
    const notChosen = target.filter((t) => !after.includes(t));
    if (notChosen.length > 0) {
      return { ok: false, reason: `「${labelPrefix}」回读未生效，缺少：${notChosen.join('/')}（当前选中：${after.join('+') || '空'}）`, options };
    }
    // 只看"多选组内"的选中集合做相等断言（「全部」汇总项由平台自己维护，不参与判定）
    const afterInGroup = isMulti
      ? after.filter((t) => groupItems.some((w) => (w.innerText || '').trim() === t))
      : after;
    const extra = afterInGroup.filter((t) => !target.includes(t));
    if (extra.length > 0) {
      return {
        ok: false,
        reason: `「${labelPrefix}」严格覆盖未达成：仍多出 ${extra.join('/')}（期望只有 ${target.join('+')}）`,
        options, mode: isMulti ? 'multi-strict' : 'single', unchecked,
      };
    }
    return { ok: true, chosen: after, options, mode: isMulti ? 'multi-strict' : 'single', unchecked };
  }

  /**
   * 额外筛选的**只读留证**：不点任何东西，只记录平台当前的默认选中值。
   * 未配置覆盖的控件走这条路（首版行为：平台已给默认值 → 只校验"至少选了一项"）。
   */
  function readOptionChoices(labelPrefix) {
    const s = readOptionWrappers(labelPrefix);
    return { exists: s.exists, chosen: s.chosen, options: s.wrappers.map((e) => (e.innerText || '').trim()).filter(Boolean) };
  }

  // ---------------------------------------------------------------- 动作：指标
  /**
   * 确保指标选择符合预期总数，并且"已选 == 总数"。
   * ⚠️ 「全部」是双向开关：已全选时再点会清空为 0 —— 必须先读计数，必要时才点，点后回读。
   *
   * ⚠️ 2026-09-14 加固：判据从"计数器文字"升级为**文字 + DOM 实选数双重确认**。
   *    实机依据（RBD2）：文字显示 117/117 但导出文件只有 59 个指标列 —— 文字可能是上一次维度的残留。
   *    现在任一判据不满足都会**补点一次「全部」并重新回读**，两次都不过就中止不提交。
   */
  async function ensureMetrics(expectedTotal) {
    const before = readMetricCount();
    if (!before.exists) return { ok: false, reason: '找不到「选择指标」字段' };
    if (expectedTotal && before.total !== expectedTotal) {
      return {
        ok: false,
        reason: `指标总数与预期不符：页面 ${before.total}，预期 ${expectedTotal}（可能切错维度或平台改版）`,
      };
    }
    // 判据以**计数器文字**为准（与导出列数一致）；DOM 勾选数只作采样证据（窗口化渲染，见 readMetricCount）
    const textOk = (c) => c.selected === c.total && c.selected > 0;
    const describe = (c) => `计数器 ${c.selected}/${c.total}`
      + `，DOM 采样 ${c.domChecked == null ? '未取到' : `${c.domChecked}/${c.domItems}`}`
      + (c.domWindowed ? '（窗口化：DOM 项数少于总数，仅作采样）' : '');
    if (textOk(before)) return { ok: true, reason: describe(before) };

    const it = item('选择指标');
    const all = Array.from(it.querySelectorAll(SEL_ANY([SR.SEL.checkboxWrapper, SR.SEL.radioWrapper]) + ',label,span'))
      .find((e) => (e.innerText || '').trim() === SR.SEL.metricAllText);
    if (!all) return { ok: false, reason: '找不到指标「全部」开关' };

    // 「全部」是双向开关：已全选时再点会清空为 0。因此"点一次→回读→不满足再点一次"，
    // 两步之内必然覆盖"清空后重选"这一种情况。
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      realClick(all, document.defaultView);
      const w = await waitUntil(() => {
        const c = readMetricCount();
        return textOk(c) ? c : false;
      }, 8000, `指标全选(第 ${attempt} 次)`);
      if (w.ok) return { ok: true, reason: `${describe(w.value)}（第 ${attempt} 次点击生效）` };
      const now = readMetricCount();
      if (attempt === 2) {
        return { ok: false, reason: `指标全选失败（${describe(now)}）：${w.reason}` };
      }
    }
    return { ok: false, reason: '指标全选失败（未知原因）' };
  }

  // ---------------------------------------------------------------- 日期工具
  function shiftDays(dateStr, days) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
    return dt.toISOString().slice(0, 10);
  }

  /**
   * 把日期归一成 `YYYY-MM-DD`。
   * 平台在输入框里回填的可能是 `2026-08-01 00:00:00` 或本地化文本，
   * 因此这里只取"第一个看起来像日期的片段"，取不到就原样返回（由调用方判不等）。
   */
  function normalizeDateText(value) {
    const s = String(value == null ? '' : value).trim();
    const m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (!m) return s;
    const mm = String(Number(m[2])).padStart(2, '0');
    const dd = String(Number(m[3])).padStart(2, '0');
    return `${m[1]}-${mm}-${dd}`;
  }

  /**
   * ISO 周标签（实测格式：`2026-35周`）。
   * 用 UTC 算法，避免本地时区把周一算到上一周（历史上踩过"周号差 1"这类问题）。
   */
  function weekLabelOf(dateStr) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dayNum = (dt.getUTCDay() + 6) % 7;          // 周一=0
    dt.setUTCDate(dt.getUTCDate() - dayNum + 3);      // 移到本周周四
    const isoYear = dt.getUTCFullYear();
    const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
    const ftDayNum = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayNum + 3);
    const week = 1 + Math.round((dt - firstThursday) / (7 * 24 * 3600 * 1000));
    return `${isoYear}-${week}周`;
  }

  // ---------------------------------------------------------------- 动作：日期（日历点选）
  function pickerPanel() {
    return Array.from(document.querySelectorAll(SR.SEL.datePickerPanel)).find(isVisible) || null;
  }

  function panelHeaders(pnl) {
    const set = [];
    pnl.querySelectorAll(SR.SEL.datePanelHeader).forEach((h) => {
      const t = (h.innerText || '').replace(/\s+/g, ' ').trim();
      if (t) set.push(t);
    });
    return set;
  }

  function cellByTitle(title) {
    return Array.from(document.querySelectorAll('[title]'))
      .find((el) => el.getAttribute('title') === title && isVisible(el)) || null;
  }

  /**
   * 日期格为什么不可用 —— 返回 null 表示可用。
   * ❗ 2026-09-19 事故教训：旧实现只回一句"未满足条件"，把**平台窗口缺口**（日期格被平台禁用）
   *    和**引擎找不到翻月按钮**混成同一个说法，排查时会一路往"引擎 bug"方向跑（我实际跑偏过一次）。
   *    这里把原因分开，调用方据此决定"直接判平台缺口"还是"面板坏了 → 重开重试"。
   */
  function dateCellProblem(title) {
    const cell = cellByTitle(title);
    if (!cell) return '找不到日期格';
    const cls = String(cell.className || '');
    if (/disabled/.test(cls)) return '日期格被平台禁用（该日期很可能不在平台窗口内）';
    if (/not-current|outside|prev-month|next-month/.test(cls)) return '日期格属于相邻月份（面板未真正切到该月）';
    return null;
  }

  function isDateVisible(title) {
    return dateCellProblem(title) === null;
  }

  /** 面板头部是否已经是目标月份（形如「2026年8月」） */
  function monthHeaderShown(year, month) {
    const pnl = pickerPanel();
    if (!pnl) return false;
    const texts = panelHeaders(pnl).join(' ');
    return texts.includes(`${year}年${month}月`) || texts.includes(`${year}-${String(month).padStart(2, '0')}`);
  }

  async function goToMonth(year, month) {
    const target = `${year}年${month}月`;
    const dir = `${year}-${String(month).padStart(2, '0')}`;
    // 平台面板可能是"双月并排"（左/右两个月）：任一头部命中即算到达
    for (let i = 0; i < 36; i += 1) {
      const pnl = pickerPanel();
      if (!pnl) return { ok: false, reason: '日期面板已关闭，无法翻月' };
      const texts = panelHeaders(pnl).join(' ');
      if (texts.includes(target) || texts.includes(dir)) return { ok: true, reason: '' };
      // 目标月份在当前月份之后 → 点 next，否则 prev
      const cur = texts.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
      let next = true;
      if (cur) {
        const curKey = Number(cur[1]) * 12 + Number(cur[2]);
        const wantKey = Number(year) * 12 + Number(month);
        next = wantKey > curKey;
      }
      const btn = pnl.querySelector(next
        ? (SR.WEEK_PICKER.headerNextBtn + ',[class*=header-next],[class*=picker-header-next]')
        : (SR.WEEK_PICKER.headerPrevBtn + ',[class*=header-prev],[class*=picker-header-prev]'));
      if (!btn || !isVisible(btn)) {
        return { ok: false, panelBroken: true, reason: `面板翻月按钮缺失（目标 ${target}，当前面板：${texts || '空'}）` };
      }
      realClick(btn, document.defaultView);
      await sleep(240);
    }
    return { ok: false, panelBroken: true, reason: `翻月超过 36 次仍未到 ${target}` };
  }

  async function ensureMonthVisible(dateStr) {
    const [y, m] = String(dateStr).split('-').map(Number);
    if (isDateVisible(dateStr)) return { ok: true, reason: '' };
    const moved = await goToMonth(y, m);
    if (!moved.ok) return moved;
    const w = await waitUntil(() => isDateVisible(dateStr), 4000, `日期格可见 ${dateStr}`);
    if (!w.ok) {
      const why = dateCellProblem(dateStr);
      return {
        ok: false,
        reason: `${w.reason}：${why || '未满足条件'}`,
        platformUnavailable: /被平台禁用/.test(String(why || '')),
      };
    }
    return { ok: true, reason: '' };
  }

  async function clickDate(dateStr) {
    const vis = await ensureMonthVisible(dateStr);
    if (!vis.ok) return vis;
    const cell = cellByTitle(dateStr);
    if (!cell) return { ok: false, reason: `找不到日期格 ${dateStr}` };
    realClick(cell.querySelector('td,[class*=cell]') || cell, document.defaultView);
    await sleep(320);
    return { ok: true, reason: '' };
  }

  async function closePicker() {
    const pnl = pickerPanel();
    if (!pnl) return { ok: true, reason: '' };
    try {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: document.defaultView, button: 0 }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: document.defaultView, button: 0 }));
    } catch (e) { /* 忽略 */ }
    await sleep(200);
    if (!pickerPanel()) return { ok: true, reason: '' };
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } catch (e) { /* 忽略 */ }
    await sleep(200);
    return { ok: !pickerPanel(), reason: pickerPanel() ? '面板仍未关闭（实机已知：后台标签下动画被暂停会卡住）' : '' };
  }

  /** 打开日期面板：**先收掉任何残留面板**再点输入框（残留面板会带着错误月份，见 setDateRange 注释） */
  async function openPickerAt(input, label) {
    await closePicker();
    realClick(input, document.defaultView);
    return waitUntil(() => !!pickerPanel(), 6000, label || '日期面板打开');
  }

  /**
   * 写入「时间周期」的起止日期：**不用键盘输入**（实测写入后常不生效）→ 日历点选 + 回读。
   */
  async function setDateRange(startDate, endDate) {
    const startInput = byPh(SR.PLACEHOLDER.startDate);
    if (!startInput) return { ok: false, reason: `找不到「${SR.PLACEHOLDER.startDate}」输入框` };
    let opened = await openPickerAt(startInput, '日期面板打开');
    if (!opened.ok) return { ok: false, reason: `日期面板未打开：${opened.reason}` };

    let a = await clickDate(startDate);
    if (!a.ok && a.panelBroken) {
      // ❗❗ 2026-09-19 事故（SD11~SD15 五会话 25/25 全废）：某任务因**平台窗口**失败（日期格被禁用）
      //    之后，面板会停在错误月份且**翻月按钮找不到** → 同一会话里**每个**任务都以同样方式失败；
      //    而同一个维度在**全新页面**上对同一批日期跑 DRYRUN 是**全门禁通过**（已实测）。
      //    → 面板重置后重试一次；仍失败才判本任务失败。
      opened = await openPickerAt(startInput, '日期面板重置后重试');
      if (opened.ok) a = await clickDate(startDate);
    }
    if (!a.ok) {
      return { ok: false, platformUnavailable: a.platformUnavailable === true, reason: `选开始日期失败：${a.reason}` };
    }

    // 起止两端都在同一个面板里连续选（实测：重新打开面板会丢前半段）
    const endInput = byPh(SR.PLACEHOLDER.endDate);
    if (endInput && !pickerPanel()) {
      realClick(endInput, document.defaultView);
      const reopened = await waitUntil(() => !!pickerPanel(), 6000, '日期面板重新打开');
      if (!reopened.ok) return { ok: false, reason: `日期面板未重新打开：${reopened.reason}` };
    }
    let b = await clickDate(endDate);
    if (!b.ok && b.panelBroken) {
      const re = await openPickerAt(startInput, '选结束日期：面板重置后重试');
      if (re.ok) b = await clickDate(endDate);
    }
    if (!b.ok) {
      return { ok: false, platformUnavailable: b.platformUnavailable === true, reason: `选结束日期失败：${b.reason}` };
    }
    await closePicker();

    // ✅ 回读断言（只按日期段比较，避免平台回填 `YYYY-MM-DD 00:00:00` 之类格式差异误判）
    const rs = normalizeDateText(startInput.value);
    const re = endInput ? normalizeDateText(endInput.value) : '';
    if (rs !== startDate) return { ok: false, reason: `「结束/开始日期」回读不一致：开始应为 ${startDate}，实际「${rs || '空'}」` };
    if (endInput && re !== endDate) return { ok: false, reason: `「结束日期」回读不一致：应为 ${endDate}，实际「${re || '空'}」` };
    return { ok: true, reason: '', value: { start: rs, end: re } };
  }

  /** 分周模式的「周选择」：点行首周号格 = 选整周（实测），随后严格回读 `YYYY-NN周` */
  async function pickWeekRow(dateStr) {
    const pnl = pickerPanel();
    if (!pnl) return { ok: false, reason: '周选择面板未打开' };
    const vis = await ensureMonthVisible(dateStr);
    if (!vis.ok) return vis;
    const dayCell = Array.from(pnl.querySelectorAll(SR.WEEK_PICKER.dayCellWithTitle))
      .find((td) => td.getAttribute('title') === dateStr && isVisible(td));
    if (!dayCell) return { ok: false, reason: `面板里找不到 ${dateStr} 所在周（行内日期格缺失）` };
    const row = dayCell.closest(SR.WEEK_PICKER.panelRow) || dayCell.closest('tr');
    if (!row) return { ok: false, reason: `找不到 ${dateStr} 所在的周行` };
    const head = row.querySelector(SR.WEEK_PICKER.weekHeadCell) || row.firstElementChild;
    if (!head) return { ok: false, reason: '周行里找不到行首周号格' };
    realClick(head, document.defaultView);
    await sleep(320);
    return { ok: true, reason: '' };
  }

  async function setWeekRange(startDate, endDate) {
    const startInput = byPh(SR.WEEK_PICKER.startPlaceholder);
    if (!startInput) return { ok: false, reason: `找不到「${SR.WEEK_PICKER.startPlaceholder}」输入框` };
    const endInput = byPh(SR.WEEK_PICKER.endPlaceholder);
    realClick(startInput, document.defaultView);
    const opened = await waitUntil(() => !!pickerPanel(), 6000, '周选择面板打开');
    if (!opened.ok) return { ok: false, reason: `周选择面板未打开：${opened.reason}` };

    const a = await pickWeekRow(startDate);
    if (!a.ok) return { ok: false, reason: `选开始周失败：${a.reason}` };
    if (endInput && !pickerPanel()) {
      realClick(endInput, document.defaultView);
      await waitUntil(() => !!pickerPanel(), 6000, '周选择面板重新打开');
    }
    const b = await pickWeekRow(endDate);
    if (!b.ok) return { ok: false, reason: `选结束周失败：${b.reason}` };
    await closePicker();

    // ✅ 严格回读：平台值格式为 `2026-35周`（年-ISO周号）
    const expectStart = weekLabelOf(shiftDays(startDate, 0));
    const expectEnd = weekLabelOf(shiftDays(endDate, -6));
    const startValue = String(startInput.value || '').trim();
    const endValue = endInput ? String(endInput.value || '').trim() : '';
    if (startValue !== expectStart) {
      return {
        ok: false,
        reason: `「开始周」应为 ${expectStart}（区间起 ${startDate} 所在周），实际「${startValue || '空'}」：周选择未生效（已试：翻月、点行内日期格、补发 input/change/Enter/blur）`,
      };
    }
    if (endInput && endValue !== expectEnd) {
      return {
        ok: false,
        reason: `「结束周」应为 ${expectEnd}（区间止 ${endDate} 所在周），实际「${endValue || '空'}」：周选择未生效`,
      };
    }
    return { ok: true, reason: '', value: { start: startValue, end: endValue } };
  }

  /**
   * 分月模式：`开始月份` / `结束月份`。
   *
   * ✅ 实机 DOM 事实（2026-09-14 RBM 场次现场探测，修正旧实现）：
   *    月份面板**不是**按"目标月份翻月"组织的 —— 它一次渲染**两个年份的全部月份**
   *    （`2026年 1月 … 12月` + `2027年 1月 … 12月`），
   *    单元格是 `td.dt-oui-picker-cell`，**带 `title="YYYY-MM"`**（如 `title="2026-08"`），
   *    未来月份带 `dt-oui-picker-cell-disabled`，面板头部只有 `dt-oui-picker-header-super-prev/next-btn`（**跨年**翻页）。
   *    → 因此旧实现"先 `goToMonth(年,月)` 再按 innerText==`8月` 找格"必错：
   *      ① 头部长这样 `2026年`，永远匹配不到 `2026年8月`；② 面板里 `8月` 会出现两次（2026/2027）→ 选错年份；
   *      ③ 旧代码还给 `.dt-oui-picker-cell-inner`（子元素）发了点击而不是单元格本身。
   *    修法：**按 title 精确定位单元格本体**（`[title="YYYY-MM"]`），只在"可点且未被禁用且可见"的格里选。
   */
  /**
   * 把月份面板**翻到目标年份**（✅ 2026-09-18 实测根因修复）。
   *
   * 为什么必须有它：分月的「时间周期」是**双面板月份区间选择器**，打开时固定落在**当前年份**
   * （实测 2026 年 → 面板显示 2026-01…2027-12 共 24 格）。要取 2024-05 这类历史月份，必须先往回翻年，
   * 否则 `pickMonthCell()` 找不到 `title="2024-05"`，报「月份面板里找不到 title="2024-05" 的单元格」。
   * 当时那个失败**没有阻止提交**（执行流没把日期步骤当致命步骤）→ 平台在提交时打回
   * 「字段校验失败：请输入时间范围」→ KFM1 场次 28 期全废。
   *
   * 翻页按钮（实测 class）：`.dt-oui-picker-header-super-prev-btn`（往回一年）/
   * `.dt-oui-picker-header-super-next-btn`（往后一年）；双面板一起移动。
   */
  async function ensureMonthPanelYear(targetYear) {
    const want = String(targetYear);
    for (let i = 0; i < 15; i += 1) {
      const pnl = pickerPanel();
      if (!pnl) return { ok: false, reason: '月份选择面板未打开（翻年过程中丢失）' };
      const years = Array.from(new Set(Array.from(pnl.querySelectorAll('[title]'))
        .map((el) => String(el.getAttribute('title') || '').slice(0, 4))
        .filter(Boolean)));
      if (years.includes(want)) return { ok: true, reason: `第 ${i} 次翻页后已见 ${want} 年（面板年份：${years.join('/')}）` };
      const dir = Number(want) < Math.min.apply(null, years.map(Number)) ? 'prev' : 'next';
      const btn = pnl.querySelector('.dt-oui-picker-header-super-' + dir + '-btn');
      if (!btn) return { ok: false, reason: `面板里找不到「${dir}」翻页按钮（现有年份：${years.join('/')}）` };
      realClick(btn, document.defaultView);
      await sleep(340);
    }
    return { ok: false, reason: `连翻 15 次仍未出现年份 ${want}` };
  }

  async function pickMonthCell(dateStr) {
    const pnl = pickerPanel();
    if (!pnl) return { ok: false, reason: '月份选择面板未打开' };
    const want = String(dateStr).slice(0, 7);          // YYYY-MM
    const cells = Array.from(pnl.querySelectorAll('[title]'))
      .filter((el) => el.getAttribute('title') === want);
    const usable = cells.find((el) => isVisible(el) && !/disabled/.test(String(el.className || '')))
      || cells.find((el) => isVisible(el));
    if (!usable) {
      const shown = Array.from(pnl.querySelectorAll('[title]')).map((el) => el.getAttribute('title')).filter(Boolean).slice(0, 30);
      return { ok: false, reason: `月份面板里找不到 title="${want}" 的单元格（面板现有 title：${shown.join('/') || '无'}）` };
    }
    realClick(usable, document.defaultView);
    await sleep(320);
    return { ok: true, reason: '' };
  }

  async function setMonthRange(startDate, endDate) {
    const startInput = byPh(SR.MONTH_PICKER.startPlaceholder);
    if (!startInput) return { ok: false, reason: `找不到「${SR.MONTH_PICKER.startPlaceholder}」输入框` };
    const endInput = byPh(SR.MONTH_PICKER.endPlaceholder);
    realClick(startInput, document.defaultView);
    const opened = await waitUntil(() => !!pickerPanel(), 6000, '月份选择面板打开');
    if (!opened.ok) return { ok: false, reason: `月份选择面板未打开：${opened.reason}` };

    // ★ 先翻到**开始月份**所在年份（面板默认落在当前年份，取历史数据必须先往回翻）
    const y1 = await ensureMonthPanelYear(String(startDate).slice(0, 4));
    if (!y1.ok) return { ok: false, reason: `翻到开始月份所在年份失败：${y1.reason}` };

    const a = await pickMonthCell(startDate);
    if (!a.ok) return { ok: false, reason: `选开始月份失败：${a.reason}` };
    if (endInput && !pickerPanel()) {
      realClick(endInput, document.defaultView);
      await waitUntil(() => !!pickerPanel(), 6000, '月份选择面板重新打开');
    }
    // ★ 结束月份可能与开始月份跨年 → 结束后再确认一次年份（同一年时这一步是空操作）
    const y2 = await ensureMonthPanelYear(String(endDate).slice(0, 4));
    if (!y2.ok) return { ok: false, reason: `翻到结束月份所在年份失败：${y2.reason}` };

    const b = await pickMonthCell(endDate);
    if (!b.ok) return { ok: false, reason: `选结束月份失败：${b.reason}` };
    await closePicker();

    // 回读断言：只要求"输入框非空且包含目标年月"，具体格式以平台回填为准（并留证在 steps 里）
    const sv = String(startInput.value || '').trim();
    const ev = endInput ? String(endInput.value || '').trim() : '';
    const wantStart = String(startDate).slice(0, 4);
    const wantEnd = String(endDate).slice(0, 4);
    if (!sv || !sv.includes(wantStart)) {
      return { ok: false, reason: `「开始月份」回读异常：实际「${sv || '空'}」（期望含 ${wantStart}，目标 ${String(startDate).slice(0, 7)}）` };
    }
    if (endInput && (!ev || !ev.includes(wantEnd))) {
      return { ok: false, reason: `「结束月份」回读异常：实际「${ev || '空'}」（期望含 ${wantEnd}，目标 ${String(endDate).slice(0, 7)}）` };
    }
    return { ok: true, reason: `开始=${sv}；结束=${ev}`, value: { start: sv, end: ev } };
  }

  // ---------------------------------------------------------------- 动作：报表名称 / 必填项 / 提交
  async function setReportName(name) {
    const check = SR.REPORT_NAME.validate(name);
    if (!check.ok) return { ok: false, reason: check.reason };
    const input = byPh(SR.PLACEHOLDER.reportName);
    if (!input) return { ok: false, reason: `找不到「报表名称」输入框（placeholder=${SR.PLACEHOLDER.reportName}）` };
    setNativeValue(input, String(name));
    const w = await waitUntil(() => String(input.value || '').trim() === String(name), 4000, '报表名称回读');
    if (!w.ok) return { ok: false, reason: `报表名称回读不一致：实际「${String(input.value || '')}」` };
    return { ok: true, reason: '' };
  }

  /**
   * 必填项断言（✅ 实测教训）：
   *   ① 必填清单**不能静态写死**（不同维度渲染的表单项不同，例如「终端类型」只在部分维度出现）
   *      → 从页面读带 `form-item-required` 标记的表单项；
   *   ② 值必须用**已验证的 item(label)** 读取——直接在某层元素里 querySelectorAll 会因嵌套层级取错范围而全部误判；
   *   ③ ⚠️ 分周模式下「时间周期」的输入框 placeholder 是 `开始周` / `结束周`，
   *      旧版只按日期 placeholder 找框 → 恒报"时间周期-开始/结束日期(空)"→ 阻止提交（X5–X9 四轮踩坑）。
   *      修法：`byPh(开始日期) ‖ byPh(开始周)`，分月同理。
   */
  function assertRequiredComplete() {
    const missing = [];
    const present = [];
    const items = Array.from(document.querySelectorAll(SR.SEL.formItemRequired));
    for (const it of items) {
      const lab = it.querySelector(SR.SEL.formItemLabel);
      let label = lab ? (lab.innerText || '').replace(/\s+/g, ' ').trim() : '';
      if (!label) {
        // 有些节点的 label 会被读成空串 → 用 placeholder 交叉核对（漏掉必填「报表名称」的教训）
        const ph = it.querySelector('input[placeholder]');
        label = ph ? String(ph.getAttribute('placeholder') || '').trim() : '';
      }
      if (!label) continue;
      // 只取 label 的第一段（如「时间周期」），避免把说明文字混进来
      const prefix = label.split(/[\s（(]/)[0];
      if (prefix === '报表名称' || prefix === SR.PLACEHOLDER.reportName) {
        const input = byPh(SR.PLACEHOLDER.reportName);
        const v = input ? String(input.value || '').trim() : '';
        if (!v) missing.push('报表名称(空)'); else present.push(`报表名称=${v.length}字符`);
        continue;
      }
      if (prefix === '时间周期') {
        const s = byPh(SR.PLACEHOLDER.startDate) || byPh(SR.WEEK_PICKER.startPlaceholder) || byPh(SR.MONTH_PICKER.startPlaceholder);
        const e = byPh(SR.PLACEHOLDER.endDate) || byPh(SR.WEEK_PICKER.endPlaceholder) || byPh(SR.MONTH_PICKER.endPlaceholder);
        const sv = s ? String(s.value || '').trim() : '';
        const ev = e ? String(e.value || '').trim() : '';
        if (!s) missing.push('时间周期-开始(找不到输入框)');
        else if (!sv) missing.push('时间周期-开始(空)');
        if (!e) missing.push('时间周期-结束(找不到输入框)');
        else if (!ev) missing.push('时间周期-结束(空)');
        if (sv && ev) present.push(`时间周期=${sv}~${ev}`);
        continue;
      }
      const group = readRadioGroup(prefix);
      if (group.exists) {
        if (!group.current) missing.push(`${prefix}(未选)`); else present.push(`${prefix}=${group.current}`);
        continue;
      }
      const textInput = it.querySelector('input[placeholder],input[type=text]');
      if (textInput) {
        const v = String(textInput.value || '').trim();
        if (!v) missing.push(`${prefix}(空)`); else present.push(`${prefix}=${v.slice(0, 12)}`);
        continue;
      }
      // 既不认识、也读不到值 → 如实报出（不静默通过）
      missing.push(`${prefix}(无法判定)`);
    }
    return { ok: missing.length === 0, missing, present, required: items.length };
  }

  /** 提交：**必须点 button.dt-oui-btn 本身**（点外层 DIV 无效） */
  async function submit() {
    const btn = findSubmitButton();
    if (!btn) return { ok: false, reason: `找不到「${SR.SEL.submitButtonText}」按钮` };
    realClick(btn, document.defaultView);
    return { ok: true, reason: '' };
  }

  /** 最近一次表头读取的原始计数（供自检回报：区分"DOM 里就没有"与"读了但为空"） */
  let lastHeaderProbeInfo = null;

  /**
   * 读结果表格表头（用于从文件侧独立比对列数：2 维度列 + 指标列）。
   *
   * ✅ 实测 DOM 事实（2026-09-14）：结果视图里表头**单独一张 table**（1 行、首格是行头「统计日期」、
   *    整体维度实测 120 格 = 1 行头 + 119 列），数据行是另一张 table（31 行 × 119 格）。
   *    两者都在 `tbody`，**没有 `thead`**。
   *    ⚠️ 另一个实机坑（RB5）：表头格用 **innerText** 只读到 59 格 —— 平台结果表横向虚拟滚动/
   *    未布局的格子在 innerText 下是空串；改用 **textContent** 后才拿到全部格子。
   */
  function readResultHeaders() {
    const rows = Array.from(document.querySelectorAll('tr'));
    let best = [];
    let bestInfo = null;
    for (const r of rows) {
      const cells = Array.from(r.querySelectorAll('th,td'));
      if (cells.length < 3) continue;
      // ⚠️ 必须用 **textContent**（不是 innerText）：平台结果表是横向虚拟滚动/w 隐藏渲染，
      //    视口外或未布局的格子 innerText 会是空串 → 实测只读到 59 列（真值 119+1）。
      //    textContent 读原始 DOM 文本，不受布局/可见性影响。
      const texts = cells.map((c) => String(c.textContent || '').replace(/\s+/g, ' ').trim());
      const nonEmpty = texts.filter(Boolean);
      if (nonEmpty.length < 3) continue;
      // 判定为表头行：首格是行头「统计日期」，且含店铺列（数据行两者都不满足）→ 绝不误取
      if (nonEmpty[0] !== SR.FILE.headerDateCol) continue;
      if (!nonEmpty.includes(SR.FILE.headerStoreCol)) continue;
      if (nonEmpty.length > best.length) {
        best = nonEmpty;
        bestInfo = { cellCount: cells.length, nonEmpty: nonEmpty.length, emptyInRow: cells.length - nonEmpty.length };
      }
    }
    if (bestInfo) lastHeaderProbeInfo = bestInfo;
    return best;
  }

  /**
   * 表头读取的**自检**（排障用）：返回可观测的诊断信息，便于回答"为什么没读到表头"。
   * 2026-09-14 加入：RB1/RB3 场次出现 `页面未读到表头`（headerCheck.ok=null），
   * 而现场直读 DOM 明明有表头行 —— 必须让引擎把"它自己看到了什么"交出来，而不是靠猜。
   * 实测两种形态：① 表头单独一张 table（1 行、首格「统计日期」、120 格）；② 结果表逐行渲染、
   * 表头行只在渲染瞬间存在于 DOM。因此这里同时回报"结果视图里的指标计数"作为交叉证据。
   */
  function probeResultHeaders() {
    const vis = (el) => !!(el && el.getClientRects && el.getClientRects().length);
    const all = Array.from(document.querySelectorAll('table'));
    const tables = all.map((t) => ({
      visible: vis(t),
      rects: t.getClientRects ? t.getClientRects().length : 0,
      rows: t.querySelectorAll('tr').length,
      thCount: t.querySelectorAll('th').length,
      firstCellText: (t.querySelector('th,td') && (t.querySelector('th,td').innerText || '').trim().slice(0, 12)) || '',
    }));
    return {
      tableCount: all.length,
      tables: tables.slice(0, 4),
      headers: readResultHeaders(),
      headerRowInfo: lastHeaderProbeInfo,
      metric: readMetricCount(),
      visibilityState: document.visibilityState,
    };
  }

  /** 等结果视图出现（提交后的 SPA 切换）；同时把两类报错读出来（字段级优先） */
  async function waitForResult(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 45000);
    let lastToast = '';
    while (Date.now() < deadline) {
      const gate = assertNoStopWords();
      if (!gate.ok) return { ok: false, reason: gate.reason };
      const renameDialog = Array.from(document.querySelectorAll('[role="dialog"],.ant-modal,.next-dialog,.dt-dialog'))
        .find((element) => isVisible(element)
          && /重命名|报表名称.{0,12}(已存在|重复)|名称重复/.test(element.innerText || ''));
      if (renameDialog) {
        return { ok: false, stage: 'rename_required',
          reason: `平台要求重命名报表：${String(renameDialog.innerText || '').replace(/\s+/g, ' ').slice(0, 160)}` };
      }
      const fieldErrors = readFieldErrors();
      if (fieldErrors.length) return { ok: false, reason: `字段校验失败：${fieldErrors.join('；')}` };
      const btn = findDownloadButton();
      if (btn) return { ok: true, reason: '' };
      const toasts = readToasts();
      const incomplete = toasts.find((t) => t.includes(SR.SEL.incompleteText));
      if (incomplete) {
        return { ok: false, reason: `平台拒绝提交：${incomplete}（字段级报错：${fieldErrors.join('；') || '无'}）` };
      }
      lastToast = toasts.length ? toasts[toasts.length - 1] : lastToast;
      await sleep(500);
    }
    return { ok: false, reason: `等待结果视图超时${lastToast ? `（最后提示：${lastToast}）` : ''}` };
  }

  /** 点「下载报表」并回读（点击本身在 JS 层永远"成功"，真正的落盘由 chrome.downloads 证明） */
  async function clickDownload() {
    const btn = findDownloadButton();
    if (!btn) return { ok: false, reason: '当前不在结果视图（找不到可见的「下载报表」按钮）' };
    realClick(btn, document.defaultView);
    return { ok: true, reason: '', clickedAt: new Date().toISOString() };
  }

  /**
   * 下载催单：等下载期间再点一次「下载报表」（平台导出异步、最后一步时成时不成）。
   * 页面侧只在**确实处于结果视图**时才点，否则**明确拒绝**（诚实拒绝，不假装成功）。
   */
  async function nudgeDownload() {
    if (!inResultView()) {
      return { ok: false, reason: '当前不在结果视图，拒绝催单（避免点到"新建取数"等其它按钮）' };
    }
    const r = await clickDownload();
    if (!r.ok) return r;
    return { ok: true, reason: '已再点一次「下载报表」', clickedAt: r.clickedAt };
  }

  /**
   * 等取数表单控件渲染完成的上限（毫秒）。固定值，无随机抖动。
   * 取值理由：表单 frame 自报 HELLO 时微应用往往还在挂载，实测需要 1~3 秒；
   * 20 秒足够覆盖冷启动，又不会让"页面确实没加载出表单"的情况白等太久。
   */
  const FORM_READY_TIMEOUT_MS = 20000;

  /**
   * 参数：表头必须在**下载之前**取（点「下载报表」后 SPA 可能已经切走或重渲染）。
   * 实测有些场次结果表的表头行只在渲染瞬间存在 → 这里补一次**有界等待**（最多 6 秒），
   * 等不到也照样用自检证据如实回报（不静默、不假造）。
   */
  async function captureHeadersBeforeDownload() {
    let headers = readResultHeaders();
    if (headers.length > 0) return headers;
    const w = await waitUntil(() => {
      const h = readResultHeaders();
      return h.length > 0 ? h : false;
    }, 6000, '结果表头渲染', 400);
    // ⚠️ 必须收敛成**数组**再交回调度层：调度层会无条件 `result.headers.slice()`
    //    （RB4 场次实测：这里返回了非数组 → 后台抛 `headers.slice is not a function`，
    //     整个任务被记成一次失败尝试）。宁可返回空数组 + 自检证据，也不能让契约破掉。
    headers = (w.ok && Array.isArray(w.value)) ? w.value : [];
    return Array.isArray(headers) ? headers : [];
  }

  /**
   * 执行一个任务的完整页面侧流程（串行可见控件操作 + 每步回读断言）
   * 下载由 background 侧 chrome.downloads 接管，这里只负责点到「下载报表」
   */
  async function executeTask(task) {
    const steps = [];
    const log = (name, r) => { steps.push({ step: name, ok: !!(r && r.ok), reason: r && r.reason }); return r; };

    await checkTaskPopups();
    const gate = assertNoStopWords();
    if (!gate.ok) return { ok: false, reason: gate.reason, steps };

    // 额外筛选控件（二期初版）的检查放在**选定维度之后**（见下方 extraFilterGate 调用）：
    //   实测（关键词 / 流量核心指标）：平台对这些控件**已给好默认选中值**——
    //     关键词→分词类型 = 搜索词+长尾词（实为 **全部 5 类全选**，见 applyOptionValues 的更正）；
    //     流量核心指标→来源类型 = 商品流量+店铺流量。
    //   → 不"一律中止"，而是：等控件渲染 → 记录当前选择（留证）→ 只对"一个都没选"的控件中止
    //     （无选择才会退化成无筛选查询、产出无法判定的数据）。
    //   → 配置了 `extraFilterValues` 的控件走**严格覆盖**（只保留指定值）。

    // ✅ 硬约束（2026-09-13 实测定位）：瓴羊的动画组件在**隐藏标签页**里会被浏览器暂停 CSS 动画，
    //    日期面板会永久卡在 `dt-oui-slide-up-enter-prepare`（computed opacity:0、animationPlayState:paused），
    //    此时外部点击/Escape 都关不掉它，并且提交会被拖住（主线程长时间阻塞）。
    //    → 必须在可见标签页中操作；不可见时直接失败，由 background 先激活标签页/窗口再重试。
    if (document.visibilityState !== 'visible') {
      return {
        ok: false,
        stage: 'visibility',
        reason: '标签页当前不可见（后台标签）。实测：瓴羊日期面板在后台标签会被浏览器暂停动画而卡死，无法完成日期选择与提交。请先激活该标签页（或由 background 调用 chrome.tabs.update/windows.update）。',
        steps,
      };
    }

    if (inResultView()) {
      // 上一次的结果视图还开着 → 先回新建取数（实测「新建取数」页签不一定点得动，失败则要求刷新）
      const tab = Array.from(document.querySelectorAll('*'))
        .find((e) => (e.innerText || '').trim() === SR.SEL.tabNewFetch && e.children.length === 0);
      if (tab) { realClick(tab, document.defaultView); await sleep(2000); }
      if (inResultView()) {
        // ⚠️ 必须用 **stage:'result_before_submit'** 显式标记（README「已修复的 bug」#10）：
        //    "结果视图还在"会把"提交成功"的判据直接命中 → 假阳性。调度层据此预清场（DIAG stale_result_view_cleared）。
        return {
          ok: false,
          stage: 'result_before_submit',
          reason: '仍停留在上一次的结果视图（提交前显式拒绝，避免"提交成功"假阳性）：需要刷新页面或由调度层清场后再执行',
          steps,
        };
      }
    }

    // ✅ 关键门禁（2026-09-13 实机根因）：**等表单控件真的渲染出来再填**。
    //    表单 frame 自报 HELLO 的时刻早于瓴羊微应用渲染完成；旧写法立刻开填，实测拿到的是
    //    「「数据粒度」下没有选项「店铺」，可选：」「指标总数与预期不符：页面 0，预期 117」，
    //    随后仍会点到提交并把"提交成功"建立在残留结果视图上 → 假阳性（场次 N1 现场证据）。
    const ready = await waitUntil(
      () => !!(item('数据粒度') && item('数据维度') && item('时间粒度') && findSubmitButton()),
      FORM_READY_TIMEOUT_MS,
      '取数表单控件渲染完成',
    );
    if (!ready.ok) {
      return {
        ok: false,
        stage: 'form_ready',
        reason: `取数表单未渲染完成（微应用可能仍在挂载，或页面没加载出取数表单）：${ready.reason}`,
        steps,
      };
    }

    log('数据平台', await selectRadio('数据平台', SR.CONST.dataPlatform));
    log('数据粒度', await selectRadio('数据粒度', task.granularity));

    // ❗❗ **切「数据粒度」会异步重建下游控件**（2026-09-15 商品粒度实机实测，第一场 ITA08311 第 1 次失败的真因）：
    //    点完「数据粒度=商品」后，**「数据维度」的选项列表还是"店铺粒度那 16 项"**，
    //    此刻去选「经营投产比」→ 报 `「数据维度」下没有选项「经营投产比」，可选：整体/分小时/关键词/…`（全是店铺维度）。
    //    症状与"维度写错"**一模一样**，极易误判；实际是**选项列表尚未换新**。
    //    → 判据：切完粒度后，**等「数据维度」的选项集里真的出现目标维度**（超时则中止不提交）。
    //    ❗❗ 2026-09-15 M1r2 根因修复（**当场证据驱动**）：上面那条门禁**只等"选项集刷新"，
    //       却**从不点击选中目标维度** —— 而"选维度"原先发生在**后面**（粒度门禁之后）。
    //       后果：页面上残留着上一个维度（实测恒为 `经营投产比`），而**该维度的可用时间粒度只有分日**
    //       → 「时间粒度」选项组里**只剩 `分日`** → 后面 `grainMatched` 找 `开始月份` 恒不满足 → 必然超时。
    //       这解释了"同一次分月设置逐维度成败不同"：成败取决于**残留维度是否恰好支持分月**。
    //       → 修法：**先选中数据维度（并等单选稳定），再切时间粒度**；粒度门禁本身保持不变。
    if (task.dimension) {
      const dimOptionsHasTarget = () => {
        const g = readRadioGroup('数据维度');
        return (g.options || []).includes(task.dimension);
      };
      const dimSelectedTarget = () => readRadioGroup('数据维度').current === task.dimension;
      let dimReady = await waitUntil(dimOptionsHasTarget, 12000, `数据粒度=${task.granularity} 后「数据维度」选项集刷新出「${task.dimension}」`);
      if (!dimReady.ok) {
        // 再点一次粒度（组件偶发吞掉第一次点击）后二次确认
        log('数据粒度(重试)', await selectRadio('数据粒度', task.granularity));
        dimReady = await waitUntil(dimOptionsHasTarget, 12000, `「数据维度」选项集刷新出「${task.dimension}」（重试后）`);
      }
      if (dimReady.ok) {
        // ⭐ 关键一步：**真的选中目标维度并等单选稳定**（旧实现缺这一步）
        log('数据维度(粒度前先选)', await selectRadio('数据维度', task.dimension));
        const picked = await waitUntil(dimSelectedTarget, 10000, `数据维度=${task.dimension} 单选稳定（粒度门禁前）`);
        if (!picked.ok) {
          log('数据维度(重试)', await selectRadio('数据维度', task.dimension));
          await waitUntil(dimSelectedTarget, 10000, `数据维度=${task.dimension} 单选稳定（重试后）`);
        }
      }
      if (!dimReady.ok) {
        const opts = (readRadioGroup('数据维度').options || []);
        return {
          ok: false,
          stage: 'granularity_dimensions',
          reason: `切「数据粒度=${task.granularity}」后，「数据维度」选项集里始终没有「${task.dimension}」`
            + `（当前可选 ${opts.length} 项：${opts.slice(0, 6).join('/')}${opts.length > 6 ? '…' : ''}）→ 已中止不提交`,
          steps,
        };
      }
    }

    // ⚠️ 两步门禁必须**拆开**（2026-09-14 RBW / RBD2 两场实证），顺序与判据都不能合：
    //    ① 「时间粒度」先切、且**必须等控件形态真的换形**（分周→出现「开始周」框、分月→出现「开始月份」框）。
    //       它决定后面指标列表的总数（整体 分日=117、分周=100、分月=104）。
    //    ② 「数据维度」随后切，但**生效判据只能是"单选已选中"** —— 绝不能在这里就要求指标总数匹配：
    //       维度切换后指标列表是**异步重渲染**的，立刻拿 expected 去比会恒不满足
    //       （RBW 场次 `数据维度未生效` 三连失败、done=0/1，就是旧代码把"指标总数"塞进了这一步的判据）。
    //    ③ 指标列表刷新到预期总数这一条，统一交给**后面 `ensureMetrics(expected)`** 把关（超时中止不提交）。
    const grainMatched = () => {
      const has = (ph) => !!Array.from(document.querySelectorAll('input')).find((x) => x.placeholder === ph);
      if (task.timeGrain === '分周') return has(SR.WEEK_PICKER.startPlaceholder);
      if (task.timeGrain === '分月') return has(SR.MONTH_PICKER.startPlaceholder);
      return !has(SR.WEEK_PICKER.startPlaceholder) && !has(SR.MONTH_PICKER.startPlaceholder);
    };
    log('时间粒度', await selectRadio('时间粒度', task.timeGrain));
    // ⚠️ 2026-09-15 M1 实测：`商品` 粒度下时间周期控件的重渲染**比店铺粒度慢**，
    //    8 秒会对部分维度误判成"形态不符"（实测 5 个维度 × 多轮稳定复现，
    //    而同一组合用只读形态探针 simulate 引擎顺序却能在 10 秒内稳定成立）。
    //    → 商品粒度放宽首轮等待到 25 秒，并补一轮"再点一次 + 长等待"。
    const GRAIN_SETTLE_MS = (task.granularity === '商品') ? 25000 : 8000;
    let grainReady = await waitUntil(grainMatched, GRAIN_SETTLE_MS, `时间粒度=${task.timeGrain} 生效`);
    if (!grainReady.ok) {
      // 再点一次（组件偶发吞掉第一次点击），然后二次确认
      log('时间粒度(重试)', await selectRadio('时间粒度', task.timeGrain));
      grainReady = await waitUntil(grainMatched, GRAIN_SETTLE_MS, `时间粒度=${task.timeGrain} 生效（重试后）`);
    }
    if (!grainReady.ok) {
      // ❗ 2026-09-15 补（Codex M1r2）：**在判据超时的当场抓快照**，不等收尾再抓。
      //    收尾快照会被后续动作改动（实测拿到"数据维度=经营投产比"这种残留值），
      //    不足以定论失败瞬间的页面状态。这里当场取证，并随失败结果一起回传。
      return {
        ok: false,
        stage: 'grain',
        reason: `时间粒度未生效：${grainReady.reason}（页面控件形态与「${task.timeGrain}」不符，已中止不提交）`,
        steps,
        failureSnapshotAtGate: (() => {
          try { return failureSnapshot(); } catch (e) { return { snapshotError: String((e && e.message) || e) }; }
        })(),
        gateDiagnostics: {
          gateName: 'grainMatched',
          targetTimeGrain: task.timeGrain,
          expectedPlaceholder: task.timeGrain === '分月' ? SR.MONTH_PICKER.startPlaceholder
            : (task.timeGrain === '分周' ? SR.WEEK_PICKER.startPlaceholder : '(分日/汇总：不应出现周/月框)'),
          radioCurrent: readRadioGroup('时间粒度').current,
          radioOptions: readRadioGroup('时间粒度').options,
          dataGranularityNow: readRadioGroup('数据粒度').current,
          dataDimensionNow: readRadioGroup('数据维度').current,
          targetDimension: task.dimension,
        },
      };
    }

    // 已选中时不要再次点击：平台会异步把时间粒度重置为分日。
    log('数据维度', readRadioGroup('数据维度').current === task.dimension
      ? { ok: true, reason: '目标维度已选中，保留当前时间粒度' }
      : await selectRadio('数据维度', task.dimension));
    // ❗❗ 2026-09-14 收尾 ④ 实机发现（决定性证据）：**切换「数据维度」会把「时间粒度」重置回「分日」**。
    //     实测（同一页面连续操作）：维度=流量来源 → 粒度=分周（placeholder 变成「开始周」）→
    //     再切维度=流量核心指标 → 粒度**自己变回分日**（placeholder 回到「开始日期」）。
    //     后果极隐蔽：若粒度在维度之前设定且不再复检，导出文件会是**分日数据**，而任务标称分周；
    //     当两个粒度的指标总数相同（如 流量来源详情 20=20）时，指标总数门禁也发现不了 → 静默口径错配。
    //     → 因此这里在维度切完之后**必须重新把粒度按到位并复检控件形态**，不通过就中止不提交。
    const grainAssertStep = async (tag) => {
      const grainNow = readRadioGroup('时间粒度').current;
      if (grainNow === task.timeGrain && grainMatched()) return { ok: true, reason: `粒度仍为 ${task.timeGrain}（无需重设）` };
      log(`时间粒度复检${tag}`, await selectRadio('时间粒度', task.timeGrain));
      const back = await waitUntil(grainMatched, 8000, `时间粒度复检${tag}：${task.timeGrain} 生效`);
      if (!back.ok) return { ok: false, reason: `切维度后时间粒度被重置且无法恢复（当前 ${readRadioGroup('时间粒度').current}）：${back.reason}` };
      return { ok: true, reason: `已把被重置的粒度（${grainNow || '空'}）重新设回 ${task.timeGrain}` };
    };
    const grainRecheck = await grainAssertStep('');
    log('时间粒度复检', grainRecheck);
    if (!grainRecheck.ok) {
      return {
        ok: false,
        stage: 'grain',
        reason: `时间粒度复检失败：${grainRecheck.reason}（已中止不提交，避免"分日数据标成分周"的静默口径错配）`,
        steps,
      };
    }
    // 判据①：单选在目标维度上（PH1/PH2 实证：只看这个不够，但"不到位"足以判失败）
    const dimSelected = () => readRadioGroup('数据维度').current === task.dimension;
    let dimReady = await waitUntil(dimSelected, 8000, `数据维度=${task.dimension} 单选生效`);
    if (!dimReady.ok) {
      log('数据维度(重试)', await selectRadio('数据维度', task.dimension));
      dimReady = await waitUntil(dimSelected, 8000, `数据维度=${task.dimension} 单选生效（重试后）`);
    }
    if (!dimReady.ok) {
      return {
        ok: false,
        stage: 'dimension',
        reason: `数据维度未生效（单选不在目标维度）：${dimReady.reason}（已中止不提交）`,
        steps,
      };
    }
    // 判据②：指标列表总数与「维度 × 时间粒度」的预期一致（未知则不看）
    if (task.expectedMetricCount != null) {
      const wantTotal = Number(task.expectedMetricCount);
      const totalOk = () => {
        const mc = readMetricCount();
        return dimSelected() && readRadioGroup('时间粒度').current === task.timeGrain
          && grainMatched() && !!mc.exists && mc.total === wantTotal;
      };
      let totalReady = await waitUntil(totalOk, 12000, `指标列表刷新到 ${wantTotal}`);
      if (!totalReady.ok) {
        // 先修复异步回退的粒度；只有粒度正确而指标仍错误时才重选维度。
        const grainDrifted = readRadioGroup('时间粒度').current !== task.timeGrain || !grainMatched();
        if (!grainDrifted) {
          log('数据维度(列表刷新重试)', await selectRadio('数据维度', task.dimension));
        }
        // 重选维度可能重置粒度，必须恢复后才能等待相应指标数。
        log('时间粒度(列表刷新恢复)', await selectRadio('时间粒度', task.timeGrain));
        const recoveredGrain = await grainAssertStep('(列表刷新恢复)');
        log('时间粒度复检', recoveredGrain);
        if (!recoveredGrain.ok) {
          return { ok: false, stage: 'grain', reason: recoveredGrain.reason, steps };
        }
        totalReady = await waitUntil(totalOk, 12000, `指标列表刷新到 ${wantTotal}（重试后）`);
      }
      if (!totalReady.ok) {
        const mc = readMetricCount();
        return {
          ok: false,
          stage: 'dimension',
          reason: `指标列表未刷新到预期总数：页面 ${mc.total}，预期 ${wantTotal}`
            + `（维度=${task.dimension} × 时间粒度=${task.timeGrain}）（已中止不提交）`,
          steps,
        };
      }
    }

    // ---- 额外筛选控件（二期初版）：必须在**选定维度之后**检查（控件此时才渲染）
    if (Array.isArray(task.extraFilters) && task.extraFilters.length > 0) {
      const efReady = await waitUntil(
        () => task.extraFilters.every((lb) => !!item(lb)),
        10000,
        `额外筛选控件渲染（${task.extraFilters.join('、')}）`,
      );
      if (!efReady.ok) {
        return {
          ok: false,
          stage: 'extra_filters',
          reason: `维度「${task.dimension}」的额外筛选控件未渲染出来：${efReady.reason}（已中止不提交）`,
          steps,
        };
      }
      const overrides = (task.extraFilterValues && typeof task.extraFilterValues === 'object')
        ? task.extraFilterValues : {};
      const picked = [];
      const blank = [];
      const overridden = [];
      for (const lb of task.extraFilters) {
        const wanted = Array.isArray(overrides[lb]) ? overrides[lb] : null;
        if (wanted && wanted.length > 0) {
          // 显式覆盖：严格覆盖（多选组取消非目标项）+ 回读断言，见 applyOptionValues
          const r = await applyOptionValues(lb, wanted);
          if (!r.ok) {
            steps.push({ step: '额外筛选', ok: false, reason: `${lb}：${r.reason}` });
            return {
              ok: false,
              stage: 'extra_filters',
              reason: `维度「${task.dimension}」的额外筛选覆盖失败：${lb}（${r.reason}）（已中止不提交）`,
              steps,
            };
          }
          const detail = `${lb}=${r.chosen.join('+')}[${r.mode === 'multi-strict' ? '严格覆盖' : '单选'}`
            + (r.unchecked && r.unchecked.length ? `，已取消 ${r.unchecked.join('/')}` : '') + ']';
          overridden.push(detail);
          picked.push(detail);
          continue;
        }
        // 未配置覆盖 → 保持平台默认值，只回读留证
        const cur = readOptionChoices(lb);
        if (cur.chosen.length === 0) blank.push(lb);
        else picked.push(`${lb}=${cur.chosen.join('+')}(平台默认)`);
      }
      const efReason = picked.join('；')
        + '｜覆盖：' + (overridden.length ? overridden.join('；') : '无（全部沿用平台默认值）');
      steps.push({ step: '额外筛选', ok: blank.length === 0, reason: efReason });
      if (blank.length > 0) {
        return {
          ok: false,
          stage: 'extra_filters',
          reason: `维度「${task.dimension}」的额外筛选控件没有任何选中项：${blank.join('、')}`
            + '（继续提交会变成"无筛选查询"、产出无法判定的数据，因此显式中止）',
          steps,
        };
      }
    }
    log('数据样式', await selectRadio('数据样式', SR.CONST.dataStyle.FORMATTED));
    log('更新设置', await selectRadio('更新设置', SR.CONST.update.MANUAL));
    // 终端类型只在部分维度出现 → **有才设**（清单不能静态写死）
    if (hasField('终端类型')) log('终端类型', await selectRadio('终端类型', SR.CONST.terminal.ALL));

    // ⚠️ 终检（提交前）：时间粒度 / 数据样式 / 指标全选等**后续操作可能重置额外筛选**
    //    （同一维度内重渲染）。显式覆盖过的控件必须**再回读一次**，确认覆盖值仍在选中集合里；
    //    被平台重置却静默沿用默认值提交 = 产出与配置不符且看不出来（本项目纪律：不静默）。
    if (Array.isArray(task.extraFilters) && task.extraFilters.length > 0) {
      const overrides = (task.extraFilterValues && typeof task.extraFilterValues === 'object')
        ? task.extraFilterValues : {};
      const drifted = [];
      for (const lb of task.extraFilters) {
        const wanted = Array.isArray(overrides[lb]) ? overrides[lb] : null;
        if (!wanted || wanted.length === 0) continue;
        const now = readOptionChoices(lb).chosen;
        const lost = wanted.filter((t) => !now.includes(t));
        if (lost.length > 0) drifted.push(`${lb}（丢失：${lost.join('/')}；当前：${now.join('+') || '空'}）`);
      }
      steps.push({ step: '额外筛选终检', ok: drifted.length === 0, reason: drifted.length ? drifted.join('；') : '覆盖值仍在选中' });
      if (drifted.length > 0) {
        return {
          ok: false,
          stage: 'extra_filters',
          reason: `维度「${task.dimension}」的额外筛选覆盖在后续步骤中被重置：${drifted.join('；')}（已中止不提交）`,
          steps,
        };
      }
    }

    log('报表名称', await setReportName(task.reportName));
    // 数据样式、更新设置、终端类型和报表名称都可能触发表单重绘。
    // 上面的粒度复检发生在这些动作之前；日期选择器要在真正使用前再次确认。
    let dateGrainRestored = false;
    let dateGrainReady = await waitUntil(
      () => readRadioGroup('时间粒度').current === task.timeGrain && grainMatched(),
      4000,
      `日期设置前时间粒度=${task.timeGrain} 稳定`,
    );
    if (!dateGrainReady.ok) {
      dateGrainRestored = true;
      log('时间粒度日期前恢复', await selectRadio('时间粒度', task.timeGrain, true));
      dateGrainReady = await waitUntil(
        () => readRadioGroup('时间粒度').current === task.timeGrain && grainMatched(),
        8000,
        `日期设置前时间粒度=${task.timeGrain} 恢复`,
      );
    }
    if (!dateGrainReady.ok) {
      return {
        ok: false,
        stage: 'grain',
        reason: `日期设置前时间粒度控件未恢复：页面「${readRadioGroup('时间粒度').current || '空'}」，预期「${task.timeGrain}」；${dateGrainReady.reason}（已中止不提交）`,
        steps,
      };
    }
    steps.push({ step: '时间粒度日期前复检', ok: true, reason: `页面 ${task.timeGrain}，日期控件形态一致` });
    // 分周模式下日期控件是「时间周期」的开始周/结束周（见 setWeekRange），
    // 分月是**双面板月份区间选择器**（见 setMonthRange，内含"往回翻年"），
    // 其余粒度仍是按天点击的日期面板（setDateRange）。
    // ❗❗ 2026-09-18 修正：日期步骤**失败必须中止、不得提交**。
    //    实测（KFM1 场次）：分月选不到 2024-05 时这一步 ok=false，但执行流只 log 不中止，
    //    继续提交 → 平台打回「字段校验失败：请输入时间范围」，任务白跑 3 次并**显式留缺口**。
    //    已知无效的表单绝不能提交 —— 早失败、报清楚，比"提交后被平台打回"省一次真会话。
    const dateStep = task.timeGrain === '分周'
      ? await setWeekRange(task.startDate, task.endDate)
      : task.timeGrain === '分月'
        ? await setMonthRange(task.startDate, task.endDate)
        : await setDateRange(task.startDate, task.endDate);
    log('日期区间', dateStep);
    if (!dateStep || dateStep.ok !== true) {
      // ❗ 失败后**立刻收掉日期面板**：残留的残破面板会让**同一会话里后续每个任务**都失败
      //    （2026-09-19 SD11~SD15 实测：一个平台窗口缺口 → 整会话 25/25 全废，五会话共 125 期白跑）。
      try { await closePicker(); } catch (e) { /* 忽略 */ }
      const gapHint = dateStep && dateStep.platformUnavailable
        ? '【判据：日期格被平台禁用 ⇒ 很可能是**平台窗口缺口**（该日期平台不提供），不是引擎缺陷；别重复重试同一批日期】'
        : '';
      return {
        ok: false,
        stage: 'date_range',
        reason: `${task.timeGrain} 日期区间未设置成功：${(dateStep && dateStep.reason) || '未知原因'}`
          + `（目标 ${task.startDate} ~ ${task.endDate}）（已中止不提交）${gapHint}`,
        steps,
      };
    }
    if (dateGrainRestored) {
      // 恢复粒度后，确认先前设好的字段没有被平台连带重置。
      const drifted = [
        ['数据样式', SR.CONST.dataStyle.FORMATTED],
        ['更新设置', SR.CONST.update.MANUAL],
        ...(hasField('终端类型') ? [['终端类型', SR.CONST.terminal.ALL]] : []),
      ].filter(([label, expected]) => readRadioGroup(label).current !== expected)
        .map(([label]) => label);
      for (const [label, wanted] of Object.entries(task.extraFilterValues || {})) {
        if (!Array.isArray(wanted) || !wanted.length) continue;
        const now = readOptionChoices(label).chosen;
        if (wanted.some((value) => !now.includes(value))) drifted.push(label);
      }
      if (drifted.length) {
        return {
          ok: false,
          stage: 'form_drift',
          reason: `恢复时间粒度后字段被重置：${drifted.join('、')}（已中止不提交）`,
          steps,
        };
      }
    }

    // ❗❗ 指标全选**必须是最后一动作**（2026-09-14 RBS1 场次决定性证据）：
    //    实测在「数据样式 / 更新设置 / 终端类型 / 日期区间」之后才对指标做全选，平台会**静默回退**：
    //      指标全选时读到 `117/117`（DOM 也 117/117）→ 提交前快照却是 `57/117`（DOM 勾选 57、全部开关未选）
    //      → 导出文件**只有 59 个指标列**（比全量少 60 个），行数正常、平台不报错。
    //    把指标全选放到所有其它表单项都设完之后再执行，即可避免这次"静默丢列"（RBD4 场次 119 列实证）。
    //    指标总数**必须用调度层给定的 task.expectedMetricCount**（按「维度 × 时间粒度」取值：
    //    整体 分日=117、分周=100、分月=102；未采集的粒度为 null → 跳过严格比对并把实测值留在证据里）。
    //    ⚠️ 不能再从 SR.DIMENSIONS_STORE 现查 metricCount：那只按维度存（117），分周/分月必然误判。
    log('指标全选', await ensureMetrics(task.expectedMetricCount == null ? null : Number(task.expectedMetricCount)));

    // ✅ 硬门禁：关键步骤失败**必须中止**，绝不带着错配置提交（旧写法只记证据不中止）。
    const CRITICAL_STEPS = ['数据粒度', '数据维度', '时间粒度', '时间粒度复检', '指标全选'];
    const brokenSteps = steps.filter((s) => CRITICAL_STEPS.includes(s.step) && !s.ok);
    if (brokenSteps.length) {
      return {
        ok: false,
        stage: 'steps',
        reason: `关键步骤失败，已中止（未提交）：${brokenSteps.map((s) => `${s.step}（${s.reason || '未知原因'}）`).join('；')}`,
        steps,
      };
    }

    // ✅ 提交前**数据完整性终检**（2026-09-14 新加，代价很高的一次教训见 README「59 列事件」）：
    //    平台允许"导出时指标集合 ≠ 页面上显示的指标集合"——实测出现过页面 117/117、导出文件却只有
    //    59 个指标列（行数照旧、不报错），属于**静默丢列**。因此提交前再确认一次指标列表总数，
    //    与「维度 × 时间粒度」的预期一致，否则中止不提交（宁可失败，也不要产出缺列的数据）。
    if (task.expectedMetricCount != null) {
      const mc = readMetricCount();
      const want = Number(task.expectedMetricCount);
      if (!mc.exists || mc.total !== want) {
        return {
          ok: false,
          stage: 'metric_total',
          reason: `提交前指标总数终检不过：页面 ${mc.total}，预期 ${want}（维度=${task.dimension} × 时间粒度=${task.timeGrain}）`
            + '（已中止不提交：平台存在"导出集合 ≠ 页面显示集合"的静默丢列风险）',
          steps,
        };
      }
      steps.push({ step: '指标总数终检', ok: true, reason: `页面 ${mc.total} == 预期 ${want}（${mc.domChecked}/${mc.domItems} 已选${mc.domWindowed ? '，窗口化' : ''}）` });
      // 提交前的**指标区快照**（排障用，2026-09-14 加）：
      //   实测出现过"计数器 117/117、导出只有 59 列（恰好少 60 个指标）"的静默丢列，
      //   必须把提交瞬间的原始 DOM 计数与"全部"开关状态留在证据里，否则事后无法定位。
      const itm = item('选择指标');
      const wrapsAll = itm ? Array.from(itm.querySelectorAll(SEL_ANY([SR.SEL.checkboxWrapper, SR.SEL.radioWrapper]))) : [];
      const groupAll = wrapsAll.filter((w) => w.classList && w.classList.contains('dt-oui-checkbox-group-item'));
      const allToggle = wrapsAll.find((w) => !(w.classList && w.classList.contains('dt-oui-checkbox-group-item')));
      steps.push({
        step: '指标区快照',
        ok: true,
        reason: `计数器=${mc.selected}/${mc.total}；DOM 项=${groupAll.length}，勾选=${groupAll.filter((w) => SR.isChecked(w)).length}`
          + `；「全部」开关=${allToggle ? (SR.isChecked(allToggle) ? '选中' : '未选') : '未找到'}`,
      });
    }

    // ✅ 提交前的**粒度终检**（2026-09-14 收尾 ④ 新加）：
    //    实测"切数据维度会重置时间粒度"（见上面的时间粒度复检注释）。这里在提交前再确认一次
    //    粒度单选 + 控件形态；不符就**中止不提交** —— 宁可失败，也不要产出"标称分周、实为分日"的数据。
    {
      const grainNow = readRadioGroup('时间粒度').current;
      if (grainNow !== task.timeGrain || !grainMatched()) {
        return {
          ok: false,
          stage: 'grain',
          reason: `提交前时间粒度终检不过：页面「${grainNow || '空'}」，预期「${task.timeGrain}」`
            + '（实测切数据维度会把粒度重置为分日；已中止不提交，避免静默口径错配）',
          steps,
        };
      }
      steps.push({ step: '时间粒度终检', ok: true, reason: `页面 ${grainNow} == 预期 ${task.timeGrain}（控件形态一致）` });
    }

    const req = assertRequiredComplete();
    if (!req.ok) {
      // ⚠️ 必须把**同轮失败步骤**一起报出来：否则后面的必填项检查会盖掉真正的失败原因
      //（实机 X3/X4：周选择器自己的原因被"必填项未齐：时间周期-开始日期(空)"掩盖，产物里查不到）
      const bad = steps.filter((s) => !s.ok).map((s) => `${s.step}（${s.reason || '未知原因'}）`);
      return {
        ok: false,
        stage: 'required',
        reason: `必填项未齐：${req.missing.join('、')}`
          + (bad.length ? `｜同轮失败步骤：${bad.join('；')}` : '')
          + `（已中止不提交；已确认项：${req.present.join('、') || '无'}）`,
        steps,
      };
    }

    // ⭐⭐ 2026-09-17（Codex《0140矩阵复核与最终缺口》第 3 节第 2 条）：**提交前验证（dry-run）**。
    //
    // Codex 原话：「品类整体汇总修正后执行一次**提交前**验证：以现有测试窗口、类目选项核验任务身份、
    //   13 项指标、当前类目值、终端不适用及任务构建；**在提交前停止，不新建重复任务**。」
    //
    // 实现位置是刻意的：**放在所有提交前门禁之后、`submit()` 之前**。
    //   · 之前：粒度/维度/指标总数/额外筛选/终检/必填项 —— 全部真跑一遍（失败就照旧中止）；
    //   · 之后：`submit()` 与一切"建会话/等结果/点下载"的动作 —— **一律不执行**。
    // 因此 dry-run **不建采集会话、不导出、不产生任何产物**，却能把"真到提交前那一刻页面到底是什么样"取回来。
    if (task.dryRun === true) {
      const snap = (label) => {
        const g = readRadioGroup(label);
        return g.exists
          ? { exists: true, current: g.current, options: g.options, checkedCount: g.checkedCount,
            checkedLabels: g.checkedLabels }
          : { exists: false };
      };
      const mc = readMetricCount();
      const efDetail = {};
      for (const lb of (Array.isArray(task.extraFilters) ? task.extraFilters : [])) {
        const choices = readOptionChoices(lb);
        const g = readRadioGroup(lb);
        efDetail[lb] = {
          declaredForThisTask: true,
          exists: !!g.exists,
          current: g.current,
          options: g.options,
          optionCount: (g.options || []).length,
          checkedCount: g.checkedCount,
          checkedLabels: g.checkedLabels,
          chosenNow: choices.chosen,
          taskOverride: (task.extraFilterValues || {})[lb] || null,
        };
      }
      // 「终端类型」在这个 (粒度,维度,时间粒度) 下到底适不适用 —— **按页面实探**，不按声明推断
      const terminalGroup = readRadioGroup('终端类型');
      const dryRun = {
        schema: 'sr-dryrun-evidence/1',
        at: new Date().toISOString(),
        note: '**提交前验证**：已跑完全部提交前门禁与必填项检查，然后**在 submit() 之前停止**。'
          + '未建采集会话、未提交、未导出、未点下载 —— 因此**没有**产生任何产物。',
        task: {
          key: task.key, storeId: task.storeId, storeName: task.storeName,
          granularity: task.granularity, dimension: task.dimension, dimensionCode: task.dimensionCode,
          timeGrain: task.timeGrain, dateRange: task.dateRange, chunkUnit: task.chunkUnit,
          expectedMetricCount: task.expectedMetricCount == null ? null : Number(task.expectedMetricCount),
          extraFilters: Array.isArray(task.extraFilters) ? task.extraFilters.slice() : [],
          extraFilterValues: task.extraFilterValues || {},
          reportName: task.reportName,
          reportNameLength: String(task.reportName || '').length,
          dryRun: true,
        },
        page: {
          radios: {
            数据平台: snap('数据平台'), 数据粒度: snap('数据粒度'),
            数据维度: snap('数据维度'), 时间粒度: snap('时间粒度'),
            数据样式: snap('数据样式'), 更新设置: snap('更新设置'),
          },
          terminalType: {
            applicable: !!terminalGroup.exists,
            bindingNote: '「终端类型」是否适用按**当前页面实探**给出（exists），不按任何声明推断；'
              + '不适用的粒度（实测：客户整档）在这里就是 exists=false。',
            detail: terminalGroup.exists
              ? { current: terminalGroup.current, options: terminalGroup.options,
                checkedCount: terminalGroup.checkedCount, checkedLabels: terminalGroup.checkedLabels }
              : null,
          },
          metrics: {
            counterExists: !!mc.exists,
            selected: mc.selected, total: mc.total,
            domChecked: mc.domChecked, domItems: mc.domItems, domWindowed: mc.domWindowed,
            rawText: String(mc.raw || '').slice(0, 200),
            equalsExpected: task.expectedMetricCount == null ? null : (mc.total === Number(task.expectedMetricCount)),
          },
          extraFiltersOnPage: efDetail,
          reportNameField: (() => {
            const field = item('输入报表名称');
            if (!field) return { exists: false };
            const inputs = Array.from(field.querySelectorAll('input'));
            return { exists: true, values: inputs.map((i) => String(i.value || '')) };
          })(),
          periodInputs: Array.from(document.querySelectorAll('input'))
            .filter((i) => i.placeholder)
            .map((i) => ({ placeholder: i.placeholder, value: String(i.value || '') }))
            .slice(0, 12),
          requiredCheck: { ok: true, present: req.present, missing: req.missing },
        },
        gatesPassedBeforeStop: steps.filter((s) => s.ok).map((s) => s.step),
        gateFailuresBeforeStop: steps.filter((s) => !s.ok).map((s) => ({ step: s.step, reason: s.reason })),
        steps,
      };
      // ❗ 2026-09-18 修正：DRYRUN 的 ok **必须反映门禁是否真的全过**。
      //    实测教训（KFM1 场次）：分月选不到历史月份时 `日期区间` 这一步 ok=false，
      //    但这里仍旧返回 `ok:true` → 我据此误判"分月验证通过"，直到真跑 28 期全废才发现。
      //    语义纠正：DRYRUN 的 ok = "提交前门禁**全部**通过"，任何 gateFailures 都必须是 ok:false。
      const failedGates = dryRun.gateFailuresBeforeStop;
      return {
        ok: failedGates.length === 0,
        stage: failedGates.length === 0 ? 'dry_run_stopped_before_submit' : 'dry_run_gate_failed',
        reason: failedGates.length === 0
          ? ''
          : `提交前门禁未全过（${failedGates.length} 项）：`
            + failedGates.map((g) => `${g.step}→${String(g.reason || '').slice(0, 120)}`).join('；'),
        steps,
        dryRun,
      };
    }

    await checkTaskPopups();
    popupSubmissionStarted = true; // Never rewind a report after submission may have occurred.
    const sub = await submit();
    if (!sub.ok) {
      return { ok: false, stage: 'submit', reason: `提交失败：${sub.reason}`, steps };
    }
    steps.push({ step: '提交', ok: true, reason: '' });

    const result = await waitForResult(Number(task.timeoutMs || 45000));
    if (!result.ok) {
      if (result.stage === 'rename_required') {
        return { ok: false, stage: 'rename_required', reason: result.reason, steps };
      }
      return { ok: false, stage: 'result', reason: `提交后未出现结果视图：${result.reason}`, steps };
    }

    const headers = await captureHeadersBeforeDownload();
    // 把"表头自检"一起交回调度层（写进 exportEvidence.steps），否则"为什么没读到表头"只能靠猜
    const headerProbe = probeResultHeaders();
    if (headers.length === 0) {
      steps.push({
        step: '表头自检',
        ok: false,
        reason: `页面未读到表头：${JSON.stringify(headerProbe).slice(0, 400)}`,
      });
    } else {
      steps.push({ step: '表头自检', ok: true, reason: `读到 ${headers.length} 列：${headers.slice(0, 3).join('/')}…` });
    }
    // ❗ 平台自报行数（**下载前**取，与表头同理：点下载后 SPA 可能切走）
    //    用途：检出"平台静默截断在 10 万行"（文件在、行数正常、平台不报错，但数据少了）。
    const rowCountInfo = readResultRowCount();
    steps.push({
      step: '行数证据',
      ok: rowCountInfo.rowCount != null || rowCountInfo.overCap,
      reason: rowCountInfo.overCap
        ? `❗平台明示超过单次下载上限（原文「${rowCountInfo.overCapRaw}」，上限 ${(SR.PLATFORM && SR.PLATFORM.rowCap) || 100000} 行）→ 本次产物**必然被截断**，需按更细粒度分片重取`
        : (rowCountInfo.rowCount != null
          ? `平台自报 ${rowCountInfo.rowCount} 行（原文「${rowCountInfo.raw}」，上限 ${(SR.PLATFORM && SR.PLATFORM.rowCap) || 100000} 行）`
          : '结果视图既无「共N条数据」也无超限警告（行数**未知**，既不能判截断也不能当安全）'),
    });
    const dl = await clickDownload();
    steps.push({ step: '点击下载', ok: dl.ok, reason: dl.reason || '' });
    if (!dl.ok) {
      return { ok: false, stage: 'download_click', reason: `点击下载失败：${dl.reason}`, steps, headers: Array.isArray(headers) ? headers : [], headerProbe, rowCount: rowCountInfo.rowCount, rowCountRaw: rowCountInfo.raw, overCapWarning: rowCountInfo.overCap, overCapWarningRaw: rowCountInfo.overCapRaw };
    }
    return {
      ok: true,
      reason: '',
      steps,
      headers: Array.isArray(headers) ? headers : [],
      headerProbe,
      rowCount: rowCountInfo.rowCount,
      rowCountRaw: rowCountInfo.raw,
      overCapWarning: rowCountInfo.overCap,
      overCapWarningRaw: rowCountInfo.overCapRaw,
    };
  }

  /**
   * 从「选择指标」字段的原文里**切出"维度列"与"指标列"**。
   *
   * ⚠️ 2026-09-15 实测教训（第一版枚举探针的 bug）：
   *   切完「数据维度」后立刻读计数，读到的是**上一个维度**的残留值（指标列表是异步重渲染的），
   *   所以第一版输出的"每维指标数"整体错位了一行。→ 判据必须是"**读数前列表已稳定**"，
   *   而不是"睡固定毫秒数"。
   *
   * 字段原文形如：`选择指标 全部 选择130/130重置 商品ID 商品名称 … 支付金额 …`
   *   · `维度列` = 开头那段**非指标列**（如 商品ID/商品名称/品牌名称/一级类目名称…）；
   *     它同时也是判据：**结束于最后一个已知维度列名**，之后就是指标列。
   *   · `指标列` = 其余（平台「选择指标」里的那些）。
   * 拆分依据是**已知的维度列名清单**（平台在商品粒度下会出现的分组维度列），不靠猜数字。
   */
  const ENUM_DIMENSION_COLS = [
    '商品ID', '商品名称', '商品标题', 'SKU', 'ID', 'SKU名称',
    '品牌名称', '一级类目名称', '二级类目名称', '叶子类目名称', '商品状态',
    '关联商品ID', '关联商品名称', '流量时期', '人群类型', '来源类型', '流量来源',
    '上级来源名称', '来源名称', '来源层级', '来源明细ID', '归属原则',
    '搜索词类型', '搜索词', '时间类型', '退款场景', '退款后状态', '退款时间',
    '退款识别类型', '退款原因类型', '退款原因', '流失商家ID', '流失商品ID',
  ];

  function splitMetricField(rawText) {
    const text = String(rawText || '')
      .replace(/^选择指标/, '')
      .replace(/^\s*全部/, '')
      .replace(/^[\s\S]*?选择\s*\d+\s*\/\s*\d+\s*重置/, '')
      .trim();
    const tokens = text.split(/\s+/).filter(Boolean);
    const dimCols = [];
    const metricCols = [];
    let lastDimIdx = -1;
    for (let i = 0; i < tokens.length; i += 1) {
      if (ENUM_DIMENSION_COLS.includes(tokens[i])) lastDimIdx = i;
    }
    for (let i = 0; i < tokens.length; i += 1) {
      if (i <= lastDimIdx) dimCols.push(tokens[i]);
      else metricCols.push(tokens[i]);
    }
    return { dimCols, metricCols, tokens };
  }

  // ---------------------------------------------------------------- 只读探针公用小工具（2026-09-17 新增）
  /**
   * 等「选择指标」字段文字**稳定**（连续两次读数一致 = 3 次采样同值）。
   * ❗ 为什么必须有：切维度/切粒度后指标列表是**异步重渲染**的，立刻读数会拿到**上一个维度**的残留值。
   *    本函数原先是 `enumerateGranularity` 的内部函数，2026-09-17 提为公用（只读证据探针同样需要）。
   */
  async function waitMetricFieldStable(timeoutMs, pollMs) {
    let prev = null;
    let hits = 0;
    const r = await waitUntil(() => {
      const now = readMetricCount().raw;
      if (now && now === prev) hits += 1; else hits = 0;
      prev = now;
      return hits >= 2;
    }, timeoutMs || 12000, '「选择指标」列表稳定', pollMs || 400);
    return { ok: !!r.ok, raw: readMetricCount().raw, reason: r.reason };
  }

  /**
   * ⭐ 表单**面板指纹**（2026-09-17 新增，为 Codex「控件冲突」与「切粒度后旧筛选值是否被静默带入」两条要求服务）。
   *
   * 组成：`字段标签集合` + `字段数` + `表单总文本长度` + `「选择指标」原文`。
   *   · 切**数据维度** / 切**时间粒度** → 标签集合或指标列表**必然变化** → 指纹改变；
   *   · 指纹**没变** = 面板还没重渲染 ⇒ 此刻读到的东西可能仍是**上一个维度/粒度**的 ⇒ 判**无效读数**。
   *
   * ❗ 为什么不能沿用旧的"控件存在性签名"当稳定判据（实测踩过的坑）：
   *    旧判据只有 17 位（未声明控件名的一个子集 in/out）——**锁在旧面板上照样"连续两次一致"**，
   *    于是"稳定"了却读的是别人的面板（`品类/流量来源` 因此被误报成有 `终端类型+类目`，
   *    引擎照声明去等 → 3 连 `failed_permanent`）。
   */
  function formPanelFingerprint() {
    try {
      const items = Array.from(document.querySelectorAll(SR.SEL.formItem));
      const labels = items.map((it) => {
        const lab = it.querySelector(SR.SEL.formItemLabel);
        return lab ? String(lab.innerText || '').replace(/\s+/g, ' ').trim() : '';
      }).filter(Boolean);
      const textLen = items.reduce((n, it) => n + String(it.innerText || '').length, 0);
      const metricRaw = String(readMetricCount().raw || '');
      // ⚠️ `textLen` 只取**粗桶**（÷100）参与指纹：逐字长度会被光标/倒计时/提示文案之类的小幅变化抖动，
      //    直接进指纹会让"连续 3 次一致"永远不成立；取粗桶既保留"面板整体变了一大截"的灵敏度，又不抖。
      const textBucket = Math.round(textLen / 100);
      return {
        labelCount: items.length,
        labels: labels.slice(0, 60),
        textLen,
        metricRaw,
        fp: labels.slice(0, 60).join('|') + '§' + items.length + '§' + textBucket + '§' + metricRaw,
      };
    } catch (e) {
      return { labelCount: null, labels: [], textLen: null, metricRaw: '', fp: 'ERR:' + String(e && e.message || e) };
    }
  }

  /** 单个筛选控件的**取值签名**（当前值 + 选项全集 + 实读勾选标签）。用于"同名控件前后取值是否逐字相同"。 */
  function filterValueSig(f) {
    if (!f || !f.exists) return 'absent';
    return JSON.stringify([f.current == null ? null : f.current, f.options || [], f.checkedLabels || []]);
  }

  /**
   * ⭐ 通用只读探针：**枚举指定「数据粒度」下平台真实提供什么**（2026-09-15 新增，为二期「商品」粒度服务）。
   *
   * 为什么必须有它（而不是照 `DIMENSIONS_PHASE2` 的名字清单去猜）：
   *   本仓的既有教训是"**我们读不出平台的值，比平台不接受我们的值更常见**"（HANDOFF §3.2 第 1 条），
   *   以及"**指标总数写错会让生效判据恒不满足 → failed_permanent**"（`流量来源详情` 曾把 20 写成 24）。
   *   二期粒度（商品/客户/品类）目前**一个字都没实采**，所以：
   *     · 维度名清单 → **从页面实读**（不信占位表）
   *     · 每个维度的指标总数 → **从「选择指标」计数器实读**（唯一权威，见 readMetricCount）
   *     · 每个维度的合法时间粒度 → **逐个试切 + 读单选选项集**
   *   探针**不提交任何任务**（只切单选、读文本），跑完把原粒度/维度**还原**。
   *
   * ⚠️ `mode==='dimensions'` = 只枚举维度清单 + 走一遍粒度切换（快，用于列长名单）；
   *    `mode==='one'` = **只仔细探查一个维度**（慢但准：等指标列表稳定后再读数）——
   *    因为"切维度后立刻读计数会读到上一个维度的残留值"（2026-09-15 实测踩到）。
   */
  async function enumerateGranularity(targetGranularity, dimensionLimit, mode, onlyDimension) {
    const steps = [];
    const log = (name, detail) => steps.push({ name, ok: detail == null ? true : !!(detail && detail.ok !== false), detail: detail == null ? '' : detail });
    const out = {
      ok: true,
      probe: 'ENUMERATE',
      mode: mode || 'dimensions',
      targetGranularity: String(targetGranularity || '商品'),
      granularityBefore: null,
      granularityAfter: null,
      dimensionOptions: [],
      dimensions: [],
      timeGrainCandidates: {},
      notes: [],
      steps,
    };

    const dimOptionsSig = () => JSON.stringify(readRadioGroup('数据维度').options || []);
    const grainOptionsSig = () => JSON.stringify(readRadioGroup('时间粒度').options || []);

    // 等表单就绪（与 executeTask 同一判据）
    const ready = await waitUntil(
      () => !!(item('数据粒度') && item('数据维度') && item('时间粒度')),
      FORM_READY_TIMEOUT_MS,
      '取数表单控件渲染完成（枚举探针）',
    );
    if (!ready.ok) {
      out.ok = false;
      out.notes.push('表单未渲染完成：' + ready.reason);
      return out;
    }

    const before = readRadioGroup('数据粒度');
    out.granularityBefore = before.current;
    out.granularityOptions = before.options;
    if (!(before.options || []).includes(out.targetGranularity)) {
      out.ok = false;
      out.notes.push(`「数据粒度」里没有「${out.targetGranularity}」这个选项（实读可选：${(before.options || []).join(' / ') || '无'}）`);
      return out;
    }

    // ---- 切到目标粒度，并等「数据维度」选项集**稳定**（异步重渲染，不能立刻读）
    log('数据粒度', await selectRadio('数据粒度', out.targetGranularity));
    let lastSig = null;
    let stable = 0;
    const stableWait = await waitUntil(() => {
      const sig = dimOptionsSig();
      if (sig && sig !== '[]' && sig === lastSig) stable += 1; else stable = 0;
      lastSig = sig;
      return stable >= 2;          // 连续 3 次读到同一套维度选项 → 认为已稳定
    }, 15000, `数据粒度=${out.targetGranularity} 的维度列表稳定`, 500);
    if (!stableWait.ok) out.notes.push('维度列表稳定等待超时，下面的结果可能是在渲染中途读到的：' + stableWait.reason);

    const dimGroup = readRadioGroup('数据维度');
    out.dimensionOptions = dimGroup.options || [];
    out.dimensionCurrentAfterSwitch = dimGroup.current;
    log('数据维度选项集', { ok: true, reason: `${out.dimensionOptions.length} 项` });

    // ---- 逐个维度：读指标计数 + 逐个试切时间粒度
    const dimsToScan = mode === 'one' && onlyDimension
      ? [String(onlyDimension)]
      : out.dimensionOptions.slice(0, Number(dimensionLimit) > 0 ? Number(dimensionLimit) : out.dimensionOptions.length);
    out.scanned = dimsToScan;

    // `waitMetricFieldStable` 已提为文件级公用函数（只读探针也要用同一套"稳定"判据）
    for (const dimName of dimsToScan) {
      const entry = { name: dimName, metricCount: null, metricRaw: '', extraFilters: [], timeGrains: [], notes: [] };
      try {
        const sel = await selectRadio('数据维度', dimName);
        if (sel && sel.ok === false) entry.notes.push('选中维度失败：' + (sel.reason || ''));
        // ❗❗ 先等**单选真的生效**，再等字段稳定 —— 两步缺一不可。
        //    2026-09-15 实测踩到：`mode='one'` 分支漏了"等单选生效"这一步 → 探针读到的是
        //    **上一个维度的残留值**（实测 `退款SKU分布` 被读成 130 个指标、列名是「经营投产比」的），
        //    进而"筛选项存在与否"的判定也是错的。任何"读了 A 却拿到 B"都要先怀疑这一步。
        const dimNow = await waitUntil(() => readRadioGroup('数据维度').current === dimName, 8000,
          `数据维度=${dimName} 生效（枚举探针）`, 300);
        if (!dimNow.ok) entry.notes.push('等维度单选生效超时：' + dimNow.reason);
        // 切维度会把「时间粒度」重置为分日，且**指标列表是异步重渲染的** ——
        //    必须等它**内容稳定**再读数（睡固定毫秒会读到上一个维度的残留值，整体错位一行）。
        const stableRead = await waitMetricFieldStable(15000, 400);
        if (!stableRead.ok) entry.notes.push('指标列表稳定等待超时：' + stableRead.reason);

        const mc = readMetricCount();
        entry.metricCount = mc.total;
        entry.metricSelected = mc.selected;
        entry.metricRaw = mc.raw;
        entry.domChecked = mc.domChecked;
        entry.domItems = mc.domItems;
        entry.domWindowed = mc.domWindowed;
        const split = splitMetricField(mc.raw);
        entry.dimensionCols = split.dimCols;
        entry.metricCols = split.metricCols;
        entry.metricColsCount = split.metricCols.length;

        // 额外筛选控件：以**页面实探**为准（`item(控件名)` 真能读到才算），
        // ⚠️ 且必须查**该粒度自己的维度表**（旧版查 SR.DIMENSIONS_STORE，商品粒度实探时
        //    报的是店铺粒度的名单 → 误导了"哪个控件真的存在"的判断，2026-09-15 踩到）。
        // ❗❗ 2026-09-16（客户/品类开发）：**粒度表可能还不存在**（枚举探针正是为了建它）。
        //    旧写法 `商品 ? DIMENSIONS_ITEM : DIMENSIONS_STORE` 会把客户/品类**当成店铺**去查表 →
        //    拿到的"声明控件"是店铺的。现在改为**按粒度取表，取不到就为空 + 明写 note**，
        //    真正的判据一律用下面的 `filterControlsFound`（页面实探），不靠声明。
        const tableByGranularity = {
          店铺: SR.DIMENSIONS_STORE,
          商品: SR.DIMENSIONS_ITEM,
          客户: SR.DIMENSIONS_CUSTOMER,
          品类: SR.DIMENSIONS_CATEGORY,
        };
        const granTableRaw = tableByGranularity[out.targetGranularity];
        // ⚠️ 空数组要当"没有表"处理（`[]` 在 JS 里是 truthy，直接 `|| null` 会漏判）
        const granTable = (Array.isArray(granTableRaw) && granTableRaw.length) ? granTableRaw : null;
        if (!granTable) {
          entry.notes.push(`该粒度（${out.targetGranularity}）尚无维度表 → `
            + '`extraFilters` 只能靠 `filterControlsFound`（页面实探）；请以实探结果为准');
        }
        entry.extraFilters = (granTable || [])
          .filter((d) => d.name === dimName).map((d) => d.extraFilters || [])[0] || null;
        try {
          const probes = ['分词类型', '来源类型', '流量时期', '人群类型', '转化效果归属',
            '搜索来源', '时间类型', '退款场景', '退款后状态', '退款时间', '商品范围', '是否有效商品',
            '商品状态', '类目'];
          entry.filterControlsFound = probes.filter((p) => !!item(p));
        } catch (e) { entry.notes.push('读额外筛选控件失败：' + String(e && e.message || e)); }

        // 逐个试切时间粒度：候选 = 该维度当前选项集（可能随维度变化）
        const grainGroup0 = readRadioGroup('时间粒度');
        out.timeGrainCandidates[dimName] = grainGroup0.options || [];
        for (const g of (grainGroup0.options || [])) {
          const gsel = await selectRadio('时间粒度', g);
          if (gsel && gsel.ok === false) { entry.timeGrains.push({ grain: g, ok: false, reason: gsel.reason || '选中失败' }); continue; }
          const okWait = await waitUntil(() => readRadioGroup('时间粒度').current === g, 4000, `时间粒度=${g} 生效`, 250);
          const stable2 = await waitMetricFieldStable(12000, 400);
          const mc2 = readMetricCount();
          entry.timeGrains.push({
            grain: g,
            ok: !!okWait.ok,
            metricStable: !!stable2.ok,
            metricCount: mc2.total,
            metricSelected: mc2.selected,
            metricRaw: mc2.raw,
            grainOptionsNow: readRadioGroup('时间粒度').options || [],
          });
        }
        // 还原为分日（减少对后续动作的干扰）
        await selectRadio('时间粒度', '分日');
      } catch (e) {
        entry.notes.push('枚举异常：' + String(e && e.message || e));
      }
      out.dimensions.push(entry);
    }

    // ---- 还原原始粒度
    if (out.granularityBefore && out.granularityBefore !== out.targetGranularity) {
      await selectRadio('数据粒度', out.granularityBefore);
      await sleep(400);
    }
    out.granularityAfter = readRadioGroup('数据粒度').current;
    out.dimensionAfter = readRadioGroup('数据维度').current;
    log('还原粒度', { ok: true, reason: `${out.granularityBefore} → ${out.granularityAfter}` });
    return out;
  }

  /**
   * ⭐ 只读证据探针（2026-09-15 新增，供 Codex r4 的 P1 要求）：
   * 读**当前页面上**的「终端类型」与各维度「额外筛选控件」的 **当前值 + 可见选项**，并留证。
   *
   * 边界（Codex 明确要求，代码里逐条落实）：
   *   · **只读**：不提交、不建采集会话、不下载产物；跑完把原始的粒度/维度**还原**；
   *   · 每条记录必须带 `pageUrl` / `capturedAt` / `evidenceSource`(页面控件实读)；
   *   · **区分"没有该控件"与"有控件但没读到"**：`exists:false` vs `exists:true, readOk:false`；
   *   · **不写任何账号凭据/Cookie/Token**（本函数只读 DOM 文本与表单值）；
   *   · 不追认为历史产物的筛选值 —— 是否关联某个 sessionId 由**调用方**决定并写在自己的字段里。
   *
   * 采集范围：`数据平台` / `数据粒度` / `数据维度` / `时间粒度` / `终端类型`，
   * 以及该维度声明的 `extraFilters` 逐个控件。
   */
  async function captureReadOnlyFilters(granularity, dimensions, grain, grains) {
    const capturedAt = new Date().toISOString();
    const pageUrl = String(location.href || '');
    // ⭐ 2026-09-17（Codex「客户品类首轮验收意见」第 4/5 条）：**逐时间粒度**读控件。
    //    `grains`（数组，按顺序逐个切、逐个读）优先；否则退回单值 `grain`；都不给 = 读当前粒度一次。
    const grainList = (Array.isArray(grains) && grains.length)
      ? grains.map((g) => String(g))
      : (grain ? [String(grain)] : [null]);
    const out = {
      ok: true,
      // ❗❗ 2026-09-16（Codex W1r2 第 3 条）：**"执行成功" ≠ "读数有效"**。
      //    `ok` = 探针是否跑完；`readValid` = 读到的内容是否可信（控件与选项都渲染出来且实读到）。
      //    默认 false，只有过了下面的有效性检查才置 true。**调用方必须看 readValid，不能只看 ok。**
      readValid: false,
      readValidityNote: null,
      probe: 'READONLY_FILTERS',
      capturedAt, pageUrl,
      evidenceSource: '当前页面控件的实读值（只读；未提交、未建会话、未下载）',
      granularity: String(granularity || '店铺'),
      scopesHonesty: '仅代表本次观察；未与任何历史产物关联，不得回填为历史产物的筛选值',
      grainsRequested: grainList.slice(),
      radios: {},
      terminalType: null,
      extraFilters: {},
      unreadable: [],
      notes: [],
    };
    const snap = (label) => {
      const g = readRadioGroup(label);
      if (!g.exists) return { exists: false, readOk: false, note: '页面上没有该控件（与"有控件但没读到"不同）' };
      return { exists: true, readOk: true, current: g.current, options: g.options, optionCount: g.options.length };
    };

    const ready = await waitUntil(() => !!(item('数据粒度') && item('数据维度') && item('时间粒度')),
      FORM_READY_TIMEOUT_MS, '取数表单控件渲染完成（只读证据探针）');
    if (!ready.ok) {
      out.ok = false;
      out.readValid = false;
      out.notes.push('表单未渲染完成：' + ready.reason);
      return out;
    }
    // ❗❗ 2026-09-16（Codex W1r2 第 3 条）：**"执行成功"必须与"读数有效"分开**。
    //    实测踩到：第一次导航时 label 已在、**选项还没渲染** → 探针抓回空 options，
    //    但 `ok` 仍是 true，看起来成功、其实什么都没读到（还被误读成"平台没有该控件"）。
    //    → 这里显式等"选项真的渲染出来"，并把有效性单独建字段 `readValid` / `readValidityNote`。
    const optionsReady = await waitUntil(() => {
      const g = readRadioGroup('数据粒度');
      const d = readRadioGroup('数据维度');
      return !!(g.options && g.options.length) && !!(d.options && d.options.length);
    }, FORM_READY_TIMEOUT_MS, '数据粒度/数据维度**选项**渲染完成（只读证据探针）');
    if (!optionsReady.ok) {
      out.ok = true;                    // 执行本身完成了……
      out.readValid = false;            // ……但读数无效
      out.readValidityNote = ('控件标签存在但**选项未渲染**（' + optionsReady.reason + '）→ '
        + '本次读数为**无效读数**，不得据此推断"平台没有该控件/该维度"。');
      out.notes.push(out.readValidityNote);
      out.radios['数据粒度'] = snap('数据粒度');
      out.radios['数据维度'] = snap('数据维度');
      return out;
    }

    for (const lb of ['数据平台', '数据粒度', '数据维度', '时间粒度']) out.radios[lb] = snap(lb);

    const targetGran = out.granularity;
    const granGroup = readRadioGroup('数据粒度');
    if ((granGroup.options || []).includes(targetGran) && granGroup.current !== targetGran) {
      await selectRadio('数据粒度', targetGran);
      await waitUntil(() => readRadioGroup('数据粒度').current === targetGran, 8000,
        `数据粒度=${targetGran} 生效（只读证据探针）`, 300);
      // ❗❗ 2026-09-16 实测的**第二种竞态**：切完粒度后 `数据维度` 列表要重渲染，
      //    若立刻读选项，**第一个被检查的维度会假阴性**（被报成"该粒度下没有该维度"）。
      //    实测证据：`经营投产比` 在缺省顺序（表里第一个）下被判不存在，
      //    放到 `sr_dimlist=整体,经营投产比`（第二个）后正常读出控件。
      //    → 这里等到"维度列表已包含目标粒度的维度集合"再继续。
      const wantDims = (targetGran === '商品' && SR.DIMENSIONS_ITEM) ? SR.DIMENSIONS_ITEM.map((d) => d.name)
        : (targetGran === '店铺' && SR.DIMENSIONS_STORE ? SR.DIMENSIONS_STORE.map((d) => d.name) : []);
      if (wantDims.length) {
        await waitUntil(() => {
          const opts = readRadioGroup('数据维度').options || [];
          return wantDims.filter((n) => opts.includes(n)).length >= Math.min(wantDims.length, 16);
        }, 15000, `数据维度列表重渲染完成（${targetGran}，只读证据探针）`, 400);
      }
    }
    out.radios['数据粒度'] = snap('数据粒度');
    // 到这里：控件标签与选项都已渲染、粒度已切到位 → **读数有效**
    out.readValid = true;
    out.readValidityNote = ('控件与选项均已渲染且已实读；`ok=true` 只表示探针跑完，'
      + '**判读数是否可用请看本字段（readValid）**。');

    // ⭐ 2026-09-16 新增（可选）：把「时间粒度」也切到指定值再读 —— 因为**同一维度的额外筛选控件
    //    可能随时间粒度变化**（实测：品类/流量来源 只有分月；它在分日下读到的控件，
    //    在分月下引擎却等不到 → 必须能"按粒度读"才能定位这类问题）。
    out.requestedGrain = grain ? String(grain) : null;
    // ⚠️ 时间粒度**不能在这里切**：下面逐个选维度时，**切维度会把时间粒度重置为分日**
    //    （实测：写在这里 → grainAfter 恒为「分日」，等于没切）。所以放到维度循环里、选完维度之后再切。

    // 要读哪些维度：默认读该粒度维度表里的**全部**（调用方可传子集）
    // ❗❗ 2026-09-16（客户/品类开发）修一个**静默错读数**：
    //    切完「数据粒度」后 `数据维度` 列表是**异步重渲染**的；旧写法立刻读 options →
    //    拿到的是**上一个粒度**（如店铺的 16 维）→ 产物里记着"读了 16 个维度"、
    //    看着成功，其实整份都是**别的粒度**的东西（实测踩到：`readonly_filters_客户_*.json` 里 16 个店铺维度）。
    //    → 现在**等到目标维度的名字真的出现在列表里**再继续；等不到就明确记 note（读数不可信）。
    const targetDims = Array.isArray(dimensions) && dimensions.length ? dimensions : null;
    const granTableForDimsRaw = (targetGran === '商品' && SR.DIMENSIONS_ITEM) ? SR.DIMENSIONS_ITEM
      : (targetGran === '店铺' ? SR.DIMENSIONS_STORE
        : (targetGran === '客户' ? SR.DIMENSIONS_CUSTOMER
          : (targetGran === '品类' ? SR.DIMENSIONS_CATEGORY : null)));
    // ⚠️ 空数组必须当"没有表"（`[]` 是 truthy，直接判真会得到 `dimsToRead=[]` → **静默读到 0 个维度**，实测踩到）
    const granTableForDims = (Array.isArray(granTableForDimsRaw) && granTableForDimsRaw.length)
      ? granTableForDimsRaw : null;
    const expectDims = targetDims || (granTableForDims || []).map((d) => d.name);
    if (expectDims.length) {
      const dimListReady = await waitUntil(() => {
        const opts = readRadioGroup('数据维度').options || [];
        return expectDims.some((n) => opts.includes(n));
      }, 15000, `「数据维度」列表已切到 ${targetGran} 粒度（含 ${expectDims[0]}）`, 400);
      if (!dimListReady.ok) {
        out.readValid = false;   // 读数**不可信**：列表可能还是上一个粒度的
        out.readValidityNote = ('「数据维度」列表未确认切到 ' + targetGran + ' 粒度（'
          + dimListReady.reason + '）→ **本次读数无效**，不得据此判断控件是否存在。');
        out.notes.push(out.readValidityNote);
      }
    }
    const table = granTableForDims;
    const dimsToRead = targetDims
      || (table ? table.map((d) => d.name) : (readRadioGroup('数据维度').options || []));
    if (!dimsToRead.length) {
      out.readValid = false;
      out.readValidityNote = ('没有可读的维度清单（既没传 `sr_dimlist`，也没有该粒度的维度表）→ '
        + '**本次读数无效**；请显式传 `sr_dimlist` 或先补维度表。');
      out.notes.push(out.readValidityNote);
    }

    for (const dimName of dimsToRead) {
      const entry = {
        dimension: dimName, dimensionCols: [], filters: {}, unavailable: [],
        // ⭐ 2026-09-17：**逐时间粒度**的读数（本格"有没有控件"必须以它为准，`filters` 只是最后一格的快捷方式）
        grainReadings: {}, readValid: false, readValidityNote: null,
      };
      if (!(readRadioGroup('数据维度').options || []).includes(dimName)) {
        entry.unavailable.push(`该粒度下「数据维度」没有「${dimName}」`);
        entry.readValidityNote = '该维度在本粒度下不可选 → 没有读数';
        out.extraFilters[dimName] = entry;
        continue;
      }
      // 该维度**声明**了哪些额外筛选控件（来自 selectors.js；只用来决定"读哪些名字"）
      const declared = (table || []).filter((d) => d.name === dimName).map((d) => d.extraFilters || [])[0] || [];
      entry.declaredExtraFilters = declared.slice();
      // 另外扫一遍常见控件名，避免"声明漏了但我们也没去读"
      const candidates = Array.from(new Set(declared.concat([
        '终端类型', '分词类型', '来源类型', '流量时期', '人群类型', '转化效果归属', '搜索来源',
        '时间类型', '退款场景', '退款后状态', '退款时间', '退款识别类型', '退款原因类型', '退款原因',
        '商品状态', '类目',
      ])));
      const existsSigOf = () => candidates.map((c) => (item(c) ? '1' : '0')).join('');
      const readControls = () => {
        const bag = {};
        for (const ctl of candidates) {
          const g = readRadioGroup(ctl);
          if (!g.exists) { bag[ctl] = { exists: false, note: '页面上没有该控件' }; continue; }
          bag[ctl] = {
            exists: true, readOk: true, current: g.current, options: g.options,
            optionCount: g.options.length, selectedCount: (g.options || []).length && g.current ? 1 : 0,
            // ⭐ 2026-09-16 新增：**实读**勾选数与 wrapper 种类 → 用来判定"单选还是多选"，
            //    不再靠 `selectedCount`（它曾写死为 1，导致"平台默认=全选"无法被实测校验）。
            checkedCount: g.checkedCount, checkedLabels: g.checkedLabels,
            wrapperKinds: g.wrapperKinds, looksMultiSelect: g.looksMultiSelect,
            defaultLooksAllSelected: Array.isArray(g.options) && g.options.length > 0
              && g.checkedCount === g.options.length,
            multiSelectNote: '平台多为多选组且**默认全选**；此处只记 current 与 options（不点击）',
          };
        }
        return bag;
      };

      // ❗❗ 2026-09-17 的核心修复：**必须证明"这块筛选面板属于本维度"**才能信读数。
      //    旧做法只等"存在性签名连续两次一致"——锁在**上一个维度**的面板上时它照样"稳定"，
      //    于是 `品类/流量来源` 被误读成有 `终端类型+类目`（实际是整体/店铺的面板残留），
      //    引擎照声明去等 → 3 连 `failed_permanent`。现在改成：
      //      ① 先等**基线面板自己稳定**（连续 3 次同一指纹）再采基线 —— 否则"首次渲染还没结束"
      //         会把后续任意一次抖动冒充成"重渲染"；
      //      ② 选完维度后，面板指纹必须与基线**不同**（或本维度就是基线维度）→「面板换了主人」成立；
      //      ③ 每格还要：时间粒度单选**回读等于请求值** + 连续 3 次（指纹+控件存在性）一致 + 距切换 ≥1200ms。
      //
      //    ⚠️ 为什么**不**要求"每换一格指纹都必须变"：
      //       有的维度各粒度指标完全相同（实测 `品类/整体` 分日与分周都是 23 个指标、
      //       `客户/店铺运营投入效果` 三格都是 4 个）→ 换粒度后指纹**本来就一模一样**，
      //       硬要求改变会把正确读数误判成无效（假阴性）。
      //       "换粒度有没有把旧值静默带过来"改由这些证据回答：
      //        `controlsDisappeared`（切换前有、切换后没了 ⇒ 面板确实换了）+ 控件是否**页面实读到**。
      {
        let prevFp = null;
        let hits = 0;
        await waitUntil(() => {
          const fp = formPanelFingerprint().fp;
          if (fp === prevFp) hits += 1; else hits = 0;
          prevFp = fp;
          return hits >= 2;
        }, 15000, '切换前：筛选面板已自稳定（只读证据探针基线）', 500);
      }
      const baseline0 = {
        dim: readRadioGroup('数据维度').current, grain: readRadioGroup('时间粒度').current,
        panel: formPanelFingerprint(), exists: existsSigOf(), values: {},
      };

      const sel = await selectRadio('数据维度', dimName);
      if (sel && sel.ok === false) entry.unavailable.push('选中维度失败：' + (sel.reason || ''));
      await waitUntil(() => readRadioGroup('数据维度').current === dimName, 8000,
        `数据维度=${dimName} 生效（只读证据探针）`, 300);
      // 切维度会把「时间粒度」重置为分日、且指标列表异步重渲染 → 先等它稳定（避免读到渲染中途）
      await waitMetricFieldStable(15000, 400);
      // 「面板确实换到了本维度」的**一次证明**（本维度 == 基线维度时按"没有切换"处理，同样成立）
      entry.dimensionPanelProven = (baseline0.dim === dimName)
        || (formPanelFingerprint().fp !== baseline0.panel.fp);
      entry.dimensionPanelProvenNote = entry.dimensionPanelProven
        ? (baseline0.dim === dimName
          ? '本维度就是切换前的缺省维度（没有切换动作，面板归属天然成立）'
          : '切换后面板指纹相对切换前基线已改变 ⇒ 这块面板属于本维度')
        : ('⚠️ 切换后面板指纹与切换前**完全相同** ⇒ 无法证明面板换了主人；'
           + '本维度读数**一律视为无效**（不得据此判断控件是否存在）');

      // "上一格结束态"（逐粒度做"旧值有没有被带过来"的诊断；与上面的重渲染证明是两件事）
      let prev = {
        dim: readRadioGroup('数据维度').current, grain: readRadioGroup('时间粒度').current,
        panel: formPanelFingerprint(), exists: existsSigOf(), values: {},
      };

      // ---- 逐个时间粒度读
      //   · **重渲染证明**锚定在"本维度切换前"（baseline0）→ 不会因"某维度各粒度指标完全相同"而假阴性；
      //   · **旧值带入诊断**用"上一格结束态"（prev）→ 直接回答 Codex 第 4 条"切粒度后旧值有没有被静默带入"。
      for (const g of grainList) {
        const gWant = g == null ? null : String(g);
        const gKey = gWant || '未指定';
        const rec = {
          grainRequested: gWant, grainWhenRead: null, grainReadBackOk: null, grainOptionsNow: [],
          dimensionPanelProven: false, panelChangedAfterSwitch: null, fingerprintChangedVsPrevGrain: null,
          panelStableReads: 0, dwellMs: null, settleOk: false, metricRaw: '', metricCount: null,
          controlsBefore: [], controlsFound: [], controlsDisappeared: [], controlsAppeared: [],
          sameValueAsBefore: [], filters: {}, readValid: false, readValidityNote: null,
        };
        try {
          if (gWant) {
            const gOpts = readRadioGroup('时间粒度').options || [];
            rec.grainOptionsNow = gOpts.slice();
            if (!gOpts.includes(gWant)) {
              rec.readValidityNote = `该维度的时间粒度选项里没有「${gWant}」`
                + `（实读：${gOpts.join('/') || '无'}）→ 本格**无有效读数**（记 unknown，不猜）`;
              entry.grainUnavailable = rec.readValidityNote;
              entry.grainReadings[gKey] = rec;
              continue;
            }
            if (readRadioGroup('时间粒度').current !== gWant) await selectRadio('时间粒度', gWant);
            await waitUntil(() => readRadioGroup('时间粒度').current === gWant, 8000,
              `时间粒度=${gWant} 生效（${dimName}，只读证据探针）`, 300);
          }
          const t0 = Date.now();
          rec.grainWhenRead = readRadioGroup('时间粒度').current;
          rec.grainReadBackOk = (gWant == null) || (rec.grainWhenRead === gWant);
          rec.dimensionPanelProven = !!entry.dimensionPanelProven;
          let lastSig = null;
          let hits = 0;
          const st = await waitUntil(() => {
            const sig = formPanelFingerprint().fp + '¶' + existsSigOf();
            if (sig === lastSig) hits += 1; else hits = 0;
            lastSig = sig;
            return hits >= 2 && (Date.now() - t0) >= 1200;
          }, 15000, `维度「${dimName}」时间粒度=${gKey}：读数已连续 3 次一致（只读证据探针）`, 500);
          rec.dwellMs = Date.now() - t0;
          rec.panelStableReads = hits + 1;
          rec.settleOk = !!st.ok;
          rec.panelChangedAfterSwitch = formPanelFingerprint().fp !== baseline0.panel.fp;
          rec.fingerprintChangedVsPrevGrain = formPanelFingerprint().fp !== prev.panel.fp;
          if (!st.ok) {
            rec.readValidityNote = '读数未达到"连续 3 次一致"（' + st.reason + '）→ 本格读数无效';
          }

          rec.filters = readControls();
          const afterExists = existsSigOf();
          rec.controlsBefore = candidates.filter((c, i) => prev.exists[i] === '1');
          rec.controlsFound = candidates.filter((c, i) => afterExists[i] === '1');
          rec.controlsDisappeared = rec.controlsBefore.filter((c) => !rec.controlsFound.includes(c));
          rec.controlsAppeared = rec.controlsFound.filter((c) => !rec.controlsBefore.includes(c));
          rec.sameValueAsBefore = rec.controlsFound.filter((c) => {
            const b = prev.values[c];
            return b != null && b === filterValueSig(rec.filters[c]);
          });
          rec.carryOverNote = ('`controlsDisappeared` = 切换前有、切换后没了（**这条最硬**：它直接证明面板换了）；'
            + '`sameValueAsBefore` = 同名控件前后取值/选项**逐字相同** —— '
            + '⚠️ 它**不构成"旧值被静默带入"的证明**（平台默认值本来就可能相同），只能作诊断。'
            + '`fingerprintChangedVsPrevGrain=false` 也**不是**缺陷：'
            + '有的维度各粒度指标完全相同（实测 `品类/整体` 分日与分周都是 23 个指标、'
            + '`客户/店铺运营投入效果` 三格都是 4 个），换粒度后指纹本来就一样。'
            + '本格有效性的判据是：`dimensionPanelProven`（面板属于本维度）+ `grainReadBackOk`'
            + '（粒度单选回读等于请求值）+ 连续 3 次一致 + dwell ≥1200ms。');
          const mc = readMetricCount();
          rec.metricRaw = mc.raw;
          rec.metricCount = mc.total;
          rec.readValid = !!(rec.dimensionPanelProven && rec.grainReadBackOk && st.ok);
          if (rec.readValid) {
            rec.readValidityNote = '面板属于本维度 + 粒度回读一致 + 连续 3 次读数一致 + 距切换 ≥1200ms → 读数有效';
          } else if (!rec.grainReadBackOk) {
            rec.readValidityNote = `时间粒度单选回读为「${rec.grainWhenRead}」，与请求的「${gWant}」不一致 → 本格读数无效`;
          }
        } catch (e) {
          rec.readValidityNote = '读该粒度异常：' + String(e && e.message || e);
        }
        entry.grainReadings[gKey] = rec;
        // 向后兼容：`entry.filters` / `grainWhenRead` 仍是"最后一次读到的那一格"
        entry.filters = rec.filters;
        entry.controlsFound = rec.controlsFound;
        entry.controlsDisappeared = rec.controlsDisappeared;
        entry.grainWhenRead = rec.grainWhenRead;
        entry.panelChangedAfterSwitch = rec.panelChangedAfterSwitch;
        entry.filterPanelSettled = rec.settleOk;
        prev = {
          dim: dimName, grain: rec.grainWhenRead, panel: formPanelFingerprint(),
          exists: existsSigOf(),
          values: Object.fromEntries(rec.controlsFound.map((c) => [c, filterValueSig(rec.filters[c])])),
        };
      }
      const grainRecs = Object.values(entry.grainReadings);
      entry.readValid = grainRecs.length > 0 && grainRecs.every((r) => r.readValid);
      entry.readValidityNote = entry.readValid
        ? '本维度**所有请求的时间粒度**都拿到了有效读数'
        : ('存在无效格：' + Object.entries(entry.grainReadings)
          .filter(([, r]) => !r.readValid)
          .map(([k, r]) => `${k}→${r.readValidityNote || '未说明'}`).join('；'));
      // 维度特有的列（只读文本，用于说明该维度的分组列）
      try {
        const cols = [];
        const it = item('数据维度');
        if (it) {
          const txt = (it.innerText || '').replace(/\s+/g, ' ');
          if (txt.length < 400) cols.push(txt);
        }
        entry.dimensionContext = cols.join(' ');
      } catch (e) { /* 忽略 */ }
      out.extraFilters[dimName] = entry;
    }

    // 便于旧消费方（清单生成脚本）取用：从**有效读数**里取第一个「终端类型」
    // ⚠️ 只在 readValid 的格子上取，避免把"上一个粒度的残留面板"当成该粒度的控件（实测踩过）。
    try {
      for (const dimName of Object.keys(out.extraFilters)) {
        const e = out.extraFilters[dimName];
        const gks = Object.keys(e.grainReadings || {});
        const valid = gks.filter((k) => e.grainReadings[k].readValid);
        const src = (valid.length ? valid : gks).map((k) => e.grainReadings[k])
          .map((r) => (r.filters || {})['终端类型']).find((f) => f && f.exists);
        if (src) {
          out.terminalType = {
            current: src.current, options: src.options, checkedLabels: src.checkedLabels,
            fromDimension: dimName, fromGrain: null, validRead: valid.length > 0,
          };
          break;
        }
      }
    } catch (e) { /* 忽略 */ }

    // 还原：把维度/粒度切回店铺/整体（减少对后续动作的干扰）
    try {
      await selectRadio('数据维度', '整体');
      if (granGroup.current && granGroup.current !== targetGran) await selectRadio('数据粒度', granGroup.current);
    } catch (e) { /* 忽略 */ }
    // ⭐ 2026-09-17：顶层 `readValid` 追加"逐维度逐粒度都有效"这一条 ——
    //    否则"粒度切到位 + 某个维度有效"就会把整份标成有效，掩盖无效格。
    if (out.readValid) {
      const bad = Object.entries(out.extraFilters).filter(([, e]) => !e.readValid);
      if (bad.length) {
        out.readValid = false;
        out.readValidityNote = ('存在**无效读数**的维度/粒度：'
          + bad.map(([k, e]) => `${k}（${e.readValidityNote || '未说明'}）`).join('；')
          + ' → 顶层 readValid=false；**不得**用这些格推断"平台没有该控件"。');
      } else {
        out.readValidityNote = ('控件与选项均已渲染、每个请求的维度×时间粒度都拿到了'
          + '"面板重渲染后连续 3 次稳定"的有效读数。`ok=true` 只表示探针跑完，'
          + '**判读数是否可用请看本字段（readValid）**。');
      }
    }
    out.entriesValid = Object.values(out.extraFilters).filter((e) => e.readValid).length;
    out.entriesTotal = Object.keys(out.extraFilters).length;
    out.restored = true;
    return out;
  }

  /**
   * ⭐ 只读小探针（2026-09-15 M1 排障用）：切到「商品 × 指定粒度」并报告**时间周期控件的真实形态**。
   *
   * 背景：M1 跑 `商品 × 分月` 时引擎报 `时间粒度未生效（页面控件形态与「分月」不符）`（3 次同错）。
   *   引擎的判据是「placeholder === MONTH_PICKER.startPlaceholder（开始月份）」；
   *   本探针**只读**地把真实情况挖出来：单选是否切到位、有哪些 placeholder、有没有月份单元格、
   *   有没有日期面板——**不提交、不建会话、不下载**，跑完还原为分日。
   */
  async function probeGrainShape(granularity, dimension, grain) {
    const out = {
      ok: true, probe: 'GRAIN_SHAPE', capturedAt: new Date().toISOString(), pageUrl: String(location.href || ''),
      granularity: String(granularity || '商品'), dimension: String(dimension || 'SKU'), grain: String(grain || '分月'),
      steps: [], notes: [],
    };
    const snap = () => ({
      grainRadioCurrent: readRadioGroup('时间粒度').current,
      grainRadioOptions: readRadioGroup('时间粒度').options,
      dimRadioCurrent: readRadioGroup('数据维度').current,
      granRadioCurrent: readRadioGroup('数据粒度').current,
      placeholders: Array.from(document.querySelectorAll('input')).map((x) => x.placeholder).filter((p) => p),
      monthCells: Array.from(document.querySelectorAll('td[title]')).map((e) => e.getAttribute('title')).filter((t) => /^\d{4}-\d{2}$/.test(t)).slice(0, 6),
      dayCells: Array.from(document.querySelectorAll('[title]')).map((e) => e.getAttribute('title')).filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t)).length,
      pickerPanelVisible: !!pickerPanel(),
      expectedMonthPlaceholder: SR.MONTH_PICKER.startPlaceholder,
      expectedWeekPlaceholder: SR.WEEK_PICKER.startPlaceholder,
    });

    const ready = await waitUntil(() => !!(item('数据粒度') && item('数据维度') && item('时间粒度')),
      FORM_READY_TIMEOUT_MS, '表单就绪（形态探针）');
    if (!ready.ok) { out.ok = false; out.notes.push('表单未就绪：' + ready.reason); return out; }
    out.before = snap();

    // ① 切数据粒度
    if ((readRadioGroup('数据粒度').options || []).includes(out.granularity)
        && readRadioGroup('数据粒度').current !== out.granularity) {
      await selectRadio('数据粒度', out.granularity);
      await waitUntil(() => readRadioGroup('数据粒度').current === out.granularity, 8000, '数据粒度生效', 300);
    }
    // ② 等维度选项集刷新出目标维度，再切维度
    const hasDim = () => (readRadioGroup('数据维度').options || []).includes(out.dimension);
    if (await waitUntil(hasDim, 12000, `维度选项出现 ${out.dimension}`)) {
      await selectRadio('数据维度', out.dimension);
      await waitUntil(() => readRadioGroup('数据维度').current === out.dimension, 8000, '维度生效', 300);
    } else {
      out.notes.push(`维度选项里没有「${out.dimension}」`);
    }
    await sleep(500);
    out.afterDimension = snap();

    // ③ 切时间粒度（目标）—— 模拟引擎的**第一阶段**
    out.grainSelectResult = await selectRadio('时间粒度', out.grain);
    out.grainWait = await waitUntil(() => readRadioGroup('时间粒度').current === out.grain, 6000, '粒度单选到位', 250);
    out.afterGrain1 = snap();
    // ④ 再切一次「数据维度」—— 复现引擎顺序里的"维度会不会把粒度重置"这一步
    await selectRadio('数据维度', out.dimension);
    await sleep(600);
    out.afterRedimension = snap();
    // ⑤ 引擎在这一步会**复检**时间粒度：先看单选，若被重置就重设
    const gNow = readRadioGroup('时间粒度').current;
    if (gNow === out.grain && !!Array.from(document.querySelectorAll('input')).find((x) => x.placeholder === SR.MONTH_PICKER.startPlaceholder)) {
      out.recheck = { needed: false, reason: `粒度仍为 ${out.grain}（无需重设）`, snap: snap() };
    } else {
      out.recheck = { needed: true, grainNowBeforeReset: gNow };
      out.recheck.selectResult = await selectRadio('时间粒度', out.grain);
      out.recheck.wait = await waitUntil(() => readRadioGroup('时间粒度').current === out.grain, 8000, '复检后粒度到位', 250);
      await sleep(800);
      out.recheck.snap = snap();
    }
    for (const ms of [1000, 3000, 6000]) {
      await sleep(ms);
      out.steps.push({ phaseAfterRecheckMs: ms, snap: snap() });
    }
    out.afterGrain = snap();

    // 还原
    try { await selectRadio('时间粒度', '分日'); } catch (e) { /* 忽略 */ }
    return out;
  }

  /**
   * ⭐ 失败瞬间快照（2026-09-15 按 Codex M1 要求新增）：门禁失败时回答"页面此刻到底长什么样"。
   *
   * 覆盖 Codex 点名的几项：页面/frame 目标、**单选状态**（数据平台/粒度/维度/时间粒度）、
   * **全部 input 的 placeholder + 可见性 + 显示值**（区分"可见的月份输入"与"隐藏残留输入"）、
   * **选择器命中情况**（月份/周/日期面板各自的命中数）、可见的日期面板、月份单元格样例。
   * ⚠️ 只读、**只记事实**；不点击、不切换、不提交。
   */
  function failureSnapshot() {
    const inputs = Array.from(document.querySelectorAll('input')).map((el, i) => ({
      i,
      placeholder: el.placeholder || null,
      value: el.value == null ? null : String(el.value).slice(0, 40),
      visible: isVisible(el),
      type: el.type || null,
      disabled: !!el.disabled,
    }));
    const titles = Array.from(document.querySelectorAll('[title]')).map((e) => e.getAttribute('title'));
    const pickerHit = (ph) => inputs.filter((x) => x.placeholder === ph).length;
    return {
      at: new Date().toISOString(),
      pageUrl: String(location.href || ''),
      isFormFrame: isFormFrame(),
      radios: {
        数据平台: readRadioGroup('数据平台').current,
        数据粒度: readRadioGroup('数据粒度').current,
        数据维度: readRadioGroup('数据维度').current,
        时间粒度: readRadioGroup('时间粒度').current,
      },
      radioOptions: {
        数据粒度: readRadioGroup('数据粒度').options,
        时间粒度: readRadioGroup('时间粒度').options,
      },
      inputs,
      selectorHits: {
        monthStartPlaceholder: pickerHit(SR.MONTH_PICKER.startPlaceholder),
        monthEndPlaceholder: pickerHit(SR.MONTH_PICKER.endPlaceholder),
        weekStartPlaceholder: pickerHit(SR.WEEK_PICKER.startPlaceholder),
        weekEndPlaceholder: pickerHit(SR.WEEK_PICKER.endPlaceholder),
        dayStartPlaceholder: pickerHit('开始日期'),
        dayEndPlaceholder: pickerHit('结束日期'),
        pickerPanelVisible: !!pickerPanel(),
        monthCells: titles.filter((t) => /^\d{4}-\d{2}$/.test(t)).length,
        dayCells: titles.filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t)).length,
      },
      metricCount: (() => { try { return readMetricCount(); } catch (e) { return null; } })(),
      note: '失败瞬间快照：只读、只记事实，不含原因判断',
    };
  }

  function readState() {
    const gate = assertNoStopWords();
    return {
      ok: true,
      frame: isFormFrame() ? 'form' : 'other',
      frameId: null,
      gate,
      state: readFormState(),
    };
  }

  function preflight() {
    const gate = assertNoStopWords();
    const required = assertRequiredComplete();
    return {
      ok: gate.ok && (required.ok || required.required === 0),
      frame: isFormFrame() ? 'form' : 'other',
      gate,
      required,
      state: readFormState(),
      reason: !gate.ok ? gate.reason : (required.ok ? '' : `必填项未齐：${required.missing.join('、')}`),
    };
  }

  // ---------------------------------------------------------------- 对外导出（测试/调试）
  const Engine = {
    executeTask, selectRadio, ensureMetrics, setDateRange, setWeekRange, setMonthRange, setReportName,
    assertRequiredComplete, readFormState, readMetricCount, readToasts, readFieldErrors, inResultView,
    findSubmitButton, findDownloadButton, submit, waitForResult, clickDownload, nudgeDownload,
    readResultHeaders, applyOptionValues, readOptionChoices, isFormFrame, weekLabelOf, shiftDays,
    readResultRowCount,
    // 2026-09-15 新增：二期粒度只读枚举探针（供实采「商品/客户/品类」用；不提交任务）
    enumerateGranularity,
    probeGrainShape,
    failureSnapshot,
    waitUntil, sleep, realClick, setNativeValue, byPh, item,
    // 日期原语（单独导出：便于分步验证与复用；长流程请由调用方编排，避免单次调用过久）
    pickerPanel, panelHeaders, goToMonth, ensureMonthVisible, clickDate, cellByTitle, isDateVisible, closePicker,
  };

  // ---------------------------------------------------------------- 自动化入口（深链接启动）
  /**
   * 用途：自动化验证 / 批量编排——在取数页 URL 上带参即自动创建并启动一个会话
   * （等价于在面板里点「开始」）。
   *
   *   https://sycm.taobao.com/adm/v3/micro/auto_analysis/datafetch/create
   *     ?sr_autorun=1
   *     &sr_store=000000
   *     &sr_storename=生参旗舰店
   *     &sr_dims=整体            （多个用英文逗号分隔）
   *     &sr_grain=分日           （分日/分周/分月/汇总）
   *     &sr_start=2026-07-01
   *     &sr_end=2026-07-31
   *     [&sr_batch=T1]
   *     [&sr_efv=关键词.分词类型=长尾词]   额外筛选值的**显式覆盖**（可重复；不传则沿用平台默认值）
   *
   * 额外筛选覆盖（`sr_efv`）的写法（可重复出现，或一条里用 `,` 分隔多条）：
   *   `维度.控件=值`         例 `关键词.分词类型=长尾词`
   *   `维度.控件=值1+值2`     多选组用 `+` 连接，例 `流量来源.来源类型=商品流量+店铺流量`
   *   `*.控件=值`            `*` = 对所有维度生效（等价于 core 的「默认」兜底）
   *   ⚠️ 维度、控件都必须与 `core.js` 的维度声明一致，且值不能为空 —— 否则**建会话前就拒绝**
   *      （错配绝不静默忽略：静默忽略会产出"看起来对、其实没筛"的数据）。
   *
   * 约束：
   *   - 只在 sycm.taobao.com（本 content script 的匹配域）且**显式**带 `sr_autorun=1` 时生效
   *   - 只在顶层 frame 触发一次
   *   - 结果写进 `<html data-sr-autorun="…">`，便于外部读取；不含任何凭证
   *     ❗ 加固②（2026-09-14）起写的是**短摘要**：合法 JSON + ≤900 字符 + 带 `at` 时间戳 +
   *       `hint` 明标"非状态源、不可用于判会话状态"（见 `setResult`）。
   *   - 不需要此入口时可整段删除，不影响其余功能
   */
  function maybeAutorun() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    if (window.top !== window) return;
    let q;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    if (q.get('sr_autorun') !== '1') return;

    /**
     * 写深链接回执。
     *
     * ❗❗ 加固②（2026-09-14）—— 这里**不再** `JSON.stringify(obj).slice(0, 900)`：
     *   旧写法只要回执体超过 900 字符就**腰斩成非法 JSON**（实测 `rawLength=900` + `Unable to parse at 900`）。
     *   现在改为写 `core.buildAutorunReceipt()` 产出的**短摘要**：
     *     · **始终是合法 JSON**（超长时丢弃明细，绝不截断字符串）；
     *     · **≤900 字符**（目标 ≤400；只读排障探针放宽到 ≤860 以便把细节带回来）；
     *     · 带 `at`（ISO 时间戳，供消费方判新鲜度）与 `hint`（**明写"不可用于判会话状态"**）；
     *     · 保留既有消费方读的字段：`stage` / `action` / `resp.ok` / `resp.sessionId` / `resp.total` / `resp.error`。
     *   ⚠️ 该属性仍然**粘性**（STATE 常为同文档导航、内容脚本不重跑 → 可能还是上一次动作的回执）
     *      → 判"会话状态/会话 id"一律读会话清单 `session_manifest.json`，不要读这个属性。
     */
    const setResult = (obj) => {
      try {
        let receipt;
        if (CORE && typeof CORE.buildAutorunReceipt === 'function') {
          // 只读排障探针（NUDGE_TRACE / ALARM_PROBE / DOWNLOAD_PROBE …）刻意放宽软上限：
          // 它们不参与"外部脚本轮询判活"，把细节带回来更有价值；硬上限 900 依旧不可越过。
          const action = String((obj && obj.action) || '').toUpperCase();
          const isProbe = /(_PROBE|_TRACE)$/.test(action);
          // ⚠️ 2026-09-22：**不再**给 STATE 之类的状态动作单独放宽预算。
          //   试过（softChars 700/450）→ 会改动阶梯选中档位、把既有契约字段挤掉（实测打挂 4 条测试）。
          //   正确做法是走**轻量动作** `QUEUE_STATE`（响应小、回执装得下，且它带 `activeSession`）。
          receipt = CORE.buildAutorunReceipt(obj, isProbe ? { softChars: 860 } : undefined);
        } else {
          // 退化路径（core.js 未加载）：仍然**不截断 JSON**，只回一句可解析的最小回执
          receipt = {
            schema: 'sr-autorun-receipt/2',
            stage: obj && obj.stage ? String(obj.stage) : null,
            action: obj && obj.action ? String(obj.action) : null,
            ok: null,
            sessionId: null,
            total: null,
            at: new Date().toISOString(),
            hint: '回执摘要（非状态源）；core.js 未加载，回执不可用',
            truncated: true,
            error: 'core.js 未加载（globalThis.SRCore 缺失），无法生成回执摘要',
          };
        }
        document.documentElement.setAttribute('data-sr-autorun', JSON.stringify(receipt));
      } catch (e) { /* 忽略 */ }
    };

    /**
     * 解析 `sr_efv`（额外筛选值的显式覆盖）。
     * 语法：`维度.控件=值1+值2`；可重复出现，或在同一条里用 `,` 分隔。
     * 解析失败（缺 `.` / 缺 `=` / 空片段）返回 { ok:false, reason }，由调用方写进结果属性（不静默）。
     */
    const parseEfv = (rawList) => {
      const out = {};
      for (const raw of rawList) {
        for (const piece of String(raw || '').split(',')) {
          const item = piece.trim();
          if (!item) continue;
          const eq = item.indexOf('=');
          if (eq <= 0) return { ok: false, reason: `sr_efv 片段缺少「=」：${item}（应为 维度.控件=值）` };
          const left = item.slice(0, eq).trim();
          const values = item.slice(eq + 1).split('+').map((v) => v.trim()).filter(Boolean);
          const dot = left.indexOf('.');
          if (dot <= 0 || dot === left.length - 1) {
            return { ok: false, reason: `sr_efv 片段缺少「维度.控件」：${item}（应为 维度.控件=值）` };
          }
          const dimKey = left.slice(0, dot).trim() === '*' ? '默认' : left.slice(0, dot).trim();
          const ctrl = left.slice(dot + 1).trim();
          if (values.length === 0) return { ok: false, reason: `sr_efv 片段没有值：${item}` };
          if (!out[dimKey]) out[dimKey] = {};
          out[dimKey][ctrl] = (out[dimKey][ctrl] || []).concat(values);
        }
      }
      return { ok: true, value: out };
    };

    const efv = parseEfv(q.getAll('sr_efv'));
    if (!efv.ok) { setResult({ stage: 'sr_efv', error: efv.reason }); return; }

    const cfg = {
      storeId: q.get('sr_store') || '',
      storeName: q.get('sr_storename') || '',
      // 数据粒度：默认「店铺」；`sr_granularity=商品` 可用。
      // 传入即可 —— 是否**真的开放**由 core.buildTaskCatalog 判定（未实采的粒度会抛错，
      // 且错误会经由回执带出来），这里不做第二套白名单（避免两处口径）。
      granularity: q.get('sr_granularity') || '店铺',
      timeGrain: q.get('sr_grain') || '分日',
      startDate: q.get('sr_start') || '',
      endDate: q.get('sr_end') || '',
      dimensions: String(q.get('sr_dims') || '整体').split(',').map((s) => s.trim()).filter(Boolean),
      batch: q.get('sr_batch') || undefined,
      // 分片单位（可显式指定）：month | week | day | none。
      // 不传 = 按「维度 × 时间粒度」自动选（分周→week；rowRisk:'high' 的明细维度分日→week；其余→month）。
      // 用途：撞上平台 10 万行静默截断时按更细粒度重取（见 selectors.js 的 PLATFORM.rowCap）。
      ...(q.get('sr_chunk') ? { chunkUnit: String(q.get('sr_chunk')).toLowerCase() } : {}),
      // 仅在真的传了 sr_efv 时才带这个键（保持旧深链接的配置形状不变）
      ...(Object.keys(efv.value).length ? { extraFilterValues: efv.value } : {}),
    };
    setResult({ stage: 'params', cfg });

    chrome.runtime.sendMessage({ type: 'SR_TAB_ID' }, (tabResp) => {
      const lastErr = chrome.runtime.lastError;
      const tabId = tabResp && tabResp.tabId;
      if (lastErr || !tabId) {
        setResult({ stage: 'tabid', error: String(lastErr && lastErr.message || '未取到 tabId（扩展可能尚未重新加载）'), tabResp });
        return;
      }
      chrome.runtime.sendMessage(
        {
          type: 'SRUI_COMMAND',
          action: String(q.get('sr_action') || 'START').toUpperCase(),
          // ⭐ 2026-09-18：`sr_action=QUEUE_ADD` —— 把这份配置**加入取数队列**（不立刻跑）。
          //    用途：① 脚本/批处理排队（不必点界面）；② 自动化验证（点不了鼠标的机器上尤其重要）。
          //    形状与 START 一致：队列项本来就是"一份完整的 START 配置"（另拼一套必然漂移）。
          item: String(q.get('sr_action') || '').toUpperCase() === 'QUEUE_ADD'
            ? { config: Object.assign({}, cfg, { ownerTabId: tabId }), ownerTabId: tabId, label: q.get('sr_label') || '' }
            : undefined,
          config: (String(q.get('sr_action') || 'START').toUpperCase() === 'START'
            // ⭐ DRYRUN（提交前验证）用的是**与 START 同一份 cfg** —— 这样"任务身份/额外筛选/报表名"
            //    验证的就是真任务构建的产物，而不是另拼一套参数（另拼一套就会两侧漂移）。
            || String(q.get('sr_action') || '').toUpperCase() === 'DRYRUN')
            ? Object.assign({}, cfg, { ownerTabId: tabId })
            // 非 START 动作：只带 ownerTabId（保持旧形状）；探针可按需带自己的参数
            : Object.assign({ ownerTabId: tabId },
              q.get('sr_delay') ? { probeDelayMs: Number(q.get('sr_delay')) } : {},
              // ENUMERATE 探针的参数（2026-09-15 新增；其他动作忽略这几个键）
              q.get('sr_granularity') ? { granularity: String(q.get('sr_granularity')) } : {},
              q.get('sr_dimlimit') ? { dimensionLimit: Number(q.get('sr_dimlimit')) } : {},
              q.get('sr_mode') ? { mode: String(q.get('sr_mode')) } : {},
              q.get('sr_dim') ? { onlyDimension: String(q.get('sr_dim')) } : {},
              // READONLY_FILTERS 探针（P1）：可选只读哪几个维度（`sr_dimlist=整体,流量来源`）；不传=读全部
              q.get('sr_dimlist') ? { dimensions: String(q.get('sr_dimlist')).split(',').map((s) => s.trim()).filter(Boolean) } : {},
              // ⭐ 2026-09-17：**逐时间粒度**读（`sr_grains=分日,分周,分月,汇总`，按序逐个切、逐个读）；
              //    旧的单值 `sr_probe_grain` 保留（等价于只读那一格）。
              q.get('sr_grains') ? { grains: String(q.get('sr_grains')).split(',').map((s) => s.trim()).filter(Boolean) } : {},
              // ⭐ 2026-09-17：`sr_action=WORKSPACE[&sr_page=new|progress|history]` 打开整页工作台
              //    （故意带上它：`chrome-extension://` 页面**不能**被桥/网页导航打开，只能由扩展自己开，
              //      否则就没法把工作台摆到屏幕上做人工或截图复核）
              q.get('sr_page') ? { page: String(q.get('sr_page')) } : {},
              // GRAIN_SHAPE 探针（M1 排障）：要探测的维度与粒度
              q.get('sr_dim') ? { dimension: String(q.get('sr_dim')) } : {},
              q.get('sr_probe_grain') ? { grain: String(q.get('sr_probe_grain')) } : {}),
        },
        (resp) => {
          const e2 = chrome.runtime.lastError;
          setResult({ stage: 'command', tabId, action: String(q.get('sr_action') || 'START').toUpperCase(), resp, error: e2 ? String(e2.message) : undefined });
        },
      );
    });
  }

  /**
   * 用**页面上下文**触发一个 JSON 文件下载（blob URL + `<a download>`）。
   *
   * ✅ 实测必要性（2026-09-13）：`chrome.downloads.download({url:'data:…', filename})`
   *    会**静默忽略 filename**（不抛错 → 调用方的"被拒则降级"分支根本不会触发），
   *    文件被 Chrome 命名为默认的「下载.json」。而 `<a download>` 指定的名字会被采纳；
   *    之后再由调度层的下载接管（onDeterminingFilename）把它重命名进归档目录。
   */
  function saveJsonViaAnchor(filename, jsonText) {
    try {
      const base = String(filename || 'artifact.json').replace(/[\\/]/g, '_');
      const blob = new Blob([String(jsonText == null ? '' : jsonText)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = base;
      a.rel = 'noopener';
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(() => { try { a.remove(); URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ } }, 5000);
      return { ok: true, filename: base, via: 'anchor-download' };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  globalThis[GUARD] = true;
  globalThis.__SR_FORM_ENGINE = Engine;   // 供 WebBridge 注入验证 / 调试使用
  globalThis.__SR_SAVE_JSON = saveJsonViaAnchor;

  // ---------------------------------------------------------------- 表单 frame 自报身份
  /**
   * ✅ 实测必要性（2026-09-13）：background 不带 frameId 广播时，
   *    `chrome.tabs.sendMessage(tabId, msg)` 只把**第一个**应答交付给回调，
   *    而顶层外壳 frame 常常先应答 → 调度层永远拿不到表单 iframe 的应答。
   *    实机表现：「预检失败：只有非表单 frame 应答（当前 frame 不是取数表单 frame）」。
   *    修法：表单 frame 主动把自己的 frameId 上报给调度层，之后由调度层定向发消息。
   */
  function announceFormFrame() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    if (!isFormFrame()) return;
    const send = () => {
      try {
        chrome.runtime.sendMessage(
          { type: 'SR_FORM_FRAME_HELLO', path: location.pathname, view: inResultView() ? 'result' : 'form' },
          () => { void chrome.runtime.lastError; },   // 扩展刚重载时可能无接收方，忽略即可
        );
      } catch (e) { /* 忽略 */ }
    };
    // ⚠️ 立即报一次（探针与调度层都要求"加载即自报"），随后补几次
    //    —— iframe 内是 SPA，URL 会在内部切换（提交后结果视图等）。
    send();
    [1500, 4000, 8000].forEach((ms) => setTimeout(send, ms));
    // ❗ 2026-09-14 收尾 ③ 补：SPA 切到**结果视图**后不会再触发脚本加载，
    //    而"等下载 → 催单"恰恰发生在结果视图里（实测 NUDGE5/6：映射被清后 15 秒解析不到 frame，
    //    催单从未发出）。这里每隔一段时间补报一次身份，让调度层始终能定向到本 frame。
    //    固定间隔、无随机；页面关闭即随之停止（不额外占用资源）。
    if (typeof setInterval === 'function') {
      const timer = setInterval(send, 10000);
      globalThis.__SR_HELLO_TIMER = timer;   // 仅便于排障观察
    }
  }

  announceFormFrame();
  maybeAutorun();

  // ---------------------------------------------------------------- 消息处理（扩展环境才有 chrome）
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    /**
     * 路由规则：
     *   · SR_SAVE_JSON / SR_STATE / SR_PING → **任意 frame 都响应**（顶层 frame 参与落盘与兜底探测）
     *   · 其余（预检 / 执行任务 / 催单）→ 只在**表单 frame** 响应，避免外壳 frame 抢答
     */
    // ⚠️ SR_ENUMERATE 也放进"任意 frame 都响应"：调用方（WebBridge 注入的代码）跑在**顶层 frame**，
    //    拿不到跨域表单 iframe 里的引擎对象，只能靠这条消息通道把请求送到表单 frame（2026-09-15 实测）。
    const ANY_FRAME_TYPES = ['SR_SAVE_JSON', 'SR_STATE', 'SR_PING', 'SR_ENUMERATE', 'SR_READONLY_FILTERS', 'SR_DISMISS_NOTICES'];

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return false;
      const anyFrame = ANY_FRAME_TYPES.includes(message.type);
      if (!anyFrame && !isFormFrame()) {
        sendResponse({ ok: false, frame: 'other', reason: '当前 frame 不是取数表单 frame' });
        return false;
      }

      const wrap = async (fn) => {
        try {
          const r = await fn();
          sendResponse(Object.assign({ frameId: sender && sender.frameId != null ? sender.frameId : null }, r));
        } catch (e) {
          // 契约（调用方消费点）：异常统一回 `{ ok:false, reason:'content 异常：…' }`，便于与"平台拒绝"区分
          sendResponse({
            ok: false,
            popupBlocked: !!e.popupBlocked && !popupSubmissionStarted,
            reason: `content 异常：${String((e && e.message) || e)}`,
            frame: isFormFrame() ? 'form' : 'other',
          });
        }
      };

      switch (message.type) {
        case 'SR_DISMISS_NOTICES':
          wrap(async () => popupGuard ? popupGuard.check() : { ok: false, reason: '[弹窗阻挡]请刷新页面加载新版插件' });
          return true;
        case 'SR_PING':
          wrap(async () => ({ ok: true, frame: isFormFrame() ? 'form' : 'other', state: readFormState() }));
          return true;
        case 'SR_STATE':
          wrap(async () => readState());
          return true;
        case 'SR_PREFLIGHT':
          wrap(async () => preflight());
          return true;
        case 'SR_EXECUTE_TASK':
          // ⚠️ 长流程：异步返回（`return true` 保持消息通道打开），超时由调用方自管
          wrap(async () => {
            popupChecksActive = true;
            popupSubmissionStarted = false;
            try { return await executeTask(message.task || {}); }
            finally { popupChecksActive = false; }
          });
          return true;
        case 'SR_NUDGE_DOWNLOAD':
          wrap(async () => nudgeDownload());
          return true;
        case 'SR_SAVE_JSON':
          wrap(async () => saveJsonViaAnchor(message.filename, message.json));
          return true;
        case 'SR_ENUMERATE':
          // 只读枚举探针（不提交任务）：供二期粒度（商品/客户/品类）实采使用
          wrap(async () => enumerateGranularity(
            message.granularity || '商品', message.dimensionLimit, message.mode, message.onlyDimension));
          return true;
        case 'SR_FAILURE_SNAPSHOT':
          wrap(async () => ({ snapshot: failureSnapshot() }));
          return true;
        case 'SR_GRAIN_SHAPE':
          wrap(async () => probeGrainShape(message.granularity || '商品', message.dimension || 'SKU', message.grain || '分月'));
          return true;
        case 'SR_READONLY_FILTERS':
          // 只读证据探针（P1）：读终端类型与额外筛选控件的当前值/可见选项；不提交、不建会话、不下载
          wrap(async () => captureReadOnlyFilters(message.granularity || '店铺', message.dimensions, message.grain, message.grains));
          return true;
        default:
          sendResponse({ ok: false, reason: `未知消息类型：${message.type}` });
          return false;
      }
    });
  }
})();
