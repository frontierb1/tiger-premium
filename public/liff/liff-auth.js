/*
 * liff-auth.js — ตัวช่วยเรียก API พร้อมแนบ LINE ID token
 *
 * เดิมหน้า LIFF ส่ง profile.userId ไปให้ backend ตรงๆ ซึ่งปลอมได้
 * ตอนนี้แนบ ID token ไปใน header X-Line-Id-Token แล้วให้ backend verify กับ LINE
 *
 * วิธีใช้: โหลดไฟล์นี้ต่อจาก LIFF SDK แล้วเรียก apiFetch() แทน fetch()
 *   1. script src="https://static.line-scdn.net/liff/edge/2/sdk.js"
 *   2. script src="/liff/config.js"
 *   3. script src="/liff/liff-auth.js"
 */
(function () {
  'use strict';

  var reloginTried = false;

  function currentToken() {
    try {
      return (typeof liff !== 'undefined' && liff.getIDToken) ? liff.getIDToken() : null;
    } catch (e) {
      return null;
    }
  }

  /** fetch ที่แนบ ID token ให้อัตโนมัติ และ re-login ให้เองถ้า token หมดอายุ */
  window.apiFetch = async function (url, options) {
    var opts = Object.assign({}, options || {});
    var token = currentToken();

    opts.headers = Object.assign({}, opts.headers || {});
    if (token) opts.headers['X-Line-Id-Token'] = token;

    var res = await fetch(url, opts);

    // 401 = token หมดอายุหรือไม่ถูกต้อง → ให้ LINE ออก token ใหม่แล้วโหลดหน้าใหม่
    if (res.status === 401 && !reloginTried && typeof liff !== 'undefined' && liff.login) {
      reloginTried = true;
      try {
        liff.logout();
      } catch (e) { /* ไม่เป็นไร */ }
      liff.login({ redirectUri: window.location.href });
    }

    return res;
  };

  /** ตรวจว่าพร้อมใช้งานหรือยัง — เรียกหลัง liff.init() */
  window.ensureLiffAuth = function () {
    if (!currentToken()) {
      console.warn('ไม่พบ LINE ID token — อาจยังไม่ได้ login หรือเปิดนอกแอป LINE');
      return false;
    }
    return true;
  };
})();
