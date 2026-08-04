/*
 * liff-api.js — API สมัครสมาชิก / ต่ออายุ / เช็คข้อมูล (หน้า LIFF เรียกใช้)
 *
 * ★ ไฟล์นี้ทำงานได้ด้วยตัวเอง อัปไฟล์เดียวจบ
 *   ใช้แค่ express, multer, axios, form-data (มีใน package.json อยู่แล้ว)
 *   + ./sheets และ ./time ที่อยู่บน repo แล้ว
 *
 * ★ ตรวจสลิปด้วย EasySlip เท่านั้น (api.easyslip.com)
 *   ตั้ง ENV: EASYSLIP_API_KEY
 *
 * ★ แก้ราคา → ตาราง PACKAGES ด้านล่าง
 * ★ แก้ชื่อแบรนด์ในข้อความ LINE → ตั้ง ENV BRAND_NAME
 */

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const {
  getMemberByLineId, getMembersByLineId, checkEmailExists,
  isSlipUsed, addMember, renewMember,
} = require('./sheets');
const { daysLeft } = require('./time');

const router = express.Router();
const BRAND = process.env.BRAND_NAME || 'Tube';

// ===== ราคาแพ็กเกจ =====
// ★ ตัวเลขตรงนี้คือตัวที่ใช้เทียบกับยอดในสลิป ต้องตรงกับ public/liff/config.js
const PACKAGES = {
  '1month':  { label: '1 เดือน', price: 75,  months: 1 },
  '2months': { label: '2 เดือน', price: 150, months: 2 },
  '3months': { label: '3 เดือน', price: 220, months: 3 },
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 }, // สลิปไม่ควรเกิน 8MB
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('กรุณาแนบไฟล์รูปภาพเท่านั้น'));
    cb(null, true);
  },
});


/* ══════════════ จำกัดจำนวนครั้ง ══════════════ */

const buckets = new Map();
function rateLimit({ windowMs = 60000, max = 10, keyGenerator, message } = {}) {
  const genKey = keyGenerator || ((req) => req.ip || 'unknown');
  const msg = message || 'ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่ครับ';
  return function (req, res, next) {
    const key = genKey(req);
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      if (buckets.size > 5000) {
        for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      }
      return next();
    }
    b.count += 1;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: msg });
    }
    next();
  };
}


/* ══════════════ ล็อกกันเขียนซ้ำ ══════════════ */
// Google Sheets ไม่มี unique constraint — ถ้าสองคนสมัครอีเมลเดียวกันพร้อมกัน
// จะผ่านการเช็คทั้งคู่แล้วเขียนซ้ำ ล็อกนี้บังคับให้ "เช็ค + เขียน" ทำทีละคิว

const queues = new Map();
function withLock(key, fn) {
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.then(fn, fn);
  const chain = run.then(() => {}, () => {});
  queues.set(key, chain);
  chain.then(() => { if (queues.get(key) === chain) queues.delete(key); });
  return run;
}


/* ══════════════ ยืนยันตัวตนผ่าน LINE ID token ══════════════ */
// ถ้าไม่ verify ใครยิง API เองก็สมัคร/ดูข้อมูลในชื่อคนอื่นได้
// ENV: LINE_LOGIN_CHANNEL_ID = Channel ID ของ LINE Login channel (ไม่ใช่ Messaging API)
// ถ้ายังไม่ตั้ง ระบบทำงานแบบเดิม (ไม่ verify) และเตือนใน log — deploy ได้ไม่พัง

const CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID || '';
const tokenCache = new Map();
let warnedNoChannel = false;

