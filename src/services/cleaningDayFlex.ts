import { formatThaiDate } from './attendanceQuery'

// ---------------------------------------------------------------------------
// การ์ดประกาศ "Monthly Cleaning Day" (วันเสาร์สุดท้ายของเดือน)
//   countdown : แจ้งล่วงหน้า 1/3, 2/3, 3/3 (ช่วงเช้า / ช่วงเย็น)
//   today     : เช้าวันเสาร์ "วันนี้คือ Cleaning Day"
//   starting  : ก่อนเริ่มกิจกรรม 15 นาที (15:15 สำหรับเริ่ม 15:30) "อีก 15 นาทีเริ่มแล้ว" + เช็กลิสต์เตรียมตัว
//   thanks    : เย็นวันเสาร์ ขอบคุณ + วันของเดือนหน้า
//
// หัวการ์ดเป็น gradient โทนเขียวน้ำทะเลเข้ม (ตัวอักษรขาวอ่านชัด ~5:1) และใส่ backgroundColor สีทึบไว้ด้วย
// ให้ LINE รุ่นที่ไม่รองรับ gradient ยังแสดงสีเดียวกัน
// ตามกติกา LINE for PC ใน CLAUDE.md: สีทึบเท่านั้น, ไม่มี box ว่างเป็นแถบสี, ไม่ใช้ offset/alignItems, wrap ทุก text
// แถบความคืบหน้าจึงทำด้วย span ของจุด ● ○ แทน box สี
// ---------------------------------------------------------------------------

export type CleaningDaySlot = 'morning' | 'start' | 'evening'

export type CleaningDayNotice =
  | { kind: 'countdown'; eventDate: string; step: number; total: number; daysLeft: number; slot: CleaningDaySlot }
  | { kind: 'today'; eventDate: string; slot: CleaningDaySlot }
  | { kind: 'starting'; eventDate: string; startTime: string; minutesLeft: number; slot: CleaningDaySlot }
  | { kind: 'thanks'; eventDate: string; nextEventDate: string; slot: CleaningDaySlot }

const TEAL_DARK = '#0F766E'
const EMERALD_DARK = '#065F46'
const TEAL_INK = '#115E59'
const TEAL_TINT = '#CCFBF1'
const TEAL_SOFT = '#F0FDFA'
const MINT = '#ECFDF5'
const INK = '#1F2937'
const BODY = '#374151'
const MUTED = '#6B7280'
const DOT_OFF = '#CBD5E1'
const WHITE = '#FFFFFF'

function chip(text: string, bg: string, fg: string) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    backgroundColor: bg,
    cornerRadius: '999px',
    paddingTop: '4px',
    paddingBottom: '4px',
    paddingStart: '10px',
    paddingEnd: '10px',
    contents: [{ type: 'text', text, size: 'xs', color: fg, weight: 'bold', wrap: true }]
  }
}

/** แถวรายการ: ไอคอนในวงกลมสีอ่อน + ข้อความ */
function checkRow(icon: string, label: string) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        flex: 0,
        width: '36px',
        height: '36px',
        cornerRadius: '999px',
        backgroundColor: MINT,
        justifyContent: 'center',
        contents: [{ type: 'text', text: icon, size: 'md', align: 'center', gravity: 'center', wrap: true }]
      },
      { type: 'text', text: label, size: 'sm', color: INK, gravity: 'center', flex: 1, wrap: true }
    ]
  }
}

/** ●●○ แจ้งเตือนครั้งที่ 2 จาก 3 */
function progressDots(step: number, total: number) {
  const dots = Array.from({ length: total }, (_, i) => ({
    type: 'span',
    text: i < total - 1 ? '● ' : '●',
    color: i < step ? TEAL_DARK : DOT_OFF
  }))
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      { type: 'text', size: 'md', flex: 0, wrap: true, contents: dots },
      { type: 'text', text: `แจ้งเตือนครั้งที่ ${step} จาก ${total}`, size: 'xs', color: MUTED, gravity: 'center', flex: 1, wrap: true }
    ]
  }
}

