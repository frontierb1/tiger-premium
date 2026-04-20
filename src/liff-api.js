const express = require('express');
const multer = require('multer');
const { getMemberByLineId, getMembersByLineId, checkEmailExists, addMember, renewMember } = require('./sheets');
const dayjs = require('dayjs');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const PACKAGES = {
  '1month':  { label: '1 เดือน', price: 79,  months: 1 },
  '2months': { label: '2 เดือน', price: 155, months: 2 },
  '3months': { label: '3 เดือน', price: 230, months: 3 },
};

router.get('/member/:lineUserId', async (req, res) => {
  try {
    const member = await getMemberByLineId(req.params.lineUserId);
    if (!member) return res.json({ found: false });
    const daysLeft = dayjs(member.expireDate).diff(dayjs(), 'day');
    res.json({ found: true, ...member, daysLeft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/members/:lineUserId', async (req, res) => {
  try {
    const members = await getMembersByLineId(req.params.lineUserId);
    if (!members || members.length === 0) return res.json({ found: false, members: [] });
    const result = members.map(m => ({
      ...m,
      daysLeft: dayjs(m.expireDate).diff(dayjs(), 'day'),
    }));
    res.json({ found: true, members: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// เช็คอีเมลว่ามีในระบบแล้วไหม
router.get('/check-email', async (req, res) => {
  try {
    const email = req.query.email || '';
    if (!email) return res.json({ exists: false });
    const exists = await checkEmailExists(email);
    res.json({ exists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/packages', (req, res) => {
  res.json(PACKAGES);
});

router.post('/register', upload.single('slip'), async (req, res) => {
  try {
    const { lineUserId, displayName, packageType, memberEmail } = req.body;

    if (!lineUserId || !packageType || !memberEmail) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบ กรุณากรอกให้ครบทุกช่อง' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'กรุณาแนบสลิปโอนเงิน' });
    }
    if (!PACKAGES[packageType]) {
      return res.status(400).json({ error: 'แพ็กเกจไม่ถูกต้อง' });
    }

    // เช็คอีเมลซ้ำ
    const emailExists = await checkEmailExists(memberEmail);
    if (emailExists) {
      return res.status(400).json({ error: `อีเมล ${memberEmail} มีในระบบแล้ว ไม่สามารถสมัครซ้ำได้ครับ` });
    }

    const result = await addMember({
      lineUserId, displayName, packageType, memberEmail,
      slipUrl: `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,
    });

    if (!result.success) return res.status(500).json({ error: result.error });

    await sendLineMessage(lineUserId,
      `✅ สมัครสมาชิก Tiger Premium สำเร็จ!\n\n📦 แพ็กเกจ: ${PACKAGES[packageType].label}\n📧 อีเมล: ${memberEmail}\n📅 หมดอายุ: ${result.expireDate}\n\nแอดมินจะส่งข้อมูลเข้าบ้านให้ภายใน 24 ชม. ครับ 🐯`
    );

    res.json({ success: true, expireDate: result.expireDate });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/renew', upload.single('slip'), async (req, res) => {
  try {
    const { lineUserId, packageType, memberEmail } = req.body;

    if (!lineUserId || !packageType) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'กรุณาแนบสลิปโอนเงิน' });
    }
    if (!PACKAGES[packageType]) {
      return res.status(400).json({ error: 'แพ็กเกจไม่ถูกต้อง' });
    }

    const result = await renewMember(
      lineUserId,
      packageType,
      `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,
      memberEmail
    );

    if (!result.success) return res.status(500).json({ error: result.error });

    await sendLineMessage(lineUserId,
      `✅ ต่ออายุสำเร็จ!\n\n📦 แพ็กเกจ: ${PACKAGES[packageType].label}\n📧 อีเมล: ${memberEmail || ''}\n📅 หมดอายุใหม่: ${result.expireDate}\n\nขอบคุณที่ใช้บริการ Tiger Premium 🐯`
    );

    res.json({ success: true, expireDate: result.expireDate });
  } catch (err) {
    console.error('renew error:', err);
    res.status(500).json({ error: err.message });
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

module.exports = router;
