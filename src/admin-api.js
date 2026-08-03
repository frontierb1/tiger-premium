/*
 * admin-api.js — API สำหรับหน้า Admin Dashboard
 *
 * ★ ไฟล์นี้ทำงานได้ด้วยตัวเอง อัปแยกไฟล์เดียวได้เลย
 *   ใช้แค่ express + dayjs + ./sheets ที่มีอยู่แล้ว ไม่ต้องรอไฟล์อื่น
 *
 * ★ เปลี่ยนชื่อแบรนด์ในข้อความ LINE → ตั้ง ENV `BRAND_NAME` ใน Railway
 *   ถ้าไม่ตั้ง จะใช้ 'Tube' เป็นค่าเริ่มต้น
 */

const express = require('express');
const crypto = require('crypto');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const {
  getAllMembers, getHouses, updateInviteStatus, getMemberByLineId,
  addHouse, addHouses, removeMemberFromHouse, moveMemberToHouse, moveMembersToHouse,
  updateMemberEmail, updateMemberExpire, updateHousePassword, updateHouseNote,
  updateHouseStatus, deleteHouse, addReport, getReports,
  updateReportStatus, getAdmins, writeLog,
} = require('./sheets');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const router = express.Router();

// ===== ชื่อแบรนด์ =====
const BRAND = process.env.BRAND_NAME || 'Tube';

// ===== เวลาไทย =====
// Railway รันบน UTC ถ้าไม่บังคับเขตเวลา ตัวเลข "เหลืออีกกี่วัน" จะคลาดเคลื่อน 1 วัน
// ในช่วง 00:00–07:00 น. ตามเวลาไทย
const TZ = process.env.APP_TZ || 'Asia/Bangkok';

/** จำนวนวันคงเหลือ นับเป็นวันปฏิทินไทย (พรุ่งนี้ = 1, วันนี้ = 0, เมื่อวาน = -1) */
function daysLeft(expireDate) {
  const d = String(expireDate || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 0;
  try {
    const target = dayjs.tz(d, 'YYYY-MM-DD', TZ).startOf('day');
    if (!target.isValid()) return 0;
    return target.diff(dayjs().tz(TZ).startOf('day'), 'day');
  } catch {
    return 0;
  }
}

const PKG_LABEL = {
  '1month': '1 เดือน (75 บาท)',
  '2months': '2 เดือน (150 บาท)',
  '3months': '3 เดือน (220 บาท)',
};

// ===== จำกัดจำนวนครั้ง (เขียนไว้ในไฟล์นี้เอง ไม่ต้องพึ่งไฟล์อื่น) =====
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

// ===== ตรวจสอบสิทธิ์แอดมิน =====

/** เทียบรหัสผ่านแบบ constant-time กัน timing attack */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * หา admin ที่ตรงกับ username/password
 * ⚠️ ใส่ status ให้เองถ้า ADMINS_JSON ไม่ได้ระบุมา
 *    ไม่งั้นจะ login ไม่ได้เลยทั้งที่รหัสถูก
 */
async function findAdmin(username, password) {
  const admins = await getAdmins();
  const found = (admins || [])
    .map(a => ({ ...a, status: a.status || 'active', role: a.role || 'admin' }))
    .find(a => a.username === username && safeEqual(a.password, password) && a.status === 'active');
  return found || null;
}

async function authCheck(req, res, next) {
  try {
    const username = req.headers['x-admin-user'];
    const password = req.headers['x-admin-pass'];
    if (!username || !password) return res.status(401).json({ error: 'Unauthorized' });
    const admin = await findAdmin(username, password);
    if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
    req.adminName = admin.displayName || username;
    req.adminUser = username;
    req.adminRole = admin.role;
    next();
  } catch (err) {
    console.error('authCheck error:', err.message);
    res.status(500).json({ error: 'ตรวจสอบสิทธิ์ไม่สำเร็จ' });
  }
}

// ===== Login =====
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `login:${req.ip}`,
  message: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'กรุณากรอก username และ password' });
    const admin = await findAdmin(username, password);
    if (!admin) return res.status(401).json({ error: 'username หรือ password ไม่ถูกต้อง' });
    res.json({ success: true, displayName: admin.displayName || username, username, role: admin.role });
  } catch (err) {
    console.error('login error:', err.message);
    res.status(500).json({ error: 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่' });
  }
});