function slotLabel(slot: CleaningDaySlot): string {
  return slot === 'morning' ? '☀️ แจ้งเตือนช่วงเช้า' : slot === 'start' ? '⏰ แจ้งเตือนก่อนเริ่มกิจกรรม' : '🌇 แจ้งเตือนช่วงเย็น'
}

const AMBER_BG = '#FFFBEB'
const AMBER_INK = '#92400E'

function header(n: CleaningDayNotice) {
  const badge =
    n.kind === 'countdown'
      ? chip(`แจ้งเตือน ${n.step}/${n.total}`, WHITE, TEAL_INK)
      : n.kind === 'today'
        ? chip('วันนี้!', WHITE, TEAL_INK)
        : n.kind === 'starting'
          ? chip(`อีก ${n.minutesLeft} นาที ⏰`, WHITE, TEAL_INK)
          : chip('ขอบคุณ 💚', WHITE, TEAL_INK)
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: TEAL_DARK,
    background: { type: 'linearGradient', angle: '135deg', startColor: TEAL_DARK, endColor: EMERALD_DARK },
    paddingAll: '20px',
    paddingBottom: '22px',
    spacing: 'sm',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [chip('📢 ประกาศของบริษัท', TEAL_TINT, TEAL_INK), { type: 'filler' }, badge]
      },
      {
        type: 'text',
        text: n.kind === 'thanks' ? 'ขอบคุณทุกคน 🌿' : '🧹 Monthly Cleaning Day',
        size: 'xl',
        weight: 'bold',
        color: WHITE,
        margin: 'lg',
        wrap: true
      },
      { type: 'text', text: `วัน${formatThaiDate(n.eventDate)}`, size: 'sm', color: TEAL_TINT, wrap: true }
    ]
  }
}

/** กล่องเด่นใต้หัวการ์ด: นับถอยหลัง / วันนี้ / ขอบคุณ */
function spotlight(n: CleaningDayNotice) {
  const big = (text: string) => ({ type: 'text', text, size: '3xl', weight: 'bold', color: TEAL_DARK, flex: 0, gravity: 'center', wrap: true })
  const lines =
    n.kind === 'countdown'
      ? {
          left: big(String(n.daysLeft)),
          title: n.daysLeft === 1 ? 'พรุ่งนี้แล้ว!' : `อีก ${n.daysLeft} วัน`,
          sub: 'นับถอยหลังสู่วัน Cleaning Day'
        }
      : n.kind === 'today'
        ? { left: big('🎉'), title: 'วันนี้คือ Cleaning Day', sub: 'มาช่วยกันทำให้ที่ทำงานน่าอยู่กันเถอะ' }
        : n.kind === 'starting'
          ? { left: big(String(n.minutesLeft)), title: `อีก ${n.minutesLeft} นาที เริ่มแล้ว!`, sub: `เริ่มกิจกรรมเวลา ${n.startTime} น. เตรียมตัวให้พร้อมนะ` }
          : {
            left: big('✨'),
            title: 'ที่ทำงานสะอาดขึ้นเพราะทุกคน',
            sub: `เจอกันใหม่ วัน${formatThaiDate(n.nextEventDate, { year: false })}`
          }
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: TEAL_SOFT,
    cornerRadius: '14px',
    paddingAll: '14px',
    spacing: 'md',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'lg',
        contents: [
          lines.left,
          {
            type: 'box',
            layout: 'vertical',
            flex: 1,
            justifyContent: 'center',
            contents: [
              { type: 'text', text: lines.title, size: 'md', weight: 'bold', color: INK, wrap: true },
              { type: 'text', text: lines.sub, size: 'xs', color: MUTED, wrap: true }
            ]
          }
        ]
      },
      ...(n.kind === 'countdown' ? [progressDots(n.step, n.total)] : [])
    ]
  }
}

