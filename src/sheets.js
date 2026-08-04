const { google } = require('googleapis');
const { stamp, addDays, parseDate, now } = require('./time');
const { cached, invalidate } = require('./cache');

const SHEET_ID = process.env.SHEET_ID;

// สร้าง client ครั้งเดียวแล้วใช้ซ้ำ — เดิมสร้าง GoogleAuth ใหม่ทุก request
let sheetsClient = null;
async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

/** อ่านช่วงข้อมูลจาก Sheet ผ่าน cache (invalidate อัตโนมัติเมื่อมีการเขียน) */
async function readRange(range, cacheKey) {
  return cached(cacheKey, async () => {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
    });
    return res.data.values || [];
  });
}

const MEMBERS_RANGE = 'Members!A:K';
const readMembers = () => readRange(MEMBERS_RANGE, 'members:all');
// อ่านถึงคอลัมน์ I เพื่อเอา "หมายเหตุ" ที่แอดมินโน้ตไว้
const readHouses = () => readRange('Houses!A:I', 'houses:all');
const readReports = () => readRange('Reports!A:F', 'reports:all');

function rowToMember(row) {
  return {
    lineUserId:    row[0],
    displayName:   row[1],
    package:       row[2],
    expireDate:    row[3],
    status:        row[4],
    houseEmail:    row[5],
    slipUrl:       row[6],
    createdAt:     row[7],
    houseId:       row[8],
    inviteStatus:  row[9],
    registeredAt:  row[10] || row[7], // K: registered_at (fallback to createdAt)
  };
}

async function getMemberByLineId(lineUserId) {
  try {
    const rows = await readMembers();
    const row = rows.slice(1).find(r => r[0] === lineUserId);
    return row ? rowToMember(row) : null;
  } catch (err) {
    console.error('getMemberByLineId error:', err.message);
    return null;
  }
}

async function getMembersByLineId(lineUserId) {
  try {
    const rows = await readMembers();
    return rows.slice(1).filter(r => r[0] === lineUserId).map(rowToMember);
  } catch (err) {
    console.error('getMembersByLineId error:', err.message);
    return [];
  }
}

async function getAllMembers() {
  try {
    const rows = await readMembers();
    return rows.slice(1).map((row, i) => ({ ...rowToMember(row), rowIndex: i + 2 }));
  } catch (err) {
    console.error('getAllMembers error:', err.message);
    return [];
  }
}

/**
 * เช็คว่าอีเมลนี้มีในระบบแล้วหรือยัง
 * @param {boolean} fresh ข้าม cache (ใช้ตอนสมัครจริง เพื่อไม่ให้เห็นข้อมูลค้าง)
 */
async function checkEmailExists(email, fresh = false) {
  // ไม่ try/catch ที่นี่ — ปล่อยให้ error ลอยขึ้นไป ผู้เรียกจะได้ไม่เข้าใจผิดว่า
  // "อ่านไม่ได้" = "ไม่มีอีเมลนี้" แล้วปล่อยให้สมัครซ้ำ
  if (fresh) invalidate('members');
  const rows = await readMembers();
  const target = String(email || '').trim().toLowerCase();
  if (!target) return false;
  return rows.slice(1).some(r => r[5] && String(r[5]).trim().toLowerCase() === target);
}

/**
 * เช็คว่าเลขอ้างอิงสลิปนี้เคยถูกใช้ไปแล้วหรือยัง
 * เราเก็บ transRef ไว้ในคอลัมน์ G ทุกครั้งที่สมัคร/ต่ออายุ
 * ทำให้กันสลิปซ้ำได้เองโดยไม่ต้องพึ่งฟีเจอร์ของผู้ให้บริการตรวจสลิป
 */
async function isSlipUsed(transRef) {
  const ref = String(transRef || '').trim();
  if (!ref || ref === '-') return false; // ไม่มีเลขอ้างอิง → ข้ามการเช็ค
  invalidate('members');
  const rows = await readMembers();
  return rows.slice(1).some(r => r[6] && String(r[6]).includes(ref));
}