async function verifyIdToken(idToken) {
  if (!idToken || !CHANNEL_ID) return null;

  const hit = tokenCache.get(idToken);
  if (hit && hit.expiresAt > Date.now()) return hit.userId;

  try {
    const params = new URLSearchParams();
    params.append('id_token', idToken);
    params.append('client_id', CHANNEL_ID);
    const res = await axios.post('https://api.line.me/oauth2/v2.1/verify', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    const userId = res.data?.sub;
    if (!userId) return null;
    tokenCache.set(idToken, { userId, expiresAt: Date.now() + 60000 });
    if (tokenCache.size > 5000) tokenCache.clear(); // กัน memory โต
    return userId;
  } catch (err) {
    console.error('verifyIdToken failed:', err.response?.data || err.message);
    return null;
  }
}

function requireLineUser({ from = 'body', field = 'lineUserId' } = {}) {
  return async function (req, res, next) {
    const claimed = req[from]?.[field];

    if (!CHANNEL_ID) {
      if (!warnedNoChannel) {
        warnedNoChannel = true;
        console.warn('⚠️  ยังไม่ได้ตั้ง LINE_LOGIN_CHANNEL_ID — ระบบจะเชื่อ lineUserId ที่ client ส่งมา (ไม่ปลอดภัย)');
      }
      if (!claimed) return res.status(400).json({ error: 'ข้อมูลไม่ครบ (lineUserId)' });
      req.lineUserId = claimed;
      return next();
    }

    const idToken = req.headers['x-line-id-token'];
    if (!idToken) return res.status(401).json({ error: 'กรุณาเปิดหน้านี้ผ่านแอป LINE ครับ' });

    const verified = await verifyIdToken(idToken);
    if (!verified) {
      return res.status(401).json({ error: 'ยืนยันตัวตนไม่สำเร็จ กรุณาปิดหน้านี้แล้วเปิดใหม่ครับ' });
    }
    // ใช้ userId จาก token เสมอ — ไม่สนใจค่าที่ client อ้าง
    if (claimed && claimed !== verified) {
      console.warn(`🚨 lineUserId mismatch: claimed=${claimed} verified=${verified}`);
    }
    req.lineUserId = verified;
    next();
  };
}


/* ══════════════ ตรวจสลิป — EasySlip ══════════════ */

const EASYSLIP_KEY = process.env.EASYSLIP_API_KEY || '';
if (!EASYSLIP_KEY) {
  console.warn('⚠️  ยังไม่ได้ตั้ง EASYSLIP_API_KEY — ระบบจะไม่รับสลิป');
}

/** ค้นค่าจาก response แบบลึกทุกชั้น กันโค้ดพังถ้า EasySlip ปรับโครงสร้าง */
function deepFind(obj, keys, validate) {
  const want = keys.map(k => k.toLowerCase());
  const seen = new Set();
  const stack = [obj];
  while (stack.length) {
    const cur = stack.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    for (const [k, v] of Object.entries(cur)) {
      if (want.includes(k.toLowerCase())) {
        const val = (v && typeof v === 'object' && 'amount' in v) ? v.amount : v;
        if (!validate || validate(val)) return val;
      }
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return undefined;
}

const findAmount = (o) => Number(deepFind(o, ['amount', 'transAmount', 'totalAmount'], v => {
  const n = Number(v && typeof v === 'object' ? v.amount : v);
  return Number.isFinite(n) && n > 0;
})) || 0;

const findTransRef = (o) => deepFind(o,
  ['transRef', 'transactionRef', 'transRefId', 'referenceNo', 'ref'],
  v => typeof v === 'string' && v.length >= 6) || '';

/**
 * ตรวจสลิปกับ EasySlip
 * ผ่าน    → { valid: true, amount, transRef, senderName, receiverName }
 * ไม่ผ่าน → { valid: false, message: 'ข้อความบอกลูกค้า' }
 */
async function verifySlip(fileBuffer, mimetype, expectedAmount) {
  if (!EASYSLIP_KEY) {
    return { valid: false, message: '❌ ระบบตรวจสลิปยังไม่พร้อม กรุณาติดต่อแอดมินครับ' };
  }

  try {
    const form = new FormData();
    form.append('image', fileBuffer, { filename: 'slip.jpg', contentType: mimetype || 'image/jpeg' });
    form.append('checkDuplicate', 'true');
    form.append('matchAmount', String(expectedAmount));

    const res = await axios.post('https://api.easyslip.com/v2/verify/bank', form, {
      headers: { Authorization: `Bearer ${EASYSLIP_KEY}`, ...form.getHeaders() },
      timeout: 20000,
      validateStatus: () => true,
    });

    console.log(`[easyslip] ${res.status} →`, JSON.stringify(res.data).slice(0, 1200));

    if (res.status === 401 || res.status === 403) {
      return { valid: false, message: '❌ API Key ตรวจสลิปไม่ถูกต้อง กรุณาติดต่อแอดมินครับ' };
    }

    const data = res.data || {};
    if (!data.success) {
      const code = data.error?.code || 'UNKNOWN';
      const msg = data.error?.message || 'ตรวจสลิปไม่สำเร็จ';
      if (code === 'SLIP_NOT_FOUND') return { valid: false, message: '❌ ไม่พบ QR Code ในสลิป กรุณาแนบสลิปที่ชัดเจนครับ' };
      if (code === 'DUPLICATE_SLIP') return { valid: false, message: '❌ สลิปนี้ถูกใช้ไปแล้ว ไม่สามารถใช้ซ้ำได้ครับ' };
      if (code === 'SLIP_PENDING')   return { valid: false, message: '⏳ สลิปยังไม่ผ่านระบบธนาคาร กรุณารอสักครู่แล้วลองใหม่ครับ' };
      if (code === 'QUOTA_EXCEEDED') return { valid: false, message: '❌ ระบบตรวจสลิปชั่วคราวไม่พร้อม กรุณาติดต่อแอดมินครับ' };
      return { valid: false, message: `❌ ${msg}` };
    }

    const slip = data.data || {};
    const amount = findAmount(slip);

    if (slip.isDuplicate) {
      return { valid: false, message: '❌ สลิปนี้ถูกใช้ไปแล้ว ไม่สามารถใช้ซ้ำได้ครับ' };
    }
    if (!amount) {
      return { valid: false, message: '❌ อ่านยอดเงินจากสลิปไม่ได้ กรุณาแนบภาพที่ชัดเจนขึ้นครับ' };
    }
    // โอนเกินได้ แต่โอนขาดไม่ได้
    if (slip.isAmountMatched === false || amount < expectedAmount) {
      return {
        valid: false,
        message: `❌ ยอดเงินไม่ถูกต้อง\nพบ: ${amount} บาท\nต้องการ: ${expectedAmount} บาท`,
      };
    }

    return {
      valid: true,
      amount,
      transRef: findTransRef(slip) || '-',
      senderName:   slip.rawSlip?.sender?.account?.name?.th || '-',
      receiverName: slip.rawSlip?.receiver?.account?.name?.th || '-',
    };
  } catch (err) {
    console.error('[easyslip] error:', err.response?.data || err.message);
    return { valid: false, message: '❌ ระบบตรวจสลิปขัดข้อง กรุณาลองใหม่หรือติดต่อแอดมินครับ' };
  }
}


/* ══════════════ Routes ══════════════ */

// จำกัดการยิงสมัคร/ต่ออายุ กันสแปมสลิป (EasySlip คิดเป็นครั้ง) และกัน Google Sheets โดนถล่ม
const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => `submit:${req.body?.lineUserId || req.ip}`,
  message: 'กดส่งถี่เกินไป กรุณารอสักครู่แล้วลองใหม่ครับ',
});

// ข้อมูลสมาชิกเป็นข้อมูลส่วนตัว — ต้องยืนยันว่าเป็นเจ้าของ LINE account จริง
const requireOwner = requireLineUser({ from: 'params', field: 'lineUserId' });

router.get('/member/:lineUserId', requireOwner, async (req, res) => {
  try {
    const member = await getMemberByLineId(req.lineUserId);
    if (!member) return res.json({ found: false });
    res.json({ found: true, ...member, daysLeft: daysLeft(member.expireDate) });
  } catch (err) {
    console.error('GET /member error:', err.message);
    res.status(500).json({ error: 'ดึงข้อมูลไม่สำเร็จ กรุณาลองใหม่ครับ' });
  }
});

router.get('/members/:lineUserId', requireOwner, async (req, res) => {
  try {
    const members = await getMembersByLineId(req.lineUserId);
    if (!members || members.length === 0) return res.json({ found: false, members: [] });
    res.json({ found: true, members: members.map(m => ({ ...m, daysLeft: daysLeft(m.expireDate) })) });
  } catch (err) {
    console.error('GET /members error:', err.message);
    res.status(500).json({ error: 'ดึงข้อมูลไม่สำเร็จ กรุณาลองใหม่ครับ' });
  }
});

router.get('/check-email', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  try {
    const email = req.query.email || '';
    if (!email) return res.json({ exists: false });
    res.json({ exists: await checkEmailExists(email) });
  } catch (err) {
    console.error('check-email error:', err.message);
    res.status(500).json({ error: 'ตรวจสอบอีเมลไม่สำเร็จ กรุณาลองใหม่ครับ' });
  }
});

