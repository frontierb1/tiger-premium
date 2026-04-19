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
    lineUserId:   row[0],
    displayName:  row[1],
    package:      row[2],
    expireDate:   row[3],
    status:       row[4],
    houseEmail:   row[5],
    housePassword:row[6],
    slipUrl:      row[7],
    createdAt:    row[8],
  };
}

// ดึงแถวแรกที่เจอ
async function getMemberByLineId(lineUserId) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Members!A:I',
    });
    const rows = res.data.values || [];
    const row = rows.find(r => r[0] === lineUserId);
    return row ? rowToMember(row) : null;
  } catch (err) {
    console.error('getMemberByLineId error:', err.message);
    return null;
  }
}

// ดึงทุกแถวที่มี LINE ID นี้ (รองรับหลายเมล)
async function getMembersByLineId(lineUserId) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Members!A:I',
    });
    const rows = res.data.values || [];
    return rows.filter(r => r[0] === lineUserId).map(rowToMember);
  } catch (err) {
    console.error('getMembersByLineId error:', err.message);
    return [];
  }
}

async function addMember(data) {
  try {
    const sheets = await getSheets();
    const expireDate = calculateExpireDate(data.packageType);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Members!A:I',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          data.lineUserId,
          data.displayName || '',
          data.packageType,
          expireDate,
          'active',
          data.memberEmail || '',
          '',
          data.slipUrl ? 'มีสลิป ✓' : '',
          dayjs().format('YYYY-MM-DD HH:mm:ss'),
        ]],
      },
    });
    return { success: true, expireDate };
  } catch (err) {
    console.error('addMember error:', err.message);
    return { success: false, error: err.message };
  }
}

async function renewMember(lineUserId, packageType, slipUrl) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Members!A:I',
    });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === lineUserId);
    if (rowIndex === -1) return { success: false, error: 'ไม่พบสมาชิก' };
    const newExpire = calculateExpireDate(packageType, rows[rowIndex][3]);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Members!C${rowIndex + 1}:H${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[packageType, newExpire, 'active', '', slipUrl ? 'มีสลิป ✓' : '', '']] },
    });
    return { success: true, expireDate: newExpire };
  } catch (err) {
    console.error('renewMember error:', err.message);
    return { success: false, error: err.message };
  }
}

async function getMembersExpiringIn(days) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Members!A:I',
    });
    const rows = res.data.values || [];
    const targetDate = dayjs().add(days, 'day').format('YYYY-MM-DD');
    return rows.filter(r => r[3] === targetDate && r[4] === 'active');
  } catch (err) {
    console.error('getMembersExpiringIn error:', err.message);
    return [];
  }
}

function calculateExpireDate(packageType, fromDate = null) {
  const base = fromDate && dayjs(fromDate).isAfter(dayjs()) ? dayjs(fromDate) : dayjs();
  const months = packageType === '1month' ? 1 : packageType === '2months' ? 2 : 3;
  return base.add(months, 'month').format('YYYY-MM-DD');
}

module.exports = { getMemberByLineId, getMembersByLineId, addMember, renewMember, getMembersExpiringIn };