async function addMember(data) {
  try {
    const sheets = await getSheets();
    const expireDate = calculateExpireDate(data.packageType);
    const now = stamp();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: MEMBERS_RANGE,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          data.lineUserId,                              // A: line_user_id
          data.displayName || '',                       // B: display_name
          data.packageType,                             // C: package
          expireDate,                                   // D: expire_date
          'active',                                     // E: status
          data.memberEmail || '',                       // F: member_email
          data.slipUrl || '',                           // G: slip_url (เก็บ transRef ไว้ตรวจสอบย้อนหลัง)
          now,                                          // H: created_at
          '',                                           // I: house_id
          'pending',                                    // J: invite_status
          now,                                          // K: registered_at (ไม่เปลี่ยนตอน renew)
        ]],
      },
    });
    invalidate('members');
    return { success: true, expireDate };
  } catch (err) {
    console.error('addMember error:', err.message);
    return { success: false, error: err.message };
  }
}

async function renewMember(lineUserId, packageType, slipUrl, memberEmail) {
  try {
    const sheets = await getSheets();
    invalidate('members'); // ต่ออายุต้องอ่านค่าล่าสุดเสมอ
    const rows = await readMembers();

    let rowIndex = -1;
    if (memberEmail) {
      const target = String(memberEmail).trim().toLowerCase();
      rowIndex = rows.findIndex(r => r[0] === lineUserId && r[5] && String(r[5]).trim().toLowerCase() === target);
    }
    if (rowIndex === -1) {
      rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === lineUserId);
    }
    if (rowIndex === -1) return { success: false, error: 'ไม่พบสมาชิก' };

    const newExpire = calculateExpireDate(packageType, rows[rowIndex][3]);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      // เขียนแค่ C:G — ไม่แตะ H (created_at) เพราะเป็นวันสมัคร/ต่ออายุครั้งล่าสุดที่ใช้อ้างอิง
      range: `Members!C${rowIndex + 1}:G${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          packageType,                          // C: package
          newExpire,                            // D: expire_date
          'active',                             // E: status
          memberEmail || rows[rowIndex][5] || '', // F: member_email
          slipUrl || '',                        // G: slip_url (เก็บ transRef ไว้ตรวจสอบย้อนหลัง)
        ]],
      },
    });

    // บันทึกเวลาต่ออายุล่าสุดไว้ที่ H (created_at) — K (registered_at) คงเดิม ไม่ถูกแตะ
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Members!H${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[stamp()]] },
    });

    invalidate('members');
    return { success: true, expireDate: newExpire };
  } catch (err) {
    console.error('renewMember error:', err.message);
    return { success: false, error: err.message };
  }
}

async function updateInviteStatus(rowIndex, houseId, status) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Members!I${rowIndex}:J${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[houseId, status]] },
    });
    invalidate('members');
    return { success: true };
  } catch (err) {
    console.error('updateInviteStatus error:', err.message);
    return { success: false, error: err.message };
  }
}

async function getMembersExpiringIn(days) {
  try {
    const rows = await readMembers();
    const targetDate = addDays(days); // อิงวันที่ไทย ไม่ใช่ UTC
    return rows.slice(1).filter(r => r[3] && String(r[3]).trim().slice(0, 10) === targetDate && r[4] === 'active');
  } catch (err) {
    console.error('getMembersExpiringIn error:', err.message);
    return [];
  }
}

async function getHouses() {
  try {
    const [rows, memberRows] = await Promise.all([readHouses(), readMembers()]);

    // นับสมาชิกจริงในแต่ละบ้านเอง ไม่พึ่งคอลัมน์ G/H ของชีต
    // เพราะ 2 คอลัมน์นั้นเป็นสูตรที่ไม่ขยายลงมาให้แถวใหม่ที่ระบบ append เข้าไป
    // → บ้านที่เพิ่งสร้างจะอ่านได้ 0 แล้วขึ้นว่า "เต็ม" ทั้งที่ยังไม่มีใครอยู่
    const usedByHouse = new Map();
    for (const r of memberRows.slice(1)) {
      const houseId = String(r[8] || '').trim();
      const inviteStatus = String(r[9] || '').trim();
      if (!houseId || inviteStatus === 'removed') continue;
      usedByHouse.set(houseId, (usedByHouse.get(houseId) || 0) + 1);
    }

    return rows.slice(1).map(row => {
      const houseId = row[0];
      const maxMembers = parseInt(row[4]) || 5;
      const currentMembers = usedByHouse.get(String(houseId || '').trim()) || 0;
      return {
        houseId,
        houseEmail:     row[1],
        housePassword:  row[2],
        expireDate:     row[3],
        maxMembers,
        status:         row[5],
        currentMembers,
        slotsLeft:      Math.max(0, maxMembers - currentMembers),
        note:           row[8] || '',   // I: หมายเหตุ (ไม่บังคับกรอก)
      };
    });
  } catch (err) {
    console.error('getHouses error:', err.message);
    return [];
  }
}

function calculateExpireDate(packageType, fromDate = null) {
  // อิงวันที่ไทย: ถ้ายังไม่หมดอายุ ให้ต่อจากวันหมดอายุเดิม ไม่งั้นเริ่มนับจากวันนี้
  const todayTh = now().startOf('day');
  const from = parseDate(fromDate);
  const base = from && from.isAfter(todayTh) ? from : todayTh;
  const months = packageType === '1month' ? 1 : packageType === '2months' ? 2 : 3;
  return base.add(months, 'month').format('YYYY-MM-DD');
}

// ===== House Management =====

/**
 * หาเลข house ที่สูงสุดที่เคยใช้ แล้ว +1
 * เดิมใช้ "จำนวนแถว + 1" ซึ่งทำให้ id ซ้ำถ้าเคยลบบ้านไป
 */
function nextHouseNumber(rows) {
  let max = 0;
  for (const r of rows) {
    const m = /^house_(\d+)$/.exec(String(r[0] || '').trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

async function readHouseIds() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: 'Houses!A:A',
  });
  return res.data.values || [];
}

async function addHouse(data) {
  try {
    const sheets = await getSheets();
    const rows = await readHouseIds();
    const existingIds = new Set(rows.map(r => String(r[0] || '').trim()));

    let houseId = data.houseId && String(data.houseId).trim();
    if (houseId) {
      if (existingIds.has(houseId)) {
        return { success: false, error: `${houseId} มีอยู่แล้ว กรุณาใช้ชื่ออื่น` };
      }
    } else {
      houseId = `house_${String(nextHouseNumber(rows)).padStart(2, '0')}`;
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Houses!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[houseId, data.houseEmail, data.housePassword, data.expireDate, data.maxMembers || 5, 'active']] },
    });
    invalidate('houses');
    return { success: true, houseId };
  } catch (err) {
    console.error('addHouse error:', err.message);
    return { success: false, error: err.message };
  }
}

async function addHouses(housesArray) {
  try {
    const sheets = await getSheets();
    const rows = await readHouseIds();
    let num = nextHouseNumber(rows);

    const values = housesArray.map((h) => {
      const houseId = `house_${String(num).padStart(2, '0')}`;
      num += 1;
      h.houseId = houseId;
      return [houseId, h.houseEmail, h.housePassword, h.expireDate, h.maxMembers || 5, 'active'];
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Houses!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
    invalidate('houses');
    return { success: true, houses: housesArray };
  } catch (err) {
    console.error('addHouses error:', err.message);
    return { success: false, error: err.message };
  }
}

async function removeMemberFromHouse(rowIndex) {
  try {
    const sheets = await getSheets();
    // house_id (I) = '' และ invite_status (J) = 'removed'
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Members!I${rowIndex}:J${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['', 'removed']] },
    });
    invalidate('members');
    return { success: true };
  } catch (err) {
    console.error('removeMemberFromHouse error:', err.message);
    return { success: false, error: err.message };
  }
}

async function moveMemberToHouse(rowIndex, houseId) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Members!I${rowIndex}:J${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[houseId, 'inviting']] },
    });
    invalidate('members');
    return { success: true };
  } catch (err) {
    console.error('moveMemberToHouse error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * ย้ายสมาชิกหลายคนไปบ้านใหม่พร้อมกัน (ใช้ตอนบ้านเดิมพัง ต้องย้ายยกบ้าน)
 * ตั้งสถานะเป็น 'moving' = ย้ายแล้ว รอลูกค้าออกจากกลุ่มเก่า + กดรับคำเชิญใหม่
 * แยกจาก 'inviting' เพื่อให้รู้ว่าคนนี้ต้องออกจากกลุ่มเดิมก่อน ไม่ใช่แค่กดรับ
 *
 * @param {number[]} rowIndexes แถวในชีต (เลขแถวจริง เริ่มที่ 2)
 * @param {string} toHouseId บ้านปลายทาง
 */
async function moveMembersToHouse(rowIndexes, toHouseId) {
  try {
    const rows = (rowIndexes || []).map(Number).filter(n => Number.isInteger(n) && n >= 2);
    if (!rows.length) return { success: false, error: 'ไม่ได้เลือกสมาชิก' };

    const sheets = await getSheets();
    // เขียนทีเดียวหลายช่วง เร็วกว่ายิงทีละแถว และลดโอกาสเขียนค้างกลางทาง
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: rows.map(r => ({
          range: `Members!I${r}:J${r}`,
          values: [[toHouseId, 'moving']],
        })),
      },
    });

    invalidate('members');
    invalidate('houses'); // จำนวนที่ว่างของบ้านเปลี่ยน
    return { success: true, moved: rows.length };
  } catch (err) {
    console.error('moveMembersToHouse error:', err.message);
    return { success: false, error: err.message };
  }
}

async function updateMemberEmail(rowIndex, newEmail) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Members!F${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newEmail]] },
    });
    invalidate('members');
    return { success: true };
  } catch (err) {
    console.error('updateMemberEmail error:', err.message);
    return { success: false, error: err.message };
  }
}

async function updateMemberExpire(rowIndex, newExpire) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Members!D${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newExpire]] },
    });
    invalidate('members');
    return { success: true };
  } catch (err) {
    console.error('updateMemberExpire error:', err.message);
    return { success: false, error: err.message };
  }
}

async function updateHousePassword(houseId, newPassword) {
  try {
    const sheets = await getSheets();
    const rows = await readHouseIds();
    const rowIndex = rows.findIndex(r => r[0] === houseId);
    if (rowIndex === -1) return { success: false, error: 'ไม่พบบ้าน' };
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Houses!C${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newPassword]] },
    });
    invalidate('houses');
    return { success: true };
  } catch (err) {
    console.error('updateHousePassword error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * บันทึกหมายเหตุของบ้าน (คอลัมน์ I ในชีต Houses)
 * ปล่อยว่างได้ ไม่มีค่าเริ่มต้น — ส่งค่าว่างมาก็คือลบหมายเหตุทิ้ง
 */
async function updateHouseNote(houseId, note) {
  try {
    const sheets = await getSheets();
    const rows = await readHouseIds();
    const rowIndex = rows.findIndex(r => r[0] === houseId);
    if (rowIndex === -1) return { success: false, error: 'ไม่พบบ้าน' };
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Houses!I${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[String(note ?? '').slice(0, 500)]] },
    });
    invalidate('houses');
    return { success: true };
  } catch (err) {
    console.error('updateHouseNote error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * บันทึกคำขอต่ออายุของลูกค้าเก่า (ย้ายจากระบบเดิม ไม่คิดเงิน)
 * เขียนลงแท็บ RenewRequests — แยกจาก Members ไม่กระทบข้อมูลจริง
 * แอดมินอ่านแล้วเอาไปกรอกใน Members เอง
 *
 * ★ ต้องสร้างแท็บชื่อ RenewRequests ในชีตก่อน (สะกดตรงตัวพิมพ์ใหญ่-เล็ก)
 */
async function addRenewRequest(data) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'RenewRequests!A:E',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          stamp(),                        // A: วันเวลา (เวลาไทย YYYY-MM-DD HH:mm:ss)
          data.lineUserId || '',          // B: LINE User ID — เอาไปใส่ Members คอลัมน์ A
          data.displayName || '',         // C: ชื่อใน LINE
          data.memberEmail || '',         // D: อีเมลที่ลูกค้ากรอก
          'pending',                      // E: สถานะ — แอดมินเปลี่ยนเป็น done เองเมื่อกรอกเสร็จ
        ]],
      },
    });
    invalidate('renewRequests');
    return { success: true };
  } catch (err) {
    console.error('addRenewRequest error:', err.message);
    return { success: false, error: err.message };
  }
}

async function addReport(data) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Reports!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          stamp(),                                 // A: timestamp (เวลาไทย)
          data.lineUserId,                         // B: line_user_id
          data.displayName || '',                  // C: display_name
          data.memberEmail || '',                  // D: email ที่มีปัญหา
          data.detail || '',                       // E: รายละเอียด
          'pending',                               // F: status
        ]],
      },
    });
    invalidate('reports');
    return { success: true };
  } catch (err) {
    console.error('addReport error:', err.message);
    return { success: false, error: err.message };
  }
}

async function getReports() {
  try {
    const rows = await readReports();
    return rows.slice(1).reverse().map((row, i) => ({
      timestamp:   row[0],
      lineUserId:  row[1],
      displayName: row[2],
      memberEmail: row[3],
      detail:      row[4],
      status:      row[5] || 'pending',
      rowIndex:    rows.length - i - 1 + 1,
    }));
  } catch (err) {
    console.error('getReports error:', err.message);
    return [];
  }
}

async function updateReportStatus(rowIndex, status) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Reports!F${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[status]] },
    });
    invalidate('reports');
    return { success: true };
  } catch (err) {
    console.error('updateReportStatus error:', err.message);
    return { success: false, error: err.message };
  }
}

// ===== Admins =====
async function getAdmins() {
  const admins = [];

  // parse ADMINS_JSON จาก env:
  // [{"username":"x","password":"y","displayName":"z","role":"owner"}]
  try {
    if (process.env.ADMINS_JSON) {
      const parsed = JSON.parse(process.env.ADMINS_JSON);
      if (!Array.isArray(parsed)) throw new Error('ADMINS_JSON ต้องเป็น array');
      // ⚠️ สำคัญ: authCheck เช็ค status === 'active'
      // ถ้า JSON ไม่ได้ใส่ status มา จะ login ไม่ได้เลย → ใส่ default ให้ตรงนี้
      admins.push(...parsed.map(a => ({
        username:    String(a.username || '').trim(),
        password:    String(a.password || ''),
        displayName: a.displayName || a.username || 'Admin',
        status:      a.status || 'active',
        role:        a.role || 'admin',
      })).filter(a => a.username && a.password));
    }
  } catch (e) {
    console.error('❌ ADMINS_JSON parse error:', e.message, '— จะใช้ค่าจาก OWNER_USER/ADMIN_USER แทน');
  }

  // fallback: OWNER_USER / OWNER_PASS / ADMIN_USER / ADMIN_PASS
  if (admins.length === 0) {
    if (process.env.OWNER_USER && process.env.OWNER_PASS) {
      admins.push({
        username: process.env.OWNER_USER,
        password: process.env.OWNER_PASS,
        displayName: process.env.OWNER_NAME || 'Owner',
        status: 'active',
        role: 'owner',
      });
    }
    if (process.env.ADMIN_USER && process.env.ADMIN_PASS) {
      admins.push({
        username: process.env.ADMIN_USER,
        password: process.env.ADMIN_PASS,
        displayName: process.env.ADMIN_NAME || 'Admin',
        status: 'active',
        role: 'admin',
      });
    }
  }

  if (admins.length === 0) {
    console.error('❌ ไม่พบข้อมูล admin เลย — ตั้ง ADMINS_JSON หรือ OWNER_USER/OWNER_PASS ใน ENV');
  }

  return admins;
}

/** เทียบ string แบบ constant-time กัน timing attack ตอน login */
function safeEqual(a, b) {
  const crypto = require('crypto');
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** หา admin ที่ตรงกับ username/password — คืน null ถ้าไม่ผ่าน */
async function findAdmin(username, password) {
  const admins = await getAdmins();
  return admins.find(a =>
    a.username === username &&
    safeEqual(a.password, password) &&
    a.status === 'active'
  ) || null;
}

// ===== House Management =====
async function updateHouseStatus(houseId, newStatus) {
  try {
    const sheets = await getSheets();
    const rows = await readHouseIds();
    const rowIndex = rows.findIndex(r => r[0] === houseId);
    if (rowIndex === -1) return { success: false, error: 'ไม่พบบ้าน' };
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Houses!F${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newStatus]] },
    });
    invalidate('houses');
    return { success: true };
  } catch (err) {
    console.error('updateHouseStatus error:', err.message);
    return { success: false, error: err.message };
  }
}

async function deleteHouse(houseId) {
  try {
    const sheets = await getSheets();
    // ดึง spreadsheet metadata เพื่อหา sheetId
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const sheet = meta.data.sheets.find(s => s.properties.title === 'Houses');
    if (!sheet) return { success: false, error: 'ไม่พบ sheet Houses' };
    const sheetId = sheet.properties.sheetId;

    // หา row index
    const rows = await readHouseIds();
    const rowIndex = rows.findIndex(r => r[0] === houseId);
    if (rowIndex === -1) return { success: false, error: 'ไม่พบบ้าน' };

    // ลบแถวนั้น
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        }],
      },
    });
    invalidate('houses');
    return { success: true };
  } catch (err) {
    console.error('deleteHouse error:', err.message);
    return { success: false, error: err.message };
  }
}

// ===== Logs =====
async function writeLog(adminUser, adminName, action, detail) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Logs!A:D',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          stamp(),
          `${adminName} (${adminUser})`,
          action,
          detail,
        ]],
      },
    });
    invalidate('logs');
  } catch (err) {
    console.error('writeLog error:', err.message);
  }
}

async function getLogs() {
  try {
    const rows = await readRange('Logs!A:D', 'logs:all');
    return rows.slice(1).reverse().map(row => ({
      timestamp:  row[0],
      admin:      row[1],
      action:     row[2],
      detail:     row[3],
    }));
  } catch (err) {
    console.error('getLogs error:', err.message);
    return [];
  }
}

module.exports = {
  getMemberByLineId,
  getMembersByLineId,
  getAllMembers,
  checkEmailExists,
  isSlipUsed,
  addMember,
  renewMember,
  updateInviteStatus,
  getMembersExpiringIn,
  getHouses,
  addHouse,
  addHouses,
  removeMemberFromHouse,
  moveMemberToHouse,
  moveMembersToHouse,
  updateMemberEmail,
  updateMemberExpire,
  updateHousePassword,
  updateHouseNote,
  updateHouseStatus,
  deleteHouse,
  addRenewRequest,
  addReport,
  getReports,
  updateReportStatus,
  getAdmins,
  findAdmin,
  writeLog,
  getLogs,
  calculateExpireDate,
  invalidate,
};
