const express = require('express');
const axios = require('axios');
const { getMemberByLineId, addMember, renewMember } = require('./sheets');
const dayjs = require('dayjs');
const router = express.Router();

const PACKAGES = {
  '1month':  { label: '1 เดือน', price: 79,  months: 1 },
  '2months': { label: '2 เดือน', price: 155, months: 2 },
  '3months': { label: '3 เดือน', price: 230, months: 3 },
};

// ดึงข้อมูลสมาชิกตาม LINE User ID
router.get('/member/:lineUserId', async (req, res) => {
  try {
    const member = await getMemberByLineId(req.params.lineUserId);
    if (!member) return res.json({ found: false });

    const expire = dayjs(member.expireDate);
    const daysLeft = expire.diff(dayjs(), 'day');
    res.json({ found: true, ...member, daysLeft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ดูแพ็กเกจ
router.get('/packages', (req, res) => {
  res.json(PACKAGES);
});

// สมัครสมาชิก (หลังตรวจสลิปผ่าน)
router.post('/register', async (req, res) => {
  try {
    const { lineUserId, displayName, packageType, slipUrl } = req.body;
    if (!lineUserId || !packageType || !slipUrl) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    }

    // ตรวจสลิป
    const slipResult = await verifySlip(slipUrl, PACKAGES[packageType]?.price);
    if (!slipResult.valid) {
      return res.status(400).json({ error: slipResult.message });
    }

    // บันทึกลง Sheet
    const result = await addMember({ lineUserId, displayName, packageType, slipUrl });
    if (!result.success) return res.status(500).json({ error: result.error });

    // ส่งข้อความยืนยันกลับไปใน LINE
    await sendLineMessage(lineUserId,
      `✅ สมัครสมาชิก Tiger Premium สำเร็จ!\n\n📦 แพ็กเกจ: ${PACKAGES[packageType].label}\n📅 หมดอายุ: ${result.expireDate}\n\nแอดมินจะส่งข้อมูลเข้าบ้านให้ภายใน 24 ชม. ครับ 🐯`
    );

    res.json({ success: true, expireDate: result.expireDate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ต่ออายุ
router.post('/renew', async (req, res) => {
  try {
    const { lineUserId, packageType, slipUrl } = req.body;
    if (!lineUserId || !packageType || !slipUrl) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    }

    // ตรวจสลิป
    const slipResult = await verifySlip(slipUrl, PACKAGES[packageType]?.price);
    if (!slipResult.valid) {
      return res.status(400).json({ error: slipResult.message });
    }

    // อัปเดต Sheet
    const result = await renewMember(lineUserId, packageType, slipUrl);
    if (!result.success) return res.status(500).json({ error: result.error });

    // ส่งข้อความยืนยัน
    await sendLineMessage(lineUserId,
      `✅ ต่ออายุสำเร็จ!\n\n📦 แพ็กเกจ: ${PACKAGES[packageType].label}\n📅 หมดอายุใหม่: ${result.expireDate}\n\nขอบคุณที่ใช้บริการ Tiger Premium 🐯`
    );

    res.json({ success: true, expireDate: result.expireDate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ตรวจสลิป (Thunder Solution หรือ EasySlip)
async function verifySlip(slipUrl, expectedAmount) {
  try {
    // TODO: เปลี่ยนเป็น Thunder Solution API endpoint จริง
    // ตอนนี้ข้ามการตรวจสำหรับ dev (ใส่ logic จริงตอน production)
    if (process.env.NODE_ENV === 'development') {
      return { valid: true, amount: expectedAmount };
    }

    const THUNDER_API_KEY = process.env.THUNDER_API_KEY;
    const response = await axios.post('https://api.thunder.co.th/slip/verify', {
      url: slipUrl,
    }, {
      headers: { 'Authorization': `Bearer ${THUNDER_API_KEY}` }
    });

    const amount = response.data?.amount;
    if (amount < expectedAmount) {
      return { valid: false, message: `ยอดเงินไม่ถูกต้อง (พบ ${amount} บาท ต้องการ ${expectedAmount} บาท)` };
    }
    return { valid: true, amount };
  } catch (err) {
    console.error('verifySlip error:', err.message);
    return { valid: false, message: 'ไม่สามารถตรวจสลิปได้ กรุณาลองใหม่' };
  }
}

async function sendLineMessage(userId, text) {
  try {
    const client = new (require('@line/bot-sdk').messagingApi.MessagingApiClient)({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    });
    await client.pushMessage({ to: userId, messages: [{ type: 'text', text }] });
  } catch (err) {
    console.error('sendLineMessage error:', err.message);
  }
}

module.exports = router;