router.get('/packages', (req, res) => res.json(PACKAGES));

// เช็คว่า EasySlip key ใช้งานได้ไหม — เปิด /api/slip-status ในเบราว์เซอร์ได้เลย
router.get('/slip-status', rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
  if (!EASYSLIP_KEY) {
    return res.json({ ok: false, สรุป: '❌ ยังไม่ได้ตั้ง EASYSLIP_API_KEY ใน Railway' });
  }
  try {
    const r = await axios.get('https://api.easyslip.com/v2/info', {
      headers: { Authorization: `Bearer ${EASYSLIP_KEY}` },
      timeout: 10000, validateStatus: () => true,
    });
    res.json({
      ok: r.status === 200,
      status: r.status,
      data: r.data,
      สรุป: r.status === 200 ? '✅ EasySlip ใช้งานได้ปกติ' : `❌ EasySlip ตอบกลับ ${r.status} — ตรวจสอบ API Key`,
    });
  } catch (err) {
    res.json({ ok: false, สรุป: `❌ ต่อ EasySlip ไม่ได้ — ${err.message}` });
  }
});

/* ══════════════ คำขอต่ออายุ (ไม่คิดเงิน) ══════════════
 *
 * ใช้ย้ายลูกค้าจากระบบเก่า — ลูกค้ากดปุ่ม "ต่ออายุ" ในการ์ด → เปิดหน้า
 * /liff/renew-request.html → กรอกอีเมล → ยิงมาที่นี่ → บันทึกลง Google Sheet
 * แล้วแอดมินเอาข้อมูลไปกรอกในระบบจริงเอง
 *
 * userId มาจาก LINE ID token ที่ verify แล้ว ไม่ใช่ค่าที่ client ส่งมา → ปลอมไม่ได้
 * URL ของ Apps Script อยู่ใน ENV ฝั่ง server เท่านั้น ลูกค้ามองไม่เห็น
 *
 * ตั้ง ENV: COLLECT_URL = URL เว็บแอปของ Apps Script (ลงท้าย /exec)
 */
