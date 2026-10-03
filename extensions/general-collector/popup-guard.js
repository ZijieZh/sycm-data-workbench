/* Dismiss only named informational dialogs through an explicit close control. */
(function (root) {
  'use strict';
  const containers = '[role="dialog"],[role="alertdialog"],.ant-modal,.next-dialog,.el-dialog,.dt-dialog,.ant-notification-notice,.next-message';
  const closeSelector = '.ant-modal-close,.next-dialog-close,.el-dialog__headerbtn,.dt-dialog-close,.ant-notification-notice-close,[aria-label="关闭"],[aria-label="Close"],[aria-label="close"],[title="关闭"]';
  const titleSelector = '[role="heading"],.ant-modal-title,.next-dialog-header,.el-dialog__title,.dt-dialog-header,.ant-notification-notice-message,h1,h2,h3';
  const titles = ['优惠竞争力下降提醒', '竞争动态提醒', '系统公告', '产品更新', '功能介绍', '活动提醒', '新功能介绍', '版本更新通知'];
  const protectedText = /验证码|滑块|安全验证|身份验证|登录|密码|授权|支付|付款|订购|开通服务|删除确认|确认删除|签署|同意协议|服务协议|隐私协议|确认提交|确认修改/;
  function classify(title, text) {
    if (protectedText.test(text)) return 'protected';
    return titles.includes(String(title || '').trim()) ? 'notice' : 'unknown';
  }
  function visible(el) {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
  function create(doc, options = {}) {
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const click = options.click || (el => el.click());
    const attempts = new WeakSet();
    let running = null;
    async function scan() {
      const closed = [];
      // Ignore outer wrappers containing a more specific dialog, avoiding duplicate clicks.
      const dialogs = Array.from(doc.querySelectorAll(containers)).filter(visible)
        .filter(el => !el.closest('.ant-picker-dropdown,.next-date-picker-panel,.next-calendar,.el-picker-panel,.dt-date-picker-panel'))
        .filter(el => !Array.from(el.querySelectorAll(containers)).some(visible));
      for (const el of dialogs) {
        const text = (el.innerText || '').trim();
        const titleEl = el.querySelector(titleSelector);
        const title = (titleEl && titleEl.innerText || text.split('\n')[0] || '').trim();
        const kind = classify(title, text);
        const block = reason => ({ ok: false, popupBlocked: true, title: title.slice(0, 100), reason: `[弹窗阻挡]${reason}`, closed });
        if (kind !== 'notice') return block(`${kind === 'protected' ? '需人工处理' : '未识别'}：${title || '无标题弹窗'}`);
        const buttons = Array.from(el.querySelectorAll(closeSelector)).filter(visible);
        if (buttons.length !== 1 || buttons[0].disabled) return block(`未找到唯一可用关闭按钮：${title}`);
        if (attempts.has(el)) return block(`关闭后仍存在：${title}`);
        attempts.add(el);
        click(buttons[0]);
        for (let i = 0; i < 10 && visible(el); i++) await sleep(100);
        if (visible(el)) return block(`关闭未生效：${title}`);
        closed.push(title);
      }
      // A remaining modal backdrop can still intercept form clicks.
      const masks = doc.querySelectorAll('.ant-modal-mask,.next-overlay-backdrop,.el-overlay,.v-modal,.dt-dialog-mask');
      if (Array.from(masks).some(visible)) return { ok: false, popupBlocked: true, reason: '[弹窗阻挡]仍有遮罩，等待人工检查', closed };
      return { ok: true, closed };
    }
    return { check() { if (!running) running = scan().finally(() => { running = null; }); return running; } };
  }
  root.SRPopupGuard = { create, classify };
  if (typeof module === 'object' && module.exports) module.exports = root.SRPopupGuard;
})(typeof globalThis !== 'undefined' ? globalThis : this);