// ===== Members =====
router.get('/members', authCheck, async (req, res) => {
  try {
    res.json({ success: true, members: await getAllMembers() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Houses =====
router.get('/houses', authCheck, async (req, res) => {
  try {
    res.json({ success: true, houses: await getHouses() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// เพิ่มบ้านเดียว
router.post('/house', authCheck, async (req, res) => {
  try {
    const { houseId, houseEmail, housePassword, expireDate, maxMembers } = req.body;
    // houseId ไม่บังคับ — ถ้าไม่ส่งมา ระบบตั้งชื่อ house_xx ให้เอง
    // (หน้า Admin ส่งค่าว่างมาเสมอ ถ้าบังคับตรงนี้จะขึ้น "ข้อมูลไม่ครบ" ทุกครั้ง)
    if (!houseEmail || !housePassword || !expireDate) {
      return res.status(400).json({ error: 'กรุณากรอกอีเมล รหัสผ่าน และวันหมดอายุให้ครบ' });
    }
    const result = await addHouse({ houseId, houseEmail, housePassword, expireDate, maxMembers: maxMembers || 5 });
    if (!result.success) return res.status(400).json({ error: result.error });
    await writeLog(req.adminUser, req.adminName, 'เพิ่มบ้าน', `${result.houseId} (${houseEmail})`);
    res.json({ success: true, houseId: result.houseId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// เพิ่มหลายบ้านพร้อมกัน (วางเป็น email/password สลับบรรทัด)
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
      houses.push({ houseEmail: lines[i], housePassword: lines[i + 1], expireDate, maxMembers: maxMembers || 5 });
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

// ย้ายสมาชิกไปบ้านใหม่
router.post('/member/move', authCheck, async (req, res) => {
  try {
    const { rowIndex, lineUserId, memberEmail, houseId } = req.body;
    if (!rowIndex || !houseId) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const result = await moveMemberToHouse(rowIndex, houseId);
    if (!result.success) return res.status(500).json({ error: result.error });
    await writeLog(req.adminUser, req.adminName, 'ย้ายสมาชิก', `${memberEmail || lineUserId} → ${houseId}`);
    if (lineUserId) {
      await sendLineMessage(lineUserId,
        `📨 ${BRAND} — ส่งคำเชิญใหม่!\n\nแอดมินย้ายคุณไปบ้านใหม่แล้วครับ\n\n✅ กรุณาตรวจสอบอีเมลที่ใช้สมัคร\nแล้วกด "ยอมรับคำเชิญ" ครับ`
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// แก้ไขข้อมูลสมาชิก (อีเมล + วันหมดอายุ)
router.post('/member/edit', authCheck, async (req, res) => {
  try {
    const { rowIndex, oldEmail, newEmail, newExpire } = req.body;
    if (!rowIndex) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const logs = [];
    if (newEmail && newEmail !== oldEmail) {
      const r = await updateMemberEmail(rowIndex, newEmail);
      if (!r.success) return res.status(500).json({ error: r.error });
      logs.push(`อีเมล: ${oldEmail} → ${newEmail}`);
    }
    if (newExpire) {
      const r = await updateMemberExpire(rowIndex, newExpire);
      if (!r.success) return res.status(500).json({ error: r.error });
      logs.push(`หมดอายุ: ${newExpire}`);
    }
    if (logs.length) await writeLog(req.adminUser, req.adminName, 'แก้ไขสมาชิก', logs.join(', '));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// แก้ไข password บ้าน
router.post('/house/password', authCheck, async (req, res) => {
  try {
    const { houseId, newPassword } = req.body;
    if (!houseId || !newPassword) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const result = await updateHousePassword(houseId, newPassword);
    if (!result.success) return res.status(500).json({ error: result.error });
    await writeLog(req.adminUser, req.adminName, 'แก้ไข password บ้าน', `${houseId}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// บันทึกหมายเหตุของบ้าน — ไม่บังคับกรอก ส่งค่าว่างมาคือลบหมายเหตุ
router.post('/house/note', authCheck, async (req, res) => {
  try {
    const { houseId, note } = req.body;
    if (!houseId) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const result = await updateHouseNote(houseId, note);
    if (!result.success) return res.status(400).json({ error: result.error });
    await writeLog(req.adminUser, req.adminName, 'แก้หมายเหตุบ้าน',
      `${houseId}: ${String(note || '').slice(0, 80) || '(ลบหมายเหตุ)'}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// แก้สถานะบ้าน (active/inactive)
router.post('/house/status', authCheck, async (req, res) => {
  try {
    const { houseId, status } = req.body;
    if (!houseId || !status) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const result = await updateHouseStatus(houseId, status);
    if (!result.success) return res.status(500).json({ error: result.error });
    await writeLog(req.adminUser, req.adminName, 'แก้สถานะบ้าน', `${houseId} → ${status}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ลบบ้าน
router.post('/house/delete', authCheck, async (req, res) => {
  try {
    const { houseId } = req.body;
    if (!houseId) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const result = await deleteHouse(houseId);
    if (!result.success) return res.status(500).json({ error: result.error });
    await writeLog(req.adminUser, req.adminName, 'ลบบ้าน', `${houseId}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== ย้ายสมาชิกทั้งบ้าน =====
// ใช้ตอนบ้านพัง ต้องย้ายลูกค้าทั้งหมดไปบ้านใหม่ในทีเดียว
// ลูกค้าจะได้ข้อความสั้นๆ พร้อมลิงก์ไปหน้าเว็บที่มีขั้นตอนแบบกดได้
router.post('/house/move-all', authCheck, async (req, res) => {
  try {
    const { fromHouseId, toHouseId, rowIndexes, closeOldHouse } = req.body;
    if (!toHouseId || !Array.isArray(rowIndexes) || !rowIndexes.length) {
      return res.status(400).json({ error: 'กรุณาเลือกบ้านปลายทางและสมาชิกที่จะย้าย' });
    }
    if (fromHouseId && fromHouseId === toHouseId) {
      return res.status(400).json({ error: 'บ้านปลายทางต้องไม่ใช่บ้านเดิม' });
    }

    // เช็คว่าบ้านปลายทางมีที่ว่างพอไหม (นับจากข้อมูลจริง ไม่พึ่งสูตรในชีต)
    const houses = await getHouses();
    const target = houses.find(h => h.houseId === toHouseId);
    if (!target) return res.status(400).json({ error: `ไม่พบบ้าน ${toHouseId}` });
    if (target.slotsLeft < rowIndexes.length) {
      return res.status(400).json({
        error: `บ้าน ${toHouseId} ว่างแค่ ${target.slotsLeft} ที่ แต่จะย้าย ${rowIndexes.length} คน`,
      });
    }

    const members = await getAllMembers();
    const picked = rowIndexes
      .map(r => members.find(m => m.rowIndex === parseInt(r)))
      .filter(Boolean);

    const result = await moveMembersToHouse(rowIndexes, toHouseId);
    if (!result.success) return res.status(500).json({ error: result.error });

    await writeLog(req.adminUser, req.adminName, 'ย้ายทั้งบ้าน',
      `${fromHouseId || '-'} → ${toHouseId} (${result.moved} คน)`);

    // ปิดบ้านเดิมกันเผลอเอาไปใช้ต่อ
    let closedOld = false;
    if (closeOldHouse && fromHouseId) {
      const r = await updateHouseStatus(fromHouseId, 'inactive');
      closedOld = r.success;
      if (closedOld) {
        await writeLog(req.adminUser, req.adminName, 'ปิดบ้านเดิมหลังย้าย', fromHouseId);
      }
    }

    // ส่ง LINE ทีละคน เว้นจังหวะเล็กน้อยกัน LINE ตีกลับเพราะยิงถี่
    const liffUrl = process.env.LIFF_ID ? `https://liff.line.me/${process.env.LIFF_ID}` : '';
    let sent = 0;
    for (const m of picked) {
      if (!m.lineUserId) continue;
      const ok = await sendLineMessage(m.lineUserId, buildMoveMessage(m, toHouseId, liffUrl));
      if (ok) sent += 1;
      await new Promise(r => setTimeout(r, 300));
    }

    res.json({ success: true, moved: result.moved, sent, closedOld });
  } catch (err) {
    console.error('move-all error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** ข้อความแจ้งลูกค้าตอนย้ายบ้าน — สั้น อ่านง่าย รายละเอียดอยู่ในหน้าเว็บ */
function buildMoveMessage(member, toHouseId, liffUrl) {
  const lines = [
    `🚚 ${BRAND} — ย้ายบ้านให้แล้วครับ`,
    '',
    `📧 อีเมล: ${member.houseEmail || '-'}`,
    '',
    'รบกวนลูกค้าย้ายกลุ่มนะครับ',
    'กดออกจากกลุ่มเดิม แล้วกดรับคำเชิญใหม่ได้เลย',
  ];
  if (liffUrl) {
    lines.push('', '👉 ดูวิธีย้ายแบบละเอียด (กดได้เลย)', liffUrl);
  } else {
    lines.push(
      '', 'วิธีออกจากกลุ่มครอบครัว',
      '1. เข้า https://myaccount.google.com/family/details',
      '2. กด "ออกจากกลุ่ม" (Leave family group)',
      '3. กด "ดูคำเชิญ" (View invitation)'
    );
  }
  lines.push(
    '',
    '⚠️ หลังย้ายแล้ว ถ้าใช้งานไม่ได้อีก',
    'กรุณาแจ้งแอดมินก่อน ห้ามกดออกจากกลุ่มเองเด็ดขาด'
  );
  return lines.join('\n');
}

// ===== ส่งคำเชิญ =====
router.post('/inviting', authCheck, async (req, res) => {
  try {
    const { rowIndex, lineUserId, houseId } = req.body;
    if (!rowIndex || !lineUserId) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const result = await updateInviteStatus(rowIndex, houseId || '', 'inviting');
    if (!result.success) return res.status(500).json({ error: result.error });
    await writeLog(req.adminUser, req.adminName, 'ส่งเชิญ', `row ${rowIndex} → ${houseId}`);
    await sendLineMessage(lineUserId,
      `📨 ${BRAND} — ส่งคำเชิญแล้ว!\n\nแอดมินส่งคำเชิญเข้า YouTube Premium Family ให้คุณแล้วครับ\n\n✅ กรุณาตรวจสอบอีเมลที่ใช้สมัคร\nแล้วกด "ยอมรับคำเชิญ" ครับ`
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ยืนยันว่าลูกค้ากดรับคำเชิญแล้ว
router.post('/invite', authCheck, async (req, res) => {
  try {
    const { rowIndex, lineUserId } = req.body;
    if (!rowIndex || !lineUserId) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const members = await getAllMembers();
    const member = members.find(m => m.rowIndex === parseInt(rowIndex));
    const existingHouseId = member?.houseId || ''; // เก็บ houseId เดิมไว้ ไม่ล้างออก
    const result = await updateInviteStatus(rowIndex, existingHouseId, 'active');
    if (!result.success) return res.status(500).json({ error: result.error });
    await writeLog(req.adminUser, req.adminName, 'ยืนยันกดรับ', `${member?.houseEmail || lineUserId}`);

    const email = member?.houseEmail || '-';
    const pkg = PKG_LABEL[member?.package] || member?.package || '-';
    const expire = member?.expireDate || '-';
    const remaining = expire !== '-' ? daysLeft(expire) : '-';

    await sendLineMessage(lineUserId,
      `✅ ${BRAND} — เข้าร่วมสำเร็จ!\n\nยืนยันว่าคุณได้กดรับคำเชิญ YouTube Premium Family เรียบร้อยแล้วครับ\n\n📧 อีเมลที่ใช้เข้าบ้าน: ${email}\n📦 แพ็กเกจ: ${pkg}\n📅 วันหมดอายุ: ${expire} (เหลืออีก ${remaining} วัน)\n\nหากมีปัญหาการเข้าใช้งาน กรุณาติดต่อแอดมินได้เลยครับ`
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== แจ้งเตือนรายคน =====
router.post('/remind', authCheck, async (req, res) => {
  try {
    const { lineUserId, rowIndex } = req.body;
    const members = await getAllMembers();
    const member = rowIndex
      ? members.find(m => m.rowIndex === parseInt(rowIndex))
      : await getMemberByLineId(lineUserId);
    if (!member) return res.status(404).json({ error: 'ไม่พบสมาชิก' });

    const days = daysLeft(member.expireDate);
    const emoji = days <= 0 ? '❌' : days <= 3 ? '🔴' : '⚠️';
    await writeLog(req.adminUser, req.adminName, 'ส่งแจ้งเตือน', `${member.houseEmail}`);
    await sendLineMessage(lineUserId,
      `${emoji} แจ้งเตือนจากแอดมิน ${BRAND}\n\n📧 อีเมล: ${member.houseEmail || '-'}\n📦 แพ็กเกจ: ${PKG_LABEL[member.package] || '-'}\n📅 วันหมดอายุ: ${member.expireDate}\n⏰ เหลืออีก: ${days > 0 ? days + ' วัน' : 'หมดอายุแล้ว'}\n\nกด "ต่ออายุ" ในเมนูได้เลยครับ`
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== ตรวจสถานะระบบตรวจสลิป =====
// GET /api/admin/slip-status — ใช้เช็คว่า API key ใช้งานได้ไหม
// (ถ้ายังไม่ได้อัป src/slip-verify.js จะแจ้งว่ายังไม่พร้อม ไม่ทำให้ระบบพัง)
router.get('/slip-status', authCheck, async (req, res) => {
  try {
    let checkProviderStatus;
    try {
      ({ checkProviderStatus } = require('./slip-verify'));
    } catch {
      return res.json({ success: true, ok: null, สรุป: 'ยังไม่ได้ติดตั้ง src/slip-verify.js — ข้ามการตรวจ' });
    }
    const result = await checkProviderStatus();
    res.json({
      success: true,
      ...result,
      สรุป: result.ok
        ? `✅ ${result.provider} ใช้งานได้ปกติ`
        : `❌ ${result.provider} ใช้งานไม่ได้ — ${result.hint || result.reason || 'ดูรายละเอียดใน data'}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Logs =====
router.get('/logs', authCheck, async (req, res) => {
  try {
    const { getLogs } = require('./sheets');
    res.json({ success: true, logs: await getLogs() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== แจ้งปัญหา =====
router.get('/reports', authCheck, async (req, res) => {
  try {
    res.json({ success: true, reports: await getReports() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/report/status', authCheck, async (req, res) => {
  try {
    const { rowIndex, status, lineUserId, memberEmail } = req.body;
    if (!rowIndex || !status) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const result = await updateReportStatus(rowIndex, status);
    if (!result.success) return res.status(500).json({ error: result.error });
    await writeLog(req.adminUser, req.adminName, 'อัปเดตสถานะปัญหา', `${memberEmail} → ${status}`);
    if (status === 'resolved' && lineUserId) {
      await sendLineMessage(lineUserId,
        `✅ ${BRAND} — แก้ไขปัญหาแล้ว!\n\n📧 อีเมล: ${memberEmail}\n\nแอดมินได้แก้ไขปัญหาที่คุณแจ้งเรียบร้อยแล้วครับ\nหากยังมีปัญหาอยู่ กรุณาแจ้งใหม่ได้เลยครับ`
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ลูกค้าดูปัญหาของตัวเอง (หน้า LIFF เรียกใช้)
router.get('/report/user/:lineUserId',
  rateLimit({ windowMs: 60000, max: 60, keyGenerator: (req) => `rpt:${req.params.lineUserId}` }),
  async (req, res) => {
    try {
      const reports = await getReports();
      res.json({ success: true, reports: reports.filter(r => r.lineUserId === req.params.lineUserId) });
    } catch (err) {
      console.error('GET /report/user error:', err.message);
      res.status(500).json({ error: 'ดึงข้อมูลไม่สำเร็จ' });
    }
  }
);

// ลูกค้าแจ้งปัญหา — จำกัด 3 ครั้ง / 10 นาที กันสแปม
const reportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => `report:${req.body?.lineUserId || req.ip}`,
  message: 'แจ้งปัญหาถี่เกินไป กรุณารอสักครู่ หรือทักแชทหาแอดมินโดยตรงครับ',
});

router.post('/report', reportLimiter, async (req, res) => {
  try {
    const { lineUserId, displayName, memberEmail } = req.body;
    const detail = String(req.body.detail || '').slice(0, 1000); // กันข้อความยาวผิดปกติ
    if (!lineUserId || !memberEmail) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });

    const result = await addReport({ lineUserId, displayName, memberEmail, detail });
    if (!result.success) return res.status(500).json({ error: 'บันทึกไม่สำเร็จ กรุณาลองใหม่ครับ' });

    if (process.env.ADMIN_LINE_ID) {
      await sendLineMessage(process.env.ADMIN_LINE_ID,
        `🚨 แจ้งปัญหาใหม่!\n\n👤 ${displayName || lineUserId}\n📧 ${memberEmail}\n📝 ${detail || 'ไม่ระบุรายละเอียด'}\n\nกรุณาตรวจสอบใน Admin Dashboard ครับ`
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('POST /report error:', err.message);
    res.status(500).json({ error: 'ระบบขัดข้อง กรุณาลองใหม่ครับ' });
  }
});

async function sendLineMessage(userId, text) {
  try {
    const { messagingApi } = require('@line/bot-sdk');
    const client = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    });
    await client.pushMessage({ to: userId, messages: [{ type: 'text', text }] });
    return true;
  } catch (err) {
    console.error('sendLineMessage error:', err.message);
    return false;
  }
}

module.exports = router;