const COLLECT_URL = process.env.COLLECT_URL || '';

// ★ ต้อง verify ก่อน แล้วค่อยจำกัดจำนวนครั้ง
//   ถ้าจำกัดด้วย IP ก่อน ลูกค้าที่ใช้เน็ตมือถือค่ายเดียวกัน (NAT ร่วม IP) จะบล็อกกันเอง
router.post('/renew-request',
  requireLineUser(),
  rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => `rr:${req.lineUserId}`,
    message: 'ส่งคำขอถี่เกินไป กรุณารอสักครู่ครับ',
  }),
  async (req, res) => {
    const email = String(req.body.memberEmail || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'กรุณากรอกอีเมลครับ' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'รูปแบบอีเมลไม่ถูกต้องครับ' });
    }
    if (!COLLECT_URL) {
      console.warn('⚠️  ยังไม่ได้ตั้ง COLLECT_URL — บันทึกคำขอต่ออายุไม่ได้');
      return res.status(503).json({ error: 'ระบบยังไม่พร้อม กรุณาติดต่อแอดมินครับ' });
    }

    try {
      // URLSearchParams encode ให้เอง — ชื่อไทยหรือชื่อที่มี & จะไม่เพี้ยน
      const q = new URLSearchParams({
        customer_id: req.lineUserId,                                  // B
        customer_name: String(req.body.displayName || '').slice(0, 100), // C
        order: email,                                                 // D ← อีเมลที่แอดมินต้องใช้
        img: 'ต่ออายุ (รอแอดมินดำเนินการ)',                            // E
      });
      const r = await fetch(`${COLLECT_URL}?${q}`, { redirect: 'follow' });
      const text = await r.text();
      console.log(`[renew-request] ${req.lineUserId} ${email} → ${r.status} ${text.slice(0, 100)}`);
      if (!r.ok) return res.status(502).json({ error: 'บันทึกไม่สำเร็จ กรุณาลองใหม่ครับ' });

      res.json({ success: true });
    } catch (err) {
      console.error('[renew-request] error:', err.message);
      res.status(500).json({ error: 'ระบบขัดข้อง กรุณาลองใหม่ครับ' });
    }
  }
);

