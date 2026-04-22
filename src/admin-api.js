const { google } = require('googleapis');
const dayjs = require('dayjs');

const SHEET_ID = process.env.SHEET_ID;

async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

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
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Members!A:K',
    });
    const rows = res.data.values || [];
    const row = rows.find(r => r[0] === lineUserId);
    return row ? rowToMember(row) : null;
  } catch (err) {
    console.error('getMemberByLineId error:', err.message);
    return null;
  }
}

async function getMembersByLineId(lineUserId) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Members!A:K',
    });
    const rows = res.data.values || [];
    return rows.filter(r => r[0] === lineUserId).map(rowToMember);
  } catch (err) {
    console.error('getMembersByLineId error:', err.message);
    return [];
  }
}

async function getAllMembers() {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Members!A:K',
    });
    const rows = res.data.values || [];
    return rows.slice(1).map((row, i) => ({ ...rowToMember(row), rowIndex: i + 2 }));
  } catch (err) {
    console.error('getAllMembers error:', err.message);
    return [];
  }
}

async function checkEmailExists(email) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Members!A:K',
    });
    const rows = res.data.values || [];
    return rows.some(r => r[5] && r[5].toLowerCase() === email.toLowerCase());
  } catch (err) {
    console.error('checkEmailExists error:', err.message);
    return false;
  }
}

async function addMember(data) {
  try {
    const sheets = await getSheets();
    const expireDate = calculateExpireDate(data.packageType);
    const now = dayjs().format('YYYY-MM-DD HH:mm:ss');
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Members!A:K',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          data.lineUserId,                              // A: line_user_id
          data.displayName || '',                       // B: display_name
          data.packageType,                             // C: package
          expireDate,                                   // D: expire_date
          'active',                                     // E: status
          data.memberEmail || '',                       // F: member_email
          data.slipUrl ? 'มีสลิป ✓' : '',             // G: slip_url
          now,                                          // H: created_at
          '',                                           // I: house_id
          'pending',                                    // J: invite_status
          now,                                          // K: registered_at (ไม่เปลี่ยนตอน renew)
        ]],
      },
    });
    return { success: true, expireDate };
  } catch (err) {
    console.error('addMember error:', err.message);
    return { success: false, error: err.message };
  }
}

async function renewMember(lineUserId, packageType, slipUrl, memberEmail) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Members!A:K',
    });
    const rows = res.data.values || [];

    let rowIndex = -1;
    if (memberEmail) {
      rowIndex = rows.findIndex(r => r[0] === lineUserId && r[5] && r[5].toLowerCase() === memberEmail.toLowerCase());
    }
    if (rowIndex === -1) {
      rowIndex = rows.findIndex(r => r[0] === lineUserId);
    }
    if (rowIndex === -1) return { success: false, error: 'ไม่พบสมาชิก' };

    const newExpire = calculateExpireDate(packageType, rows[rowIndex][3]);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Members!C${rowIndex + 1}:H${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          packageType,                          // C: package
          newExpire,                            // D: expire_date
          'active',                             // E: status
          memberEmail || rows[rowIndex][5] || '', // F: member_email
          slipUrl ? 'มีสลิป ✓' : '',           // G: slip_url
          dayjs().format('YYYY-MM-DD HH:mm:ss'), // H: created_at (updated)
        ]],
      },
    });
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
    return { success: true };
  } catch (err) {
    console.error('updateInviteStatus error:', err.message);
    return { success: false, error: err.message };
  }
}

async function getMembersExpiringIn(days) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Members!A:K',
    });
    const rows = res.data.values || [];
    const targetDate = dayjs().add(days, 'day').format('YYYY-MM-DD');
    return rows.filter(r => r[3] === targetDate && r[4] === 'active');
  } catch (err) {
    console.error('getMembersExpiringIn error:', err.message);
    return [];
  }
}

async function getHouses() {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Houses!A:H',
    });
    const rows = res.data.values || [];
    return rows.slice(1).map(row => ({
      houseId:        row[0],
      houseEmail:     row[1],
      housePassword:  row[2],
      expireDate:     row[3],
      maxMembers:     parseInt(row[4]) || 5,
      status:         row[5],
      currentMembers: parseInt(row[6]) || 0,
      slotsLeft:      parseInt(row[7]) || 0,
    }));
  } catch (err) {
    console.error('getHouses error:', err.message);
    return [];
  }
}

