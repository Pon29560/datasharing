# Signal Lab — ระบบวิเคราะห์หุ้น/สินทรัพย์ที่ “พิสูจน์ได้”

เว็บแอป (PWA) เปิดได้ทั้ง **iPhone, iPad, macOS และทุกเบราว์เซอร์** — พิมพ์สัญลักษณ์แล้วได้ทันที:

| แท็บ | ได้อะไร |
|---|---|
| **สรุป & แผนเทรด** | คะแนนระยะสั้น (Daily) / กลาง (Weekly) / ยาว (Monthly) พร้อม “ส่วนประกอบของคะแนน” ทุกบรรทัด, ความสอดคล้องหลาย Timeframe (Triple Screen), แผนเทรด: จุดเข้า, Stop ตามโครงสร้าง, เป้าหมาย, R:R, ขนาดสถานะ และ **เงื่อนไขที่จะซื้อ/ขาย** ที่ชัดเจน |
| **กราฟ** | แท่งเทียน 1H/4H/1D/1W/1M + แท่งสี CDC ActionZone, EMA 12/26, สัญญาณ Buy/Sell, เส้น RSI Divergence (ทั้งบนราคาและ RSI), Elliott Wave + เป้า Fibonacci + Invalidation, ZigZag, EMA50/200, **EMA Weekly ซ้อนบน Daily**, **ซ้อนกราฟสินทรัพย์อื่น** (เช่น ^GSPC, ^SET.BK) บนแกนเดียว, Log scale, ซูม/เลื่อน/Pinch/คีย์บอร์ด |
| **Elliott Wave** | นับคลื่นอัตโนมัติทุก Timeframe พร้อมตรวจกฎเหล็ก 4 ข้อ, คะแนน Fibonacci/Guideline, Count สำรอง, เป้าหมาย และจุดยกเลิก |
| **ข่าว & ปัจจัย** | ข่าวล่าสุด (Google News + Yahoo Finance, มีลิงก์ต้นฉบับ) ให้คะแนน Sentiment แบบโปร่งใส (แสดงคำที่ใช้ให้คะแนน) จัดกลุ่ม Factor และแยกผลต่อระยะสั้น/กลาง/ยาว |
| **จิตวิทยาตลาด** | Fear & Greed ของสินทรัพย์นั้น, ช่วงอารมณ์ตลาด, **อัตรา Bull/Bear trap ในอดีต** (ทำไมกราฟชอบหลอก), Volume climax, ข่าว vs ราคา (Distribution/Accumulation) |
| **Backtest & พิสูจน์** | Backtest ที่ไม่แอบดูอนาคต + In/Out-of-sample + Walk-forward + Permutation test + Probabilistic/Deflated Sharpe + Bootstrap + Monte Carlo + Heatmap ความทนทานของพารามิเตอร์ + Edge study |
| **สแกน** | วิเคราะห์ Watchlist หลายตัวพร้อมกัน |
| **หลักการ** | นิยามและสูตรของทุก Indicator, วิธีคิดของระบบ, ข้อจำกัด |

สัญลักษณ์ตามรูปแบบ Yahoo Finance: `AAPL`, `NVDA` (สหรัฐ), `PTT.BK`, `ADVANC.BK` (ไทย), `^SET.BK` (ดัชนี SET), `BTC-USD` (คริปโต), `GC=F` (ทองคำ), `EURUSD=X` (FX) — หรือ `DEMO` (ข้อมูลจำลอง) หรือ **นำเข้าไฟล์ CSV** ของคุณเอง (Date, Open, High, Low, Close, Volume)

## เรื่องที่ต้องพูดตรงๆ: “กำไรแน่นอน” พิสูจน์ไม่ได้

ไม่มีระบบใดในโลกพิสูจน์ได้ว่าจะกำไรแน่นอนในอนาคต ใครอ้างแบบนั้นคือสัญญาณอันตราย สิ่งที่ระบบนี้ **พิสูจน์ได้จริง** คือ:

1. กฎการเข้า-ออกมี Edge ทางสถิติในอดีตของสินทรัพย์นั้นหรือไม่ (เทียบกับการสุ่มและ Buy & Hold)
2. Edge นั้นรอดในข้อมูลที่ไม่เคยเห็น (Out-of-sample, Walk-forward) หรือเป็นแค่ Overfitting
3. ถ้าใช้จริงจะเจอ Drawdown และการแพ้ติดกันแย่สุดแค่ไหน

