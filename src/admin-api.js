const express = require('express');
const { getAllMembers, getHouses, updateInviteStatus, getMemberByLineId } = require('./sheets');
const dayjs = require('dayjs');
const router = express.Router();

const ADMIN_KEY = process.env.ADMIN_KEY || 'tiger2026admin';

function authCheck(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ดึงสมาชิกทั้งหมด
router.get('/members', authCheck, async (req, res) => {
  try {
    const members = await getAllMembers();
    res.json({ success: true, members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ดึงบ้านทั้งหมด
router.get('/houses', authCheck, async (req, res) => {
  try {
    const houses = await getHouses();
    res.json({ success: true, houses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// แอดมินกด "เชิญแล้ว" → อัปเดต Sheet + ส่ง LINE แจ้งลูกค้า
router.post('/invite', authCheck, async (req, res) => {
  try {
    const { rowIndex, lineUserId, houseId } = req.body;
    if (!rowIndex || !lineUserId) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    }

    const result = await updateInviteStatus(rowIndex, houseId || '', 'invited');
    if (!result.success) return res.status(500).json({ error: result.error });

    // ส่ง LINE แจ้งลูกค้าว่าเชิญแล้ว
    await sendLineMessage(lineUserId,
      `✅ Tiger Premium — เชิญเข้ากลุ่มแล้ว!\n\nแอดมินได้เชิญคุณเข้า YouTube Premium Family เรียบร้อยแล้วครับ\n\n📧 กรุณาตรวจสอบอีเมลที่ใช้สมัคร และกดยอมรับคำเชิญครับ 🐯`
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ส่งแจ้งเตือนใกล้หมดอายุ manual
router.post('/remind', authCheck, async (req, res) => {
  try {
    const { lineUserId } = req.body;
    const member = await getMemberByLineId(lineUserId);
    if (!member) return res.status(404).json({ error: 'ไม่พบสมาชิก' });

    const days = dayjs(member.expireDate).diff(dayjs(), 'day');
    await sendLineMessage(lineUserId,
      `⚠️ แจ้งเตือนจากแอดมิน Tiger Premium\n\nสมาชิกของคุณจะหมดอายุในอีก ${days} วัน\n📅 วันหมดอายุ: ${member.expireDate}\n\nกด "ต่ออายุ" ในเมนูได้เลยครับ 🐯`
    );

    res.json({ success: true });
  } catch (err) {
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