function calculateExpireDate(packageType, fromDate = null) {
  const base = fromDate && dayjs(fromDate).isAfter(dayjs()) ? dayjs(fromDate) : dayjs();
  const months = packageType === '1month' ? 1 : packageType === '2months' ? 2 : 3;
  return base.add(months, 'month').format('YYYY-MM-DD');
}

// ===== House Management =====
async function addHouse(data) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: 'Houses!A:A',
    });
    const rows = res.data.values || [];
    const nextNum = rows.filter(r => r[0] && r[0].startsWith('house_')).length + 1;
    const houseId = data.houseId || `house_${String(nextNum).padStart(2,'0')}`;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Houses!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[houseId, data.houseEmail, data.housePassword, data.expireDate, data.maxMembers || 5, 'active']] },
    });
    return { success: true, houseId };
  } catch (err) {
    console.error('addHouse error:', err.message);
    return { success: false, error: err.message };
  }
}

async function addHouses(housesArray) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: 'Houses!A:A',
    });
    const rows = res.data.values || [];
    const existingCount = rows.filter(r => r[0] && r[0].startsWith('house_')).length;

    const values = housesArray.map((h, i) => {
      const num = existingCount + i + 1;
      const houseId = `house_${String(num).padStart(2,'0')}`;
      h.houseId = houseId;
      return [houseId, h.houseEmail, h.housePassword, h.expireDate, h.maxMembers || 5, 'active'];
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Houses!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
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
    return { success: true };
  } catch (err) {
    console.error('moveMemberToHouse error:', err.message);
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
    return { success: true };
  } catch (err) {
    console.error('updateMemberExpire error:', err.message);
    return { success: false, error: err.message };
  }
}

async function updateHousePassword(houseId, newPassword) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Houses!A:A',
    });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === houseId);
    if (rowIndex === -1) return { success: false, error: 'ไม่พบบ้าน' };
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Houses!C${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newPassword]] },
    });
    return { success: true };
  } catch (err) {
    console.error('updateHousePassword error:', err.message);
    return { success: false, error: err.message };
  }
}

async function addReport(data) {
  try {
    const sheets = await getSheets();
    const dayjs = require('dayjs');
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Reports!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          dayjs().format('YYYY-MM-DD HH:mm:ss'), // A: timestamp
          data.lineUserId,                         // B: line_user_id
          data.displayName || '',                  // C: display_name
          data.memberEmail || '',                  // D: email ที่มีปัญหา
          data.detail || '',                       // E: รายละเอียด
          'pending',                               // F: status
        ]],
      },
    });
    return { success: true };
  } catch (err) {
    console.error('addReport error:', err.message);
    return { success: false, error: err.message };
  }
}

async function getReports() {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Reports!A:F',
    });
    const rows = res.data.values || [];
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
    return { success: true };
  } catch (err) {
    console.error('updateReportStatus error:', err.message);
    return { success: false, error: err.message };
  }
}
async function getAdmins() {
  const admins = [];

  // parse ADMINS_JSON จาก env: [{"username":"x","password":"y","displayName":"z","role":"owner"}]
  try {
    if (process.env.ADMINS_JSON) {
      const parsed = JSON.parse(process.env.ADMINS_JSON);
      admins.push(...parsed);
    }
  } catch (e) {
    console.error('ADMINS_JSON parse error:', e.message);
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

  return admins;
}

// ===== House Management =====
async function updateHouseStatus(houseId, newStatus) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Houses!A:A',
    });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === houseId);
    if (rowIndex === -1) return { success: false, error: 'ไม่พบบ้าน' };
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Houses!F${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newStatus]] },
    });
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
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Houses!A:A',
    });
    const rows = res.data.values || [];
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
          dayjs().format('YYYY-MM-DD HH:mm:ss'),
          `${adminName} (${adminUser})`,
          action,
          detail,
        ]],
      },
    });
  } catch (err) {
    console.error('writeLog error:', err.message);
  }
}

async function getLogs() {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Logs!A:D',
    });
    const rows = res.data.values || [];
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
  addMember,
  renewMember,
  updateInviteStatus,
  getMembersExpiringIn,
  getHouses,
  addHouse,
  addHouses,
  removeMemberFromHouse,
  moveMemberToHouse,
  updateMemberEmail,
  updateMemberExpire,
  updateHousePassword,
  updateHouseStatus,
  deleteHouse,
  addReport,
  getReports,
  updateReportStatus,
  getAdmins,
  writeLog,
  getLogs,
};
