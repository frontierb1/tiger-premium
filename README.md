# 🐯 Tiger Premium — LINE OA System

ระบบขาย YouTube Premium Family ผ่าน LINE OA
Node.js + Express + Google Sheets + LINE Messaging API + EasySlip

## โครงสร้างไฟล์

```
tiger-premium/
├── src/
│   ├── index.js        ← Server หลัก + ตรวจ ENV + global error handler
│   ├── webhook.js      ← รับข้อความจาก LINE (ต้อง mount ก่อน express.json)
│   ├── liff-api.js     ← API สมัคร/ต่ออายุ + ตรวจสลิป EasySlip
│   ├── admin-api.js    ← Admin API + multi-admin + logs + reports
│   ├── sheets.js       ← เชื่อม Google Sheets (ทุกการอ่าน/เขียน)
│   ├── notify.js       ← ระบบแจ้งเตือนใกล้หมดอายุ
│   ├── time.js         ← จัดการ timezone (Asia/Bangkok) — ใช้แทน dayjs() ตรงๆ
│   ├── cache.js        ← TTL cache ลดการยิง Google Sheets API
│   ├── line-auth.js    ← verify LINE ID token กัน lineUserId ปลอม
│   ├── rate-limit.js   ← จำกัดจำนวนครั้งที่เรียก endpoint
│   └── lock.js         ← กัน race condition ตอนสมัคร/ต่ออายุพร้อมกัน
├── public/
│   ├── admin.html      ← Admin Dashboard
│   └── liff/
│       ├── liff-auth.js  ← apiFetch() แนบ ID token ให้อัตโนมัติ
│       ├── index.html    ← หน้าหลัก (Rich Menu)
│       ├── register.html ← สมัครสมาชิก
│       ├── renew.html    ← ต่ออายุ
│       ├── check.html    ← เช็ควันหมดอายุ
│       ├── account.html  ← ดูข้อมูลบ้าน
│       └── report.html   ← แจ้งปัญหา
├── .env                ← ตัวแปรลับ (ห้าม commit!)
├── .env.example        ← ตัวอย่างตัวแปร
├── package.json
└── Procfile            ← สำหรับ Railway
```

## โครงสร้าง Google Sheet

**Members** — `A` line_user_id · `B` display_name · `C` package · `D` expire_date ·
`E` status · `F` member_email · `G` slip_url · `H` created_at (อัปเดตทุกครั้งที่ต่ออายุ) ·
`I` house_id · `J` invite_status · `K` registered_at (วันสมัครครั้งแรก ไม่เปลี่ยน)

**Houses** — `A` house_id · `B` house_email · `C` house_password · `D` expire_date ·
`E` max_members · `F` status · `G` current_members (สูตร) · `H` slots_left (สูตร)

**Reports** — `A` timestamp · `B` line_user_id · `C` display_name · `D` member_email ·
`E` detail · `F` status

**Logs** — `A` timestamp · `B` admin · `C` action · `D` detail

> หมายเหตุ: Sheet ชื่อ `Admins` ไม่ใช้แล้ว — ข้อมูล admin ย้ายไปอยู่ใน ENV
> ควรลบ sheet นั้นทิ้งเพื่อไม่ให้รหัสผ่านค้างอยู่

## Environment Variables

ดูรายการเต็มพร้อมคำอธิบายใน [`.env.example`](.env.example)

**ตัวที่ระบบจะไม่ทำงานถ้าไม่ตั้ง:**
`SHEET_ID` · `GOOGLE_CREDENTIALS` · `LINE_CHANNEL_ACCESS_TOKEN` · `LINE_CHANNEL_SECRET` ·
`EASYSLIP_API_KEY` · `NOTIFY_KEY` · (`ADMINS_JSON` หรือ `OWNER_USER`+`OWNER_PASS`)

**ตัวที่ต้องเพิ่มใหม่:**

| ตัวแปร | ทำไมต้องมี |
|---|---|
| `LINE_LOGIN_CHANNEL_ID` | ใช้ verify ID token ของผู้ใช้ LIFF — **ถ้าไม่ตั้ง ระบบจะเชื่อ lineUserId ที่ client ส่งมา ซึ่งปลอมได้** |
| `APP_TZ` | เขตเวลาคำนวณวันหมดอายุ (default `Asia/Bangkok`) |
| `CACHE_TTL_MS` | อายุ cache ข้อมูล Sheet เป็น ms (default `15000`, ใส่ `0` เพื่อปิด) |

### หา `LINE_LOGIN_CHANNEL_ID` ยังไง

1. เข้า [LINE Developers Console](https://developers.line.biz/console/)
2. เลือก Provider → เลือก channel ชนิด **LINE Login** (ไม่ใช่ Messaging API)
   — เป็น channel เดียวกับที่สร้าง LIFF app ไว้
3. แท็บ **Basic settings** → คัดลอก **Channel ID** (ตัวเลขล้วน เช่น `2009843737`)
4. ใส่ใน Railway → Variables → `LINE_LOGIN_CHANNEL_ID`

## Deploy บน Railway

1. push โค้ดขึ้น GitHub
2. Railway → New Project → Deploy from GitHub repo
3. Variables → ใส่ค่าตาม `.env.example`
4. Railway deploy อัตโนมัติ — ดู log ว่ามีคำเตือน `⚠️` เรื่อง ENV ตัวไหนขาดไหม
5. เช็คว่าขึ้นแล้วด้วย `GET /healthz` และ `GET /` (จะบอก timezone ที่ใช้อยู่)

## ตั้ง cron แจ้งเตือน

เรียก `GET https://<your-app>/run-notify?key=<NOTIFY_KEY>` วันละครั้ง
แนะนำเวลา **09:00 น. ไทย** (= `02:00` UTC ถ้า cron service ใช้ UTC)

## ความปลอดภัย

- ทุก endpoint ที่เข้าถึงข้อมูลส่วนตัวของสมาชิกต้องแนบ header `X-Line-Id-Token`
  (หน้า LIFF ทำให้อัตโนมัติผ่าน `apiFetch()` ใน `liff-auth.js`)
- Admin API ใช้ header `X-Admin-User` / `X-Admin-Pass` เทียบแบบ constant-time
  และจำกัดการ login ที่ 10 ครั้ง / 15 นาที / IP
- `POST /api/admin/report` จำกัด 3 ครั้ง / 10 นาที / ผู้ใช้
- `POST /api/register` และ `/api/renew` จำกัด 5 ครั้ง / นาที / ผู้ใช้ และไฟล์สลิปไม่เกิน 8MB
- `POST /api/admin/house/delete` เฉพาะ `role: owner` เท่านั้น