**ระบบพิสูจน์ตัวเองว่าไม่โกหก:** เราทดสอบด้วยข้อมูล Random walk 120 ชุด (ซึ่งไม่มีทางมี Edge จริง) — Backtest แบบธรรมดา “ได้กำไร” ถึง 50 ชุด (42%) แต่ชั้นพิสูจน์ของระบบให้เกรด “หลักฐานแข็งแรง” เพียง **1 ชุด (0.8%)** นี่คือเหตุผลที่ต้องดู Evidence scorecard ไม่ใช่ดูแค่กำไรใน Backtest (ทดสอบอัตโนมัติใน `test/false-positive.test.js`)

## เริ่มใช้งาน

ต้องการ Node.js 18 ขึ้นไป — **ไม่มี dependency ภายนอก** ไม่ต้อง `npm install`

```bash
cd stock-analyzer
npm start                 # เปิด http://localhost:8787
npm run dev               # เปิดให้เครื่องอื่นในวง Wi-Fi เข้าได้ (HOST=0.0.0.0)
npm run check             # สแกนความปลอดภัย + ชุดทดสอบทั้งหมด
```

### เปิดบน iPhone / iPad / Mac แบบเหมือนแอป

แนะนำให้ Deploy ขึ้นโฮสต์ที่มี HTTPS (ด้านล่าง) แล้ว:

- **iPhone/iPad:** เปิด URL ใน Safari → ปุ่มแชร์ → **เพิ่มไปยังหน้าจอโฮม** → ได้ไอคอนเปิดเต็มจอเหมือนแอป
- **macOS:** Safari → File → **Add to Dock** (หรือ Chrome/Edge → ปุ่ม Install ในแถบที่อยู่)
- **ในวง Wi-Fi เดียวกัน (ทดสอบเร็ว):** `npm run dev` แล้วเปิด `http://<IP ของเครื่อง>:8787` บน iPhone (ใช้งานได้ครบ แต่ไม่มีโหมดออฟไลน์เพราะไม่ใช่ HTTPS)

ทำไมเลือก PWA แทนแอป Native: โค้ดชุดเดียวใช้ได้ทุกอุปกรณ์, อัปเดตทันทีไม่ต้องผ่าน App Store, ติดตั้งลงหน้าจอโฮมได้ และการคำนวณทั้งหมดทำในเครื่องผู้ใช้ (เร็วและเป็นส่วนตัว)

### Deploy (เลือกอย่างใดอย่างหนึ่ง)

```bash
docker build -t signal-lab . && docker run -p 8787:8787 -e TRUST_PROXY=1 -e HSTS=1 signal-lab
```

ใช้กับ Render / Fly.io / Railway / Google Cloud Run / VPS ใดก็ได้ที่รัน Node หรือ Docker และมี HTTPS

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `PORT` | 8787 | พอร์ต |
| `HOST` | 127.0.0.1 | ใช้ `0.0.0.0` เมื่อ Deploy/เปิดในวง LAN |
| `TRUST_PROXY` | 0 | จำนวน Reverse proxy ด้านหน้า (เช่น 1) — ใช้หา IP จริงสำหรับ Rate limit |
| `HSTS` | ปิด | `1` เมื่อให้บริการผ่าน HTTPS |
| `CACHE_MB` | 64 | เพดานหน่วยความจำ Cache |

## โครงสร้าง

```
server.js            HTTP server: static files + /api/candles + /api/news (validate, cache, rate-limit)
lib/                 providers.js (Yahoo Finance), news.js (RSS ที่ sanitize แล้ว), util.js
public/core/         ตรรกะวิเคราะห์ทั้งหมด (ใช้ร่วมกันทั้งเบราว์เซอร์และชุดทดสอบ)
  indicators.js      EMA/RMA/RSI/ATR/Pivot — สูตรตรง TradingView
  cdc.js             CDC ActionZone V3 ตามสคริปต์ต้นฉบับ
  divergence.js      RSI Divergence 4 แบบ ตาม TradingView (พร้อมแท่งยืนยัน)
  zigzag.js, elliott.js   Swing + นับคลื่นพร้อมกฎเหล็ก/Fibonacci/Count สำรอง
  analyze.js         หลาย Timeframe → คะแนนโปร่งใส → แผนเทรด
  backtest.js, strategies.js, validation.js, stats.js, edge.js   ชั้นพิสูจน์
  psychology.js, sentiment.js   จิตวิทยาตลาด, ข่าว/Factor
public/js/           UI (DOM ปลอดภัย, กราฟ Canvas ไม่พึ่งไลบรารี)
test/                ชุดทดสอบ 44 รายการ
scripts/             security-check.js, make-icons.cjs
```

