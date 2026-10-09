# Oxide Monitor – Candidate Pack

ชุดไฟล์นี้ใช้สำหรับพัฒนา Backend และ Dashboard บนเครื่อง Local

## สิ่งที่ต้องทำ

- สร้าง Backend API สำหรับอ่านสถานะบอทและส่งคำสั่ง
- สร้าง Dashboard สำหรับดูสถานะและสั่งงานบอท
- บันทึกคำสั่งและเหตุการณ์ลง PostgreSQL
- เชื่อมต่อ Bot Simulator ที่ให้มา

## เริ่มต้นใช้งาน

```bash
docker compose up -d postgres
psql postgresql://oxide:oxide_dev@localhost:55432/oxide_monitor -f db/schema.sql
psql postgresql://oxide:oxide_dev@localhost:55432/oxide_monitor -f db/seed.sql
node simulator/server.js
```

Bot Simulator จะทำงานที่ `http://localhost:8788`

ตัวอย่างคำสั่ง:

```bash
curl http://localhost:8788/bots
curl -X POST http://localhost:8788/bots/bot-01/commands -H "content-type: application/json" -d '{"command":"restart"}'
```

## ข้อจำกัด

- ใช้เฉพาะข้อมูลและบริการในชุดนี้ ห้ามเชื่อมต่อ Production
- ไม่ต้องทำ migration เพิ่มนอกเหนือจากไฟล์ที่ให้
- ไม่ต้องใช้ Source Code ของ Oxide Bot จริง
- ห้ามฝังรหัสผ่านหรือ Token จริงใน Source Code

## สิ่งที่ต้องส่งกลับ

ส่ง Source Code พร้อม `README.md`, `.env.example` และคำสั่งสำหรับติดตั้ง/รัน/ทดสอบ