export function buildCleaningDayCard(n: CleaningDayNotice, message: string): { contents: unknown; altText: string } {
  const body: unknown[] = [spotlight(n)]
  if (n.kind === 'starting') {
    body.push(
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          chip(`🕒 เริ่ม ${n.startTime} น.`, TEAL_TINT, TEAL_INK),
          chip(`📅 วันนี้ ${formatThaiDate(n.eventDate, { weekday: false, year: false })}`, TEAL_TINT, TEAL_INK),
          { type: 'filler' }
        ]
      },
      { type: 'text', text: 'ใกล้ถึงเวลา Monthly Cleaning Day แล้ว เก็บงานตรงหน้าให้เรียบร้อย แล้วมาเจอกันที่พื้นที่ของแต่ละทีมตรงเวลานะครับ', size: 'sm', color: BODY, wrap: true, lineSpacing: '6px' },
      { type: 'separator', margin: 'md', color: '#E5E7EB' },
      { type: 'text', text: 'เตรียมตัวก่อนเริ่ม', size: 'xs', color: MUTED, weight: 'bold', margin: 'md', wrap: true },
      checkRow('🧤', 'หยิบถุงมือ ถุงขยะ และผ้าเช็ดทำความสะอาด'),
      checkRow('🗂️', 'เริ่มจากโต๊ะและพื้นที่ของตัวเอง แล้วไปช่วยส่วนกลาง'),
      checkRow('🤝', 'ชวนเพื่อนข้าง ๆ ไปด้วยกัน ทำเป็นทีมเสร็จไวกว่า'),
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: AMBER_BG,
        cornerRadius: '10px',
        paddingAll: '10px',
        margin: 'md',
        contents: [{ type: 'text', text: '💡 เสร็จแล้วอย่าลืมแยกขยะและเก็บอุปกรณ์เข้าที่ ขอบคุณทุกคนล่วงหน้าครับ', size: 'xs', color: AMBER_INK, wrap: true }]
      }
    )
  } else if (n.kind === 'thanks') {
    body.push({
      type: 'text',
      text: 'ขอบคุณพนักงานทุกท่านที่ร่วมกันจัดระเบียบและทำความสะอาดพื้นที่ทำงานในวันนี้ ความร่วมมือของทุกคนทำให้บรรยากาศการทำงานสดชื่นและปลอดภัยยิ่งขึ้น',
      size: 'sm',
      color: BODY,
      wrap: true,
      lineSpacing: '6px'
    })
  } else {
    body.push(
      { type: 'text', text: message, size: 'sm', color: BODY, wrap: true, lineSpacing: '6px' },
      { type: 'separator', margin: 'md', color: '#E5E7EB' },
      { type: 'text', text: 'ร่วมกันทำ', size: 'xs', color: MUTED, weight: 'bold', margin: 'md', wrap: true },
      checkRow('🗂️', 'จัดระเบียบโต๊ะและพื้นที่ทำงานส่วนตัว'),
      checkRow('🧽', 'ทำความสะอาดพื้นที่ส่วนกลาง'),
      checkRow('🌿', 'สร้างบรรยากาศที่สดชื่นและปลอดภัย')
    )
  }

  const contents = {
    type: 'bubble',
    size: 'mega',
    header: header(n),
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '18px', contents: body },
    footer: {
      type: 'box',
      layout: 'horizontal',
      paddingAll: '14px',
      paddingTop: '0px',
      contents: [
        { type: 'text', text: slotLabel(n.slot), size: 'xs', color: MUTED, flex: 1, wrap: true },
        { type: 'text', text: 'ขอบคุณที่ร่วมมือ 💚', size: 'xs', color: TEAL_INK, weight: 'bold', align: 'end', flex: 1, wrap: true }
      ]
    },
    styles: { footer: { separator: false } }
  }

  const when = formatThaiDate(n.eventDate, { year: false })
  const altText =
    n.kind === 'countdown'
      ? `📢 Monthly Cleaning Day ${when} · แจ้งเตือน ${n.step}/${n.total} (${n.daysLeft === 1 ? 'พรุ่งนี้' : `อีก ${n.daysLeft} วัน`})`
      : n.kind === 'today'
        ? `📢 วันนี้คือ Monthly Cleaning Day (${when}) มาช่วยกันจัดระเบียบและทำความสะอาดกันนะ`
        : n.kind === 'starting'
          ? `⏰ อีก ${n.minutesLeft} นาที Monthly Cleaning Day เริ่มแล้ว (${n.startTime} น.) เตรียมตัวให้พร้อมนะ`
          : `💚 ขอบคุณทุกคนที่ร่วม Monthly Cleaning Day (${when})`
  return { contents, altText }
}
