const express = require('express');
const multer = require('multer');
const { getMemberByLineId, getMembersByLineId, checkEmailExists, isSlipUsed, addMember, renewMember } = require('./sheets');
const { daysLeft } = require('./time');
const { BRAND } = require('./brand');
const { requireLineUser } = require('./line-auth');
const { rateLimit } = require('./rate-limit');
const { withLock } = require('./lock');
const { verifySlip } = require('./slip-verify');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 }, // สลิปไม่ควรเกิน 8MB
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) {
      return cb(new Error('กรุณาแนบไฟล์รูปภาพเท่านั้น'));
    }
    cb(null, true);
  },
});

// จำกัดการยิงสมัคร/ต่ออายุ กันคนสแปมสลิป (ผู้ให้บริการคิดเป็นครั้ง) และ Google Sheets
const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => `submit:${req.body?.lineUserId || req.ip}`,
  message: 'กดส่งถี่เกินไป กรุณารอสักครู่แล้วลองใหม่ครับ',
});

const PACKAGES = {
  '1month':  { label: '1 เดือน', price: 75,  months: 1 },
  '2months': { label: '2 เดือน', price: 150, months: 2 },
  '3months': { label: '3 เดือน', price: 220, months: 3 },
};

// ===== Routes =====

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
    const result = members.map(m => ({ ...m, daysLeft: daysLeft(m.expireDate) }));
    res.json({ found: true, members: result });
  } catch (err) {
    console.error('GET /members error:', err.message);
    res.status(500).json({ error: 'ดึงข้อมูลไม่สำเร็จ กรุณาลองใหม่ครับ' });
  }
});

router.get('/check-email', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  try {
    const email = req.query.email || '';
    if (!email) return res.json({ exists: false });
    const exists = await checkEmailExists(email);
    res.json({ exists });
  } catch (err) {
    console.error('check-email error:', err.message);
    res.status(500).json({ error: 'ตรวจสอบอีเมลไม่สำเร็จ กรุณาลองใหม่ครับ' });
  }
});

router.get('/packages', (req, res) => {
  res.json(PACKAGES);
});

router.post('/register', upload.single('slip'), submitLimiter, requireLineUser(), async (req, res) => {
  try {
    const lineUserId = req.lineUserId; // มาจาก ID token ที่ verify แล้ว
    const { displayName, packageType } = req.body;
    const memberEmail = String(req.body.memberEmail || '').trim().toLowerCase();

    if (!packageType || !memberEmail) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบ กรุณากรอกให้ครบทุกช่อง' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(memberEmail)) {
      return res.status(400).json({ error: 'รูปแบบอีเมลไม่ถูกต้องครับ' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'กรุณาแนบสลิปโอนเงิน' });
    }
    if (!PACKAGES[packageType]) {
      return res.status(400).json({ error: 'แพ็กเกจไม่ถูกต้อง' });
    }

    // ล็อกตามอีเมล: "เช็คซ้ำ + เขียน" ต้องทำทีละคิว
    // ไม่งั้นกดรัวๆ หรือสองคนพร้อมกันจะผ่านการเช็คทั้งคู่แล้วเขียนซ้ำลง Sheet
    const outcome = await withLock(`register:${memberEmail}`, async () => {
      const emailExists = await checkEmailExists(memberEmail, true); // true = ข้าม cache
      if (emailExists) {
        return { status: 400, body: { error: `อีเมล ${memberEmail} มีในระบบแล้ว ไม่สามารถสมัครซ้ำได้ครับ` } };
      }

      // ตรวจสลิป (อยู่ในล็อกด้วย เพื่อไม่ให้สลิปใบเดียวถูกใช้สองรอบพร้อมกัน)
      const slipResult = await verifySlip(
        req.file.buffer,
        req.file.mimetype,
        PACKAGES[packageType].price
      );
      if (!slipResult.valid) {
        return { status: 400, body: { error: slipResult.message } };
      }

      // กันสลิปซ้ำด้วยตัวเอง — ไม่พึ่งฟีเจอร์ของผู้ให้บริการ
      // (เทียบเลขอ้างอิงกับที่เคยบันทึกไว้ในคอลัมน์ G)
      if (await isSlipUsed(slipResult.transRef)) {
        return { status: 400, body: { error: '❌ สลิปนี้ถูกใช้ไปแล้ว ไม่สามารถใช้ซ้ำได้ครับ' } };
      }

      const result = await addMember({
        lineUserId,
        displayName,
        packageType,
        memberEmail,
        slipUrl: `มีสลิป ✓ (${slipResult.transRef})`,
      });
      if (!result.success) {
        return { status: 500, body: { error: 'บันทึกข้อมูลไม่สำเร็จ กรุณาติดต่อแอดมินครับ' } };
      }

      return {
        status: 200,
        body: { success: true, expireDate: result.expireDate },
        notify: `✅ ได้รับข้อมูลการสมัครแล้วครับ!\n\n📦 แพ็กเกจ: ${PACKAGES[packageType].label}\n📧 อีเมล: ${memberEmail}\n💰 ยอดโอน: ${slipResult.amount} บาท\n📅 วันหมดอายุ: ${result.expireDate}\n\n⏳ กรุณารอแอดมินส่งคำเชิญเข้า YouTube Premium\nภายใน 24 ชม. ครับ`,
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
    const lineUserId = req.lineUserId; // มาจาก ID token ที่ verify แล้ว
    const { packageType, memberEmail } = req.body;

    if (!packageType) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'กรุณาแนบสลิปโอนเงิน' });
    }
    if (!PACKAGES[packageType]) {
      return res.status(400).json({ error: 'แพ็กเกจไม่ถูกต้อง' });
    }

    // ล็อกตาม user+email กันกดต่ออายุรัวๆ แล้วบวกวันซ้อน
    const outcome = await withLock(`renew:${lineUserId}:${memberEmail || ''}`, async () => {
      const slipResult = await verifySlip(
        req.file.buffer,
        req.file.mimetype,
        PACKAGES[packageType].price
      );
      if (!slipResult.valid) {
        return { status: 400, body: { error: slipResult.message } };
      }

      // กันสลิปซ้ำด้วยตัวเอง — ไม่พึ่งฟีเจอร์ของผู้ให้บริการ
      if (await isSlipUsed(slipResult.transRef)) {
        return { status: 400, body: { error: '❌ สลิปนี้ถูกใช้ไปแล้ว ไม่สามารถใช้ซ้ำได้ครับ' } };
      }

      const result = await renewMember(
        lineUserId,
        packageType,
        `มีสลิป ✓ (${slipResult.transRef})`,
        memberEmail
      );
      if (!result.success) {
        return { status: 500, body: { error: result.error || 'ต่ออายุไม่สำเร็จ กรุณาติดต่อแอดมินครับ' } };
      }

      return {
        status: 200,
        body: { success: true, expireDate: result.expireDate },
        notify: `✅ ต่ออายุสำเร็จ!\n\n📦 แพ็กเกจ: ${PACKAGES[packageType].label}\n📧 อีเมล: ${memberEmail || ''}\n💰 ยอดโอน: ${slipResult.amount} บาท\n📅 หมดอายุใหม่: ${result.expireDate}\n\nขอบคุณที่ใช้บริการ ${BRAND}`,
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

// ===== Error handler เฉพาะ router นี้ (multer โยน error เรื่องไฟล์มาที่นี่) =====
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
