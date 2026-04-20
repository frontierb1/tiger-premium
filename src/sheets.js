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
   houseEmail: row[5],  // F: member_email
    slipUrl:       row[6],
    createdAt:     row[7],
 houseId:      row[8],  // I: house_id
inviteStatus: row[9],  // J: invite_status
  };
}

async function getMemberByLineId(lineUserId) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Members!A:J',
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
      range: 'Members!A:J',
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
      range: 'Members!A:J',
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
      range: 'Members!A:J',
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
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Members!A:J',
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
          dayjs().format('YYYY-MM-DD HH:mm:ss'),       // H: created_at
          'pending', // I: invite_status
                    '',        // J: house_id         
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
      range: 'Members!A:J',
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
      range: 'Members!A:J',
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
      range: 'Houses!A:F',
    });
    const rows = res.data.values || [];
    return rows.slice(1).map(row => ({
      houseId:      row[0],
      houseEmail:   row[1],
      housePassword:row[2],
      expireDate:   row[3],
      maxMembers:   parseInt(row[4]) || 5,
      status:       row[5],
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
};