router.post('/register', upload.single('slip'), submitLimiter, requireLineUser(), async (req, res) => {
  try {
    const lineUserId = req.lineUserId; // มาจาก ID token ที่ verify แล้ว
    const { displayName, packageType } = req.body;
    const memberEmail = String(req.body.memberEmail || '').trim().toLowerCase();

    if (!packageType || !memberEmail) return res.status(400).json({ error: 'ข้อมูลไม่ครบ กรุณากรอกให้ครบทุกช่อง' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(memberEmail)) return res.status(400).json({ error: 'รูปแบบอีเมลไม่ถูกต้องครับ' });
    if (!req.file) return res.status(400).json({ error: 'กรุณาแนบสลิปโอนเงิน' });
    if (!PACKAGES[packageType]) return res.status(400).json({ error: 'แพ็กเกจไม่ถูกต้อง' });

    // ล็อกตามอีเมล: "เช็คซ้ำ + เขียน" ต้องทำทีละคิว
    const outcome = await withLock(`register:${memberEmail}`, async () => {
      if (await checkEmailExists(memberEmail, true)) { // true = ข้าม cache
        return { status: 400, body: { error: `อีเมล ${memberEmail} มีในระบบแล้ว ไม่สามารถสมัครซ้ำได้ครับ` } };
      }

      const slip = await verifySlip(req.file.buffer, req.file.mimetype, PACKAGES[packageType].price);
      if (!slip.valid) return { status: 400, body: { error: slip.message } };

      // กันสลิปซ้ำด้วยตัวเอง — เทียบเลขอ้างอิงกับที่เคยบันทึกไว้ในคอลัมน์ G
      if (await isSlipUsed(slip.transRef)) {
        return { status: 400, body: { error: '❌ สลิปนี้ถูกใช้ไปแล้ว ไม่สามารถใช้ซ้ำได้ครับ' } };
      }

      const result = await addMember({
        lineUserId, displayName, packageType, memberEmail,
        slipUrl: `มีสลิป ✓ (${slip.transRef})`,
      });
      if (!result.success) return { status: 500, body: { error: 'บันทึกข้อมูลไม่สำเร็จ กรุณาติดต่อแอดมินครับ' } };

      return {
        status: 200,
        body: { success: true, expireDate: result.expireDate },
        notify: `✅ ได้รับข้อมูลการสมัครแล้วครับ!\n\n📦 แพ็กเกจ: ${PACKAGES[packageType].label}\n📧 อีเมล: ${memberEmail}\n💰 ยอดโอน: ${slip.amount} บาท\n📅 วันหมดอายุ: ${result.expireDate}\n\n⏳ กรุณารอแอดมินส่งคำเชิญเข้า YouTube Premium\nภายใน 24 ชม. ครับ`,
      };
    });

    if (outcome.notify) await sendLineMessage(lineUserId, outcome.notify);
    res.status(outcome.status).json(outcome.body);
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'ระบบขัดข้อง กรุณาลองใหม่หรือติดต่อแอดมินครับ' });
  }
});

router.post('/renew', upload.single('slip'), submitLimiter, requireLineUser(), async (req, res) => {
  try {
    const lineUserId = req.lineUserId;
    const { packageType, memberEmail } = req.body;

    if (!packageType) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    if (!req.file) return res.status(400).json({ error: 'กรุณาแนบสลิปโอนเงิน' });
    if (!PACKAGES[packageType]) return res.status(400).json({ error: 'แพ็กเกจไม่ถูกต้อง' });

    // ล็อกกันกดต่ออายุรัวๆ แล้วบวกวันซ้อน
    const outcome = await withLock(`renew:${lineUserId}:${memberEmail || ''}`, async () => {
      const slip = await verifySlip(req.file.buffer, req.file.mimetype, PACKAGES[packageType].price);
      if (!slip.valid) return { status: 400, body: { error: slip.message } };

      if (await isSlipUsed(slip.transRef)) {
        return { status: 400, body: { error: '❌ สลิปนี้ถูกใช้ไปแล้ว ไม่สามารถใช้ซ้ำได้ครับ' } };
      }

      const result = await renewMember(lineUserId, packageType, `มีสลิป ✓ (${slip.transRef})`, memberEmail);
      if (!result.success) {
        return { status: 500, body: { error: result.error || 'ต่ออายุไม่สำเร็จ กรุณาติดต่อแอดมินครับ' } };
      }

      return {
        status: 200,
        body: { success: true, expireDate: result.expireDate },
        notify: `✅ ต่ออายุสำเร็จ!\n\n📦 แพ็กเกจ: ${PACKAGES[packageType].label}\n📧 อีเมล: ${memberEmail || ''}\n💰 ยอดโอน: ${slip.amount} บาท\n📅 หมดอายุใหม่: ${result.expireDate}\n\nขอบคุณที่ใช้บริการ ${BRAND}`,
      };
    });

    if (outcome.notify) await sendLineMessage(lineUserId, outcome.notify);
    res.status(outcome.status).json(outcome.body);
  } catch (err) {
    console.error('renew error:', err);
    res.status(500).json({ error: 'ระบบขัดข้อง กรุณาลองใหม่หรือติดต่อแอดมินครับ' });
  }
});

async function sendLineMessage(userId, text) {
  try {
    const { messagingApi } = require('@line/bot-sdk');
    const client = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    });
    await client.pushMessage({ to: userId, messages: [{ type: 'text', text }] });
  } catch (err) {
    console.error('sendLineMessage error:', err.message);
  }
}

// multer โยน error เรื่องไฟล์มาที่นี่
router.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'ไฟล์สลิปใหญ่เกินไป (จำกัด 8MB) กรุณาย่อรูปแล้วลองใหม่ครับ' });
  }
  if (err) {
    console.error('liff-api error:', err.message);
    return res.status(400).json({ error: err.message || 'คำขอไม่ถูกต้อง' });
  }
  next();
});

module.exports = router;
