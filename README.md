# 🐯 Tiger Premium — LINE OA System

## โครงสร้างไฟล์
```
tiger-premium/
├── src/
│   ├── index.js        ← Server หลัก
│   ├── webhook.js      ← รับข้อความจาก LINE
│   ├── liff-api.js     ← API สำหรับ LIFF
│   └── sheets.js       ← เชื่อม Google Sheets
├── public/liff/
│   ├── index.html      ← หน้าหลัก (Rich Menu)
│   ├── register.html   ← สมัครสมาชิก
│   ├── renew.html      ← ต่ออายุ
│   └── account.html    ← ดูข้อมูลบ้าน
├── .env                ← ตัวแปรลับ (ห้าม commit!)
├── package.json
└── Procfile            ← สำหรับ Railway
```

## วิธี Deploy บน Railway

1. ไปที่ railway.app → Login ด้วย GitHub
2. กด "New Project" → "Deploy from GitHub repo"
3. เลือก repo `tiger-premium`
4. ไปที่ Variables → ใส่ค่าจากไฟล์ .env ทุกตัว
5. Railway จะ deploy อัตโนมัติ
6. Copy URL ที่ได้ (เช่น https://tiger-premium.railway.app)
7. นำ URL ไปใส่ใน LINE Webhook และ .env BASE_URL

## Environment Variables ที่ต้องใส่ใน Railway
```
LINE_CHANNEL_SECRET=...
LINE_CHANNEL_ACCESS_TOKEN=...
LIFF_ID=...
SHEET_ID=...
BASE_URL=https://your-app.railway.app
GOOGLE_CREDENTIALS=...  (JSON จาก Service Account)
NODE_ENV=production
```
