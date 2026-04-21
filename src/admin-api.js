const express = require('express');
const { getAllMembers, getHouses, updateInviteStatus, getMemberByLineId, addHouse, addHouses, removeMemberFromHouse, getAdmins, writeLog } = require('./sheets');
const dayjs = require('dayjs');
const router = express.Router();

const PKG_LABEL = {
  '1month': '1 เดือน (79 บาท)',
  '2months': '2 เดือน (155 บาท)',
  '3months': '3 เดือน (230 บาท)',
};

// ===== Auth =====
async function authCheck(req, res, next) {
  const username = req.headers['x-admin-user'];
  const password = req.headers['x-admin-pass'];
  if (!username || !password) return res.status(401).json({ error: 'Unauthorized' });
  const admins = await getAdmins();
  const admin = admins.find(a => a.username === username && a.password === password && a.status === 'active');
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
  req.adminName = admin.displayName || username;
  req.adminUser = username;
  next();
}

// ===== Login =====
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'กรุณากรอก username และ password' });
    const admins = await getAdmins();
    const admin = admins.find(a => a.username === username && a.password === password && a.status === 'active');
    if (!admin) return res.status(401).json({ error: 'username หรือ password ไม่ถูกต้อง' });
    res.json({ success: true, displayName: admin.displayName || username, username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Members =====
router.get('/members', authCheck, async (req, res) => {
  try {
    const members = await getAllMembers();
    res.json({ success: true, members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Houses =====
router.get('/houses', authCheck, async (req, res) => {
  try {
    const houses = await getHouses();
    res.json({ success: true, houses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// เพิ่มบ้านเดียว
router.post('/house', authCheck, async (req, res) => {
  try {
    const { houseId, houseEmail, housePassword, expireDate, maxMembers } = req.body;
    if (!houseId || !houseEmail || !housePassword || !expireDate) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    }
    const result = await addHouse({ houseId, houseEmail, housePassword, expireDate, maxMembers: maxMembers || 5 });
    if (!result.success) return res.status(500).json({ error: result.error });
    await writeLog(req.adminUser, req.adminName, 'เพิ่มบ้าน', `${houseId} (${houseEmail})`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// เพิ่มหลายบ้านพร้อมกัน (paste email\npassword\nemail\npassword...)
router.post('/houses/bulk', authCheck, async (req, res) => {
  try {
    const { text, expireDate, maxMembers } = req.body;
    if (!text || !expireDate) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });

    const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length % 2 !== 0) {
      return res.status(400).json({ error: `ข้อมูลไม่ครบคู่ — พบ ${lines.length} บรรทัด (ต้องเป็นจำนวนคู่: email/password)` });
    }

    const houses = [];
    for (let i = 0; i < lines.length; i += 2) {
      houses.push({
        houseEmail: lines[i],
        housePassword: lines[i + 1],
        expireDate,
        maxMembers: maxMembers || 5,
      });
    }

    const result = await addHouses(houses);
    if (!result.success) return res.status(500).json({ error: result.error });

    await writeLog(req.adminUser, req.adminName, 'เพิ่มบ้านหมู่', `${houses.length} บ้าน วันหมดอายุ ${expireDate}`);
    res.json({ success: true, count: houses.length, houses: result.houses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ลบสมาชิกออกจากบ้าน
router.post('/member/remove', authCheck, async (req, res) => {
  try {
    const { rowIndex, lineUserId, memberEmail } = req.body;
    if (!rowIndex) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const result = await removeMemberFromHouse(rowIndex);
    if (!result.success) return res.status(500).json({ error: result.error });
    await writeLog(req.adminUser, req.adminName, 'ลบสมาชิกออกจากบ้าน', `${memberEmail || lineUserId}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Invite =====
router.post('/inviting', authCheck, async (req, res) => {
  try {
    const { rowIndex, lineUserId, houseId } = req.body;
    if (!rowIndex || !lineUserId) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const result = await updateInviteStatus(rowIndex, houseId || '', 'inviting');
    if (!result.success) return res.status(500).json({ error: result.error });
    await writeLog(req.adminUser, req.adminName, 'ส่งเชิญ', `row ${rowIndex} → ${houseId}`);
    await sendLineMessage(lineUserId,
      `📨 Tiger Premium — ส่งคำเชิญแล้ว!\n\nแอดมินส่งคำเชิญเข้า YouTube Premium Family ให้คุณแล้วครับ\n\n✅ กรุณาตรวจสอบอีเมลที่ใช้สมัคร\nแล้วกด "ยอมรับคำเชิญ" ครับ 🐯`
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/invite', authCheck, async (req, res) => {
  try {
    const { rowIndex, lineUserId } = req.body;
    if (!rowIndex || !lineUserId) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const members = await getAllMembers();
    const member = members.find(m => m.rowIndex === parseInt(rowIndex));
    const result = await updateInviteStatus(rowIndex, '', 'invited');
    if (!result.success) return res.status(500).json({ error: result.error });
    await writeLog(req.adminUser, req.adminName, 'ยืนยันกดรับ', `${member?.houseEmail || lineUserId}`);
    const email = member?.houseEmail || '-';
    const pkg = PKG_LABEL[member?.package] || member?.package || '-';
    const expire = member?.expireDate || '-';
    const daysLeft = expire !== '-' ? dayjs(expire).diff(dayjs(), 'day') : '-';
    await sendLineMessage(lineUserId,
      `✅ Tiger Premium — เข้าร่วมสำเร็จ!\n\nยืนยันว่าคุณได้กดรับคำเชิญ YouTube Premium Family เรียบร้อยแล้วครับ\n\n📧 อีเมลที่ใช้เข้าบ้าน: ${email}\n📦 แพ็กเกจ: ${pkg}\n📅 วันหมดอายุ: ${expire} (เหลืออีก ${daysLeft} วัน)\n\nหากมีปัญหาการเข้าใช้งาน กรุณาติดต่อแอดมินได้เลยครับ 🐯`
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Remind =====
router.post('/remind', authCheck, async (req, res) => {
  try {
    const { lineUserId, rowIndex } = req.body;
    const members = await getAllMembers();
    const member = rowIndex
      ? members.find(m => m.rowIndex === parseInt(rowIndex))
      : await getMemberByLineId(lineUserId);
    if (!member) return res.status(404).json({ error: 'ไม่พบสมาชิก' });
    const days = dayjs(member.expireDate).diff(dayjs(), 'day');
    const emoji = days <= 0 ? '❌' : days <= 3 ? '🔴' : '⚠️';
    await writeLog(req.adminUser, req.adminName, 'ส่งแจ้งเตือน', `${member.houseEmail}`);
    await sendLineMessage(lineUserId,
      `${emoji} แจ้งเตือนจากแอดมิน Tiger Premium\n\n📧 อีเมล: ${member.houseEmail || '-'}\n📦 แพ็กเกจ: ${PKG_LABEL[member.package] || '-'}\n📅 วันหมดอายุ: ${member.expireDate}\n⏰ เหลืออีก: ${days > 0 ? days + ' วัน' : 'หมดอายุแล้ว'}\n\nกด "ต่ออายุ" ในเมนูได้เลยครับ 🐯`
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Logs =====
router.get('/logs', authCheck, async (req, res) => {
  try {
    const { getLogs } = require('./sheets');
    const logs = await getLogs();
    res.json({ success: true, logs });
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
