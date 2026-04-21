const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const { getMemberByLineId, getMembersByLineId, checkEmailExists, addMember, renewMember } = require('./sheets');
const dayjs = require('dayjs');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const PACKAGES = {
  '1month':  { label: '1 เดือน', price: 79,  months: 1 },
  '2months': { label: '2 เดือน', price: 155, months: 2 },
  '3months': { label: '3 เดือน', price: 230, months: 3 },
};

// ===== EasySlip Verify =====
async function verifySlipEasySlip(fileBuffer, mimetype, expectedAmount) {
  const EASYSLIP_API_KEY = process.env.EASYSLIP_API_KEY;

  if (!EASYSLIP_API_KEY) {
    console.error('❌ EASYSLIP_API_KEY not set — blocking slip');
    return { valid: false, message: '❌ ระบบตรวจสลิปยังไม่พร้อม กรุณาติดต่อแอดมินครับ' };
  }

  try {
    const form = new FormData();
    form.append('image', fileBuffer, { filename: 'slip.jpg', contentType: mimetype });
    form.append('checkDuplicate', 'true');
    form.append('matchAmount', String(expectedAmount));

    const response = await axios.post('https://api.easyslip.com/v2/verify/bank', form, {
      headers: {
        'Authorization': `Bearer ${EASYSLIP_API_KEY}`,
        ...form.getHeaders(),
      },
      timeout: 15000,
    });

    const data = response.data;
    console.log('EasySlip response:', JSON.stringify(data));

    if (!data.success) {
      const errCode = data.error?.code || 'UNKNOWN';
      const errMsg = data.error?.message || 'ตรวจสลิปไม่สำเร็จ';
      if (errCode === 'SLIP_NOT_FOUND') return { valid: false, message: '❌ ไม่พบ QR Code ในสลิป กรุณาแนบสลิปที่ชัดเจนครับ' };
      if (errCode === 'DUPLICATE_SLIP') return { valid: false, message: '❌ สลิปนี้ถูกใช้ไปแล้ว ไม่สามารถใช้ซ้ำได้ครับ' };
      if (errCode === 'SLIP_PENDING') return { valid: false, message: '⏳ สลิปยังไม่ผ่านระบบธนาคาร กรุณารอสักครู่แล้วลองใหม่ครับ' };
      if (errCode === 'QUOTA_EXCEEDED') return { valid: false, message: '❌ ระบบตรวจสลิปชั่วคราวไม่พร้อม กรุณาติดต่อแอดมินครับ' };
      return { valid: false, message: `❌ ${errMsg}` };
    }

    const slip = data.data;
    const slipAmount = slip.rawSlip?.amount?.amount || 0;

    // เช็คสลิปซ้ำ
    if (slip.isDuplicate) {
      return { valid: false, message: '❌ สลิปนี้ถูกใช้ไปแล้ว ไม่สามารถใช้ซ้ำได้ครับ' };
    }

    // เช็คยอดเงิน
    if (slip.isAmountMatched === false || slipAmount < expectedAmount) {
      return {
        valid: false,
        message: `❌ ยอดเงินไม่ถูกต้อง\nพบ: ${slipAmount} บาท\nต้องการ: ${expectedAmount} บาท`
      };
    }

    const senderName = slip.rawSlip?.sender?.account?.name?.th || '-';
    const receiverBank = slip.rawSlip?.receiver?.bank?.name || '-';

    return {
      valid: true,
      amount: slipAmount,
      senderName,
      receiverBank,
      transRef: slip.rawSlip?.transRef || '-',
    };

  } catch (err) {
    console.error('verifySlipEasySlip error:', err.response?.data || err.message);
    if (err.response?.status === 401) return { valid: false, message: '❌ API Key ไม่ถูกต้อง กรุณาติดต่อแอดมินครับ' };
    return { valid: false, message: '❌ ระบบตรวจสลิปขัดข้อง กรุณาลองใหม่หรือติดต่อแอดมินครับ' };
  }
}

// ===== Routes =====

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

    // ตรวจสลิป
    const slipResult = await verifySlipEasySlip(
      req.file.buffer,
      req.file.mimetype,
      PACKAGES[packageType].price
    );

    if (!slipResult.valid) {
      return res.status(400).json({ error: slipResult.message });
    }

    const result = await addMember({
      lineUserId,
      displayName,
      packageType,
      memberEmail,
      slipUrl: `มีสลิป ✓ (${slipResult.transRef})`,
    });

    if (!result.success) return res.status(500).json({ error: result.error });

    await sendLineMessage(lineUserId,
      `✅ สมัครสมาชิก Tiger Premium สำเร็จ!\n\n📦 แพ็กเกจ: ${PACKAGES[packageType].label}\n📧 อีเมล: ${memberEmail}\n💰 ยอดโอน: ${slipResult.amount} บาท\n💳 โอนจาก: ${slipResult.senderName}\n🏦 ธนาคารรับ: ${slipResult.receiverBank}\n📅 หมดอายุ: ${result.expireDate}\n\nแอดมินจะส่งข้อมูลเข้าบ้านให้ภายใน 24 ชม. ครับ 🐯`
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

    // ตรวจสลิป
    const slipResult = await verifySlipEasySlip(
      req.file.buffer,
      req.file.mimetype,
      PACKAGES[packageType].price
    );

    if (!slipResult.valid) {
      return res.status(400).json({ error: slipResult.message });
    }

    const result = await renewMember(
      lineUserId,
      packageType,
      `มีสลิป ✓ (${slipResult.transRef})`,
      memberEmail
    );

    if (!result.success) return res.status(500).json({ error: result.error });

    await sendLineMessage(lineUserId,
      `✅ ต่ออายุสำเร็จ!\n\n📦 แพ็กเกจ: ${PACKAGES[packageType].label}\n📧 อีเมล: ${memberEmail || ''}\n💰 ยอดโอน: ${slipResult.amount} บาท\n💳 โอนจาก: ${slipResult.senderName}\n🏦 ธนาคารรับ: ${slipResult.receiverBank}\n📅 หมดอายุใหม่: ${result.expireDate}\n\nขอบคุณที่ใช้บริการ Tiger Premium 🐯`
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