## ความถูกต้อง — ตรวจอย่างไร

- **RSI** ตรงกับตารางอ้างอิง StockCharts (Wilder) ทุกค่าถึงทศนิยม 2 ตำแหน่ง
- **CDC ActionZone** ทุกแท่งตรงกับนิยามโซน และสัญญาณ Buy/Sell สลับกันเสมอ
- **ไม่มี Look-ahead:** ทดสอบโดยคำนวณใหม่บนข้อมูลที่ถูกตัดท้าย 4 จุด — สัญญาณ CDC, Divergence, ZigZag และทุกกลยุทธ์ต้องเหมือนเดิมทุกแท่ง
- **Backtest:** สั่งซื้อที่ราคาเปิดแท่งถัดไป คิดค่าธรรมเนียมทั้งขาเข้า-ออก Stop ที่ Gap ผ่านจะได้ราคาเปิดที่แย่กว่า
- **Elliott:** count ที่ผิดกฎ R1–R4 ถูกตัดทิ้ง (มีชุดทดสอบ)
- **สถิติ:** Normal/Student-t เทียบตาราง, PSR, Permutation test (การ “โกง” ด้วยการรู้อนาคตต้องถูกจับได้), Bootstrap coverage

## ความปลอดภัย

| ภัยคุกคาม | การป้องกัน |
|---|---|
| XSS (ข่าว/ชื่อบริษัทจากภายนอก) | ทุกข้อความแสดงผลผ่าน `textContent` เท่านั้น, ลิงก์รับเฉพาะ http(s), RSS ถูกถอด HTML/entities, CSP เข้ม: `script-src 'self'` ไม่มี inline |
| SSRF | Server เรียกได้เฉพาะโฮสต์ใน Allow-list ผ่าน HTTPS ตรวจซ้ำทุก Redirect (สูงสุด 3 ครั้ง) |
| Path traversal / Symlink | ตรวจ path, ห้าม dotfile, จำกัดนามสกุลไฟล์, ตรวจ realpath ต้องอยู่ใน `public/` |
| Injection ผ่านพารามิเตอร์ | สัญลักษณ์/คำค้นตรวจด้วย Regex แบบ allow-list ก่อนเรียกภายนอก |
| DoS | Rate limit ต่อ IP (กัน X-Forwarded-For ปลอม), จำกัดขนาด Response ภายนอก, Cache มีเพดานไบต์, Timeout ทุกขั้น, Parser RSS เวลาเชิงเส้น (ไม่มี ReDoS) |
| Clickjacking / การรั่วข้อมูล | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, ข้อผิดพลาดภายในไม่ส่ง stack ให้ผู้ใช้, Log ตัดอักขระควบคุม |
| Supply chain | ไม่มี Runtime dependency, Docker รันด้วยผู้ใช้ที่ไม่ใช่ root |

ทั้งหมดนี้มีชุดทดสอบใน `test/server.test.js` และ `npm run check` จะไม่ผ่านถ้ามีรูปแบบอันตราย (innerHTML, eval, inline script, โฮสต์นอก allow-list, secret, dependency) หลุดเข้ามา

## ข้อจำกัดที่ควรรู้

- ราคามาจาก Yahoo Finance chart API (ไม่เป็นทางการ อาจล่าช้า/เปลี่ยนรูปแบบ/จำกัดการเรียก) — เหมาะกับการใช้ส่วนตัว ถ้าใช้เชิงพาณิชย์ควรเปลี่ยนเป็นผู้ให้บริการข้อมูลที่มีสัญญาอนุญาต (แก้เฉพาะ `lib/providers.js`) หรือนำเข้า CSV
- ข้อมูลรายชั่วโมงย้อนหลังได้ราว 2 ปี (ข้อจำกัดของแหล่งข้อมูล)
- Sentiment แบบพจนานุกรมโปร่งใสแต่ไม่เข้าใจบริบทซับซ้อน — ควรอ่านต้นฉบับประกอบ
- Elliott Wave เป็นการตีความ: คะแนนคือความสอดคล้องกับกฎ ไม่ใช่ความน่าจะเป็นที่ถูก

> เพื่อการศึกษาและประกอบการตัดสินใจเท่านั้น ไม่ใช่คำแนะนำการลงทุน ผลในอดีตไม่รับประกันอนาคต
