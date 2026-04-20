const express = require('express');
const { getAllMembers, getHouses, updateInviteStatus, getMemberByLineId } = require('./sheets');
const dayjs = require('dayjs');
const router = express.Router();

const ADMIN_KEY = process.env.ADMIN_KEY || 'tiger2026admin';

function authCheck(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

router.get('/members', authCheck, async (req, res) => {
  try {
    const members = await getAllMembers();
    res.json({ success: true, members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/houses', authCheck, async (req, res) => {
  try {
    const houses = await getHouses();
    res.json({ success: true, houses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// แอดมินกด "ส่งเชิญ" → status = inviting + แจ้งลูกค้า
router.post('/inviting', authCheck, async (req, res) => {
  try {
    const { rowIndex, lineUserId, houseId } = req.body;
    if (!rowIndex || !lineUserId) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });

    const result = await updateInviteStatus(rowIndex, houseId || '', 'inviting');
    if (!result.success) return res.status(500).json({ error: result.error });

    await sendLineMessage(lineUserId,
      `📨 Tiger Premium — ส่งคำเชิญแล้ว!\n\nแอดมินส่งคำเชิญเข้า YouTube Premium Family ให้คุณแล้วครับ\n\n✅ กรุณาตรวจสอบอีเมลที่ใช้สมัคร แล้วกด "ยอมรับคำเชิญ" ครับ 🐯`
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// แอดมินกด "กดรับแล้ว" → status = invited (ซ่อนจาก Dashboard)
router.post('/invite', authCheck, async (req, res) => {
  try {
    const { rowIndex, lineUserId } = req.body;
    if (!rowIndex || !lineUserId) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });

    const result = await updateInviteStatus(rowIndex, '', 'invited');
    if (!result.success) return res.status(500).json({ error: result.error });

    await sendLineMessage(lineUserId,
      `✅ Tiger Premium — เข้าร่วมสำเร็จ!\n\nยืนยันว่าคุณได้กดรับคำเชิญ YouTube Premium Family เรียบร้อยแล้ว\n\nขอบคุณที่ใช้บริการ Tiger Premium ครับ 🐯`
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
