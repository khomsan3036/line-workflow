import express, { type Request, type Response, type Router } from 'express'
import { asyncRouter } from '../middleware/asyncRouter'
import { config, reportScheduleNote } from '../config'
import { getQuota } from '../line/client'
import { setFlash, takeFlash } from '../middleware/auth'
import { flexAnnouncement, flexDailySummary, flexExecutiveReport, flexTaskReminder } from '../services/flex'
import { defaultGroupId, listGroups, updateGroup, upsertGroup } from '../services/groups'
import {
  fetchMessagesForExport,
  messagesOfDay,
  searchMessages,
  toCsv,
  type MessageFilter
} from '../services/messages'
import {
  deleteMediaByMessageId,
  getMedia,
  mediaFileLabel,
  mediaStats,
  readMediaBuffer,
  searchMedia,
  setMediaCaption,
  type MediaFilter
} from '../services/media'
import { listLogs, sendAndLog } from '../services/messaging'
import { formatBytes, getStorage } from '../services/storage'
import { detectAnomalies, getDailySales, latestSalesDate, salesTrend } from '../services/sales'
import {
  dailyCounts,
  getOverview,
  hourlyActivity,
  messageTypeBreakdown,
  topTalkers
} from '../services/stats'
import { listSummaries, saveSummary, summarizeMessages } from '../services/summary'
import { addTask, addTasksSkipDuplicate, deleteTask, listTasks, setTaskStatus } from '../services/tasks'
import { saveMessage } from './webhook'

// ---------------------------------------------------------------------------
// Admin Dashboard - ทุกหน้าอยู่ใน router นี้ (ต้องผ่าน requireLogin มาแล้ว)
// ---------------------------------------------------------------------------

/** วันที่วันนี้ในรูปแบบ YYYY-MM-DD ตามเวลาไทย */
function todayISO(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.timezone })
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export function createAdminRouter(): Router {
  const router = asyncRouter()

  // ค่าที่ทุกหน้าต้องใช้: รายชื่อกลุ่ม + กลุ่มที่เลือกอยู่ + flash message
  router.use(async (req: Request, res: Response, next) => {
    try {
      const groups = await listGroups()
      const selected =
        str(req.query.group) ?? (config.defaultGroupId || (await defaultGroupId()) || '')
      res.locals.groups = groups
      res.locals.selectedGroup = selected
      res.locals.user = req.session.user
      res.locals.flash = takeFlash(req)
      res.locals.mockLine = config.mockLine
      res.locals.currentPath = req.path
      next()
    } catch (err) {
      next(err)
    }
  })

  // -------------------------------------------------------------------------
  // 1) หน้าภาพรวม
  // -------------------------------------------------------------------------
  router.get('/', async (req: Request, res: Response) => {
    const group = str(req.query.group)
    const [overview, daily, talkers, hourly, types, quota, tasks, logs] = await Promise.all([
      getOverview(group),
      dailyCounts(14, group),
      topTalkers(5, group),
      hourlyActivity(group),
      messageTypeBreakdown(group),
      getQuota(),
      listTasks(group, 'open'),
      listLogs(5)
    ])

    res.render('dashboard', {
      title: 'ภาพรวมระบบ',
      overview,
      daily,
      talkers,
      hourly,
      types,
      quota,
      openTasks: tasks.slice(0, 6),
      recentLogs: logs
    })
  })

  // -------------------------------------------------------------------------
  // 2) ประวัติแชท
  // -------------------------------------------------------------------------
  router.get('/messages', async (req: Request, res: Response) => {
    const filter: MessageFilter = {
      groupId: str(req.query.group),
      keyword: str(req.query.q),
      sender: str(req.query.sender),
      messageType: str(req.query.type),
      dateFrom: str(req.query.from),
      dateTo: str(req.query.to),
      page: Number(req.query.page ?? 1),
      pageSize: Number(req.query.size ?? 50)
    }
    const result = await searchMessages(filter)
    res.render('messages', { title: 'ประวัติแชท', filter, ...result, query: req.query })
  })

  router.get('/messages.csv', async (req: Request, res: Response) => {
    const rows = await fetchMessagesForExport({
      groupId: str(req.query.group),
      keyword: str(req.query.q),
      sender: str(req.query.sender),
      messageType: str(req.query.type),
      dateFrom: str(req.query.from),
      dateTo: str(req.query.to)
    })
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="line-messages-${todayISO()}.csv"`)
    res.send(toCsv(rows))
  })

  // -------------------------------------------------------------------------
  // 3) จัดการกลุ่ม
  // -------------------------------------------------------------------------
  router.get('/groups', async (_req: Request, res: Response) => {
    res.render('groups', { title: 'กลุ่มที่บอทเข้าร่วม' })
  })

  router.post('/groups/:groupId', async (req: Request, res: Response) => {
    const { groupName, note, consent } = req.body as Record<string, string>
    await updateGroup(req.params.groupId, {
      groupName: str(groupName),
      note: note ?? '',
      consent: consent === 'on'
    })
    setFlash(req, 'success', 'บันทึกข้อมูลกลุ่มแล้ว')
    res.redirect('/groups')
  })

  // เพิ่มกลุ่มด้วยมือ (กรณีรู้ groupId อยู่แล้ว แต่ยังไม่มีข้อความเข้ามา)
  router.post('/groups', async (req: Request, res: Response) => {
    const groupId = str((req.body as Record<string, string>).groupId)
    const groupName = str((req.body as Record<string, string>).groupName)
    if (!groupId) {
      setFlash(req, 'error', 'ต้องระบุ groupId')
    } else {
      await upsertGroup(groupId, { groupName: groupName ?? null })
      setFlash(req, 'success', `เพิ่มกลุ่ม ${groupId} แล้ว`)
    }
    res.redirect('/groups')
  })

  // -------------------------------------------------------------------------
  // 4) ส่งข้อความเข้ากลุ่ม / broadcast
  // -------------------------------------------------------------------------
  router.get('/send', async (_req: Request, res: Response) => {
    const logs = await listLogs(15)
    res.render('send', { title: 'ส่งข้อความ', logs, preview: null, form: {} })
  })

  router.post('/send', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string>
    const action = body.action ?? 'send'
    const targetType = (body.targetType ?? 'group') as 'group' | 'user' | 'broadcast'
    const kind = (body.kind ?? 'text') as 'text' | 'flex'

    let contents: unknown = null
    let altText = str(body.altText) ?? 'ข้อความจากระบบ'
    let error: string | null = null

    if (kind === 'flex') {
      if (body.flexMode === 'raw') {
        try {
          contents = JSON.parse(body.rawJson ?? '{}')
        } catch (err) {
          error = `JSON ไม่ถูกต้อง: ${err instanceof Error ? err.message : String(err)}`
        }
      } else {
        contents = flexAnnouncement({
          title: str(body.annTitle) ?? 'ประกาศจากบริษัท',
          category: str(body.annCategory) ?? 'ฝ่ายบุคคลและธุรการ',
          body: str(body.annBody) ?? '',
          bullets: (body.annBullets ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
          buttonLabel: str(body.annButtonLabel),
          buttonUrl: str(body.annButtonUrl)
        })
        altText = str(body.annTitle) ?? altText
      }
    }

    // ปุ่ม "ดูตัวอย่าง" ไม่ส่งออก แค่แสดง JSON ให้ตรวจ
    if (action === 'preview' || error) {
      const logs = await listLogs(15)
      if (error) setFlash(req, 'error', error)
      res.render('send', {
        title: 'ส่งข้อความ',
        logs,
        preview: error ? null : { kind, text: body.text, altText, contents },
        form: body,
        flash: error ? { type: 'error', text: error } : res.locals.flash
      })
      return
    }

    const targetId = targetType === 'broadcast' ? undefined : str(body.targetId)
    if (targetType !== 'broadcast' && !targetId) {
      setFlash(req, 'error', 'ต้องเลือกกลุ่มหรือระบุ userId ปลายทาง')
      res.redirect('/send')
      return
    }

    const groups = res.locals.groups as { group_id: string; group_name: string | null }[]
    const targetName = groups.find((g) => g.group_id === targetId)?.group_name ?? undefined

    const result = await sendAndLog({
      targetType,
      targetId,
      targetName,
      kind,
      text: str(body.text),
      altText,
      contents,
      sentBy: req.session.user ?? 'admin',
      dryRun: action === 'dry'
    })

    if (result.status === 'failed') {
      setFlash(req, 'error', `ส่งไม่สำเร็จ: ${result.error}`)
    } else if (action === 'dry') {
      setFlash(req, 'success', 'ทดสอบแบบ dry-run เรียบร้อย (ไม่ส่งออกจริง) ดูรายการใน log ด้านล่าง')
    } else if (result.status === 'mock') {
      setFlash(req, 'success', 'ส่งสำเร็จในโหมด MOCK (ยังไม่ยิง LINE API จริง) ตั้ง MOCK_LINE=false เมื่อพร้อมส่งจริง')
    } else {
      setFlash(req, 'success', 'ส่งข้อความเข้า LINE เรียบร้อย')
    }
    res.redirect('/send')
  })

  // -------------------------------------------------------------------------
  // 5) AI สรุปบทสนทนา
  // -------------------------------------------------------------------------
  router.get('/summaries', async (req: Request, res: Response) => {
    const group = str(req.query.group) ?? (res.locals.selectedGroup as string)
    const summaries = await listSummaries(group || undefined)
    res.render('summaries', {
      title: 'AI สรุปบทสนทนา',
      summaries,
      date: str(req.query.date) ?? todayISO(),
      result: null
    })
  })

  router.post('/summaries/generate', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string>
    const groupId = str(body.groupId)
    const date = str(body.date) ?? todayISO()
    if (!groupId) {
      setFlash(req, 'error', 'ต้องเลือกกลุ่มก่อน')
      res.redirect('/summaries')
      return
    }

    const messages = await messagesOfDay(groupId, date)
    const result = await summarizeMessages(messages)
    await saveSummary(groupId, date, result)

    // สกัดงานที่มอบหมายเข้าตาราง group_tasks ให้ติดตามต่อได้
    const added = await addTasksSkipDuplicate(
      groupId,
      result.tasks.map((t) => ({
        groupId,
        assignee: t.assignee,
        taskText: t.task,
        dueText: t.due ?? null,
        source: 'ai' as const
      }))
    )

    setFlash(
      req,
      'success',
      `สรุปเรียบร้อย (${result.messageCount} ข้อความ, โมเดล ${result.model}) เพิ่มงานใหม่ ${added} รายการ`
    )
    res.redirect(`/summaries?group=${encodeURIComponent(groupId)}&date=${date}`)
  })

  // ส่งสรุปกลับเข้ากลุ่มเป็น Flex Message
  router.post('/summaries/:id/send', async (req: Request, res: Response) => {
    const id = Number(req.params.id)
    const summaries = await listSummaries(undefined, 200)
    const summary = summaries.find((s) => s.id === id)
    if (!summary) {
      setFlash(req, 'error', 'ไม่พบรายการสรุป')
      res.redirect('/summaries')
      return
    }

    const dateISO = new Date(summary.summary_date).toLocaleDateString('en-CA', { timeZone: config.timezone })
    const [talkers, tasks] = await Promise.all([
      topTalkers(3, summary.group_id, 1),
      listTasks(summary.group_id, 'open')
    ])
    const groups = res.locals.groups as { group_id: string; group_name: string | null }[]
    const groupName = groups.find((g) => g.group_id === summary.group_id)?.group_name ?? summary.group_id

    const contents = flexDailySummary({
      groupName,
      dateLabel: new Date(summary.summary_date).toLocaleDateString('th-TH', {
        timeZone: config.timezone,
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      }),
      messageCount: summary.message_count ?? 0,
      topTalkers: talkers,
      topics: summary.topics ?? [],
      tasks: tasks.slice(0, 6).map((t) => ({
        assignee: t.assignee ?? 'ไม่ระบุ',
        task: t.task_text,
        due: t.due_text ?? undefined
      }))
    })

    const dryRun = (req.body as Record<string, string>).action === 'dry'
    const result = await sendAndLog({
      targetType: 'group',
      targetId: summary.group_id,
      targetName: groupName,
      kind: 'flex',
      altText: `สรุปประชุมกลุ่ม ${dateISO}`,
      contents,
      sentBy: req.session.user ?? 'admin',
      dryRun
    })

    setFlash(
      req,
      result.status === 'failed' ? 'error' : 'success',
      result.status === 'failed'
        ? `ส่งไม่สำเร็จ: ${result.error}`
        : dryRun
          ? 'ทดสอบ dry-run เรียบร้อย ยังไม่ส่งเข้ากลุ่ม'
          : `ส่งสรุปเข้ากลุ่มแล้ว (สถานะ ${result.status})`
    )
    res.redirect(`/summaries?group=${encodeURIComponent(summary.group_id)}`)
  })

  // -------------------------------------------------------------------------
  // 6) ติดตามงานที่มอบหมาย
  // -------------------------------------------------------------------------
  router.get('/tasks', async (req: Request, res: Response) => {
    const group = str(req.query.group) ?? (res.locals.selectedGroup as string)
    const tasks = await listTasks(group || undefined)
    res.render('tasks', { title: 'ติดตามงานที่มอบหมาย', tasks })
  })

  router.post('/tasks', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string>
    const groupId = str(body.groupId)
    const taskText = str(body.taskText)
    if (!groupId || !taskText) {
      setFlash(req, 'error', 'ต้องระบุกลุ่มและรายละเอียดงาน')
    } else {
      await addTask({
        groupId,
        assignee: str(body.assignee) ?? null,
        taskText,
        dueText: str(body.dueText) ?? null,
        source: 'manual'
      })
      setFlash(req, 'success', 'เพิ่มงานแล้ว')
    }
    res.redirect(`/tasks?group=${encodeURIComponent(groupId ?? '')}`)
  })

  router.post('/tasks/:id/status', async (req: Request, res: Response) => {
    const status = ((req.body as Record<string, string>).status ?? 'done') as 'open' | 'done' | 'cancelled'
    await setTaskStatus(Number(req.params.id), status)
    res.redirect(`/tasks?group=${encodeURIComponent((req.body as Record<string, string>).groupId ?? '')}`)
  })

  router.post('/tasks/:id/delete', async (req: Request, res: Response) => {
    await deleteTask(Number(req.params.id))
    setFlash(req, 'success', 'ลบงานแล้ว')
    res.redirect(`/tasks?group=${encodeURIComponent((req.body as Record<string, string>).groupId ?? '')}`)
  })

  // ส่งการ์ดเตือนงานค้างเข้ากลุ่ม
  router.post('/tasks/remind', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string>
    const groupId = str(body.groupId)
    if (!groupId) {
      setFlash(req, 'error', 'ต้องเลือกกลุ่ม')
      res.redirect('/tasks')
      return
    }
    const tasks = await listTasks(groupId, 'open')
    const groups = res.locals.groups as { group_id: string; group_name: string | null }[]
    const groupName = groups.find((g) => g.group_id === groupId)?.group_name ?? groupId

    const result = await sendAndLog({
      targetType: 'group',
      targetId: groupId,
      targetName: groupName,
      kind: 'flex',
      altText: `เตือนงานค้าง ${tasks.length} รายการ`,
      contents: flexTaskReminder({
        groupName,
        tasks: tasks.map((t) => ({
          assignee: t.assignee ?? 'ไม่ระบุ',
          task: t.task_text,
          due: t.due_text ?? undefined
        }))
      }),
      sentBy: req.session.user ?? 'admin',
      dryRun: body.action === 'dry'
    })

    setFlash(
      req,
      result.status === 'failed' ? 'error' : 'success',
      result.status === 'failed' ? `ส่งไม่สำเร็จ: ${result.error}` : `ส่งการ์ดเตือนงานแล้ว (${result.status})`
    )
    res.redirect(`/tasks?group=${encodeURIComponent(groupId)}`)
  })

  // -------------------------------------------------------------------------
  // 7) รายงานผู้บริหาร (Capstone)
  // -------------------------------------------------------------------------
  router.get('/sales', async (req: Request, res: Response) => {
    const latest = await latestSalesDate()
    const date = str(req.query.date) ?? latest ?? todayISO()
    const [sales, anomalies, trend] = await Promise.all([
      getDailySales(date),
      detectAnomalies(date),
      salesTrend(date, 14)
    ])
    res.render('sales', {
      title: 'รายงานผู้บริหาร (Capstone)',
      sales,
      anomalies,
      trend,
      date,
      hasData: latest !== null,
      scheduleNote: reportScheduleNote(),
      reportCron: config.scheduler.reportCron
    })
  })

  router.post('/sales/send', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string>
    const date = str(body.date) ?? todayISO()
    const groupId = str(body.groupId)
    if (!groupId) {
      setFlash(req, 'error', 'ต้องเลือกกลุ่มผู้บริหารก่อน')
      res.redirect(`/sales?date=${date}`)
      return
    }

    const [sales, anomalies] = await Promise.all([getDailySales(date), detectAnomalies(date)])
    const groups = res.locals.groups as { group_id: string; group_name: string | null }[]
    const groupName = groups.find((g) => g.group_id === groupId)?.group_name ?? groupId

    const result = await sendAndLog({
      targetType: 'group',
      targetId: groupId,
      targetName: groupName,
      kind: 'flex',
      altText: `รายงานยอดขายวันที่ ${date}`,
      contents: flexExecutiveReport({
        dateLabel: new Date(`${date}T00:00:00`).toLocaleDateString('th-TH', {
          day: 'numeric',
          month: 'short',
          year: 'numeric'
        }),
        totalAmount: sales.totalAmount,
        orderCount: sales.orderCount,
        avgOrder: sales.avgOrder,
        changePct: sales.changePct,
        branches: sales.branches,
        channels: sales.channels,
        anomalies,
        footerNote: reportScheduleNote() ? `รายงานอัตโนมัติ · ${reportScheduleNote()}` : undefined
      }),
      sentBy: req.session.user ?? 'admin',
      dryRun: body.action === 'dry'
    })

    setFlash(
      req,
      result.status === 'failed' ? 'error' : 'success',
      result.status === 'failed' ? `ส่งไม่สำเร็จ: ${result.error}` : `ส่งรายงานแล้ว (สถานะ ${result.status})`
    )
    res.redirect(`/sales?date=${date}`)
  })

  // -------------------------------------------------------------------------
  // 8) แกลเลอรีไฟล์ที่เก็บไว้ (Workshop 6)
  // -------------------------------------------------------------------------
  router.get('/media', async (req: Request, res: Response) => {
    const filter: MediaFilter = {
      groupId: str(req.query.group),
      mediaType: str(req.query.type),
      keyword: str(req.query.q),
      sender: str(req.query.sender),
      dateFrom: str(req.query.from),
      dateTo: str(req.query.to),
      page: Number(req.query.page ?? 1),
      pageSize: Number(req.query.size ?? 24)
    }
    const [result, stats] = await Promise.all([searchMedia(filter), mediaStats(filter.groupId)])

    // ขนาดที่ใช้จริงบนดิสก์ (เทียบกับที่บันทึกในฐานข้อมูล ช่วยจับไฟล์ค้าง)
    let diskUsage: { files: number; bytes: number } | null = null
    try {
      diskUsage = await getStorage().usage()
    } catch {
      diskUsage = null
    }

    res.render('media', {
      title: 'แกลเลอรีไฟล์จากไลน์กลุ่ม',
      filter,
      stats,
      diskUsage,
      formatBytes,
      fileLabel: mediaFileLabel,
      mediaEnabled: config.media.enabled,
      driver: config.media.driver,
      ...result
    })
  })

  /** ส่งไฟล์ต้นฉบับกลับให้ผู้ใช้ดาวน์โหลด */
  router.get('/media/:id/file', async (req: Request, res: Response) => {
    const row = await getMedia(Number(req.params.id))
    if (!row || row.status !== 'stored') {
      res.status(404).send('ไม่พบไฟล์')
      return
    }
    try {
      const buffer = await readMediaBuffer(row, req.query.preview === '1')
      res.setHeader('Content-Type', row.content_type ?? 'application/octet-stream')
      if (req.query.download === '1') {
        const name = encodeURIComponent(row.file_name ?? `${row.line_message_id}`)
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${name}`)
      }
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.send(buffer)
    } catch (err) {
      res.status(410).send(`อ่านไฟล์จาก storage ไม่ได้: ${err instanceof Error ? err.message : err}`)
    }
  })

  /** ตั้งคำบรรยายไฟล์ เพื่อให้ค้นหาย้อนหลังด้วยคำที่คนจำได้ */
  router.post('/media/:id/caption', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string>
    await setMediaCaption(Number(req.params.id), str(body.caption) ?? null)
    setFlash(req, 'success', 'บันทึกคำบรรยายแล้ว')
    res.redirect(`/media?${new URLSearchParams({
      group: body.groupId ?? '',
      q: body.q ?? '',
      type: body.type ?? '',
      page: body.page ?? '1'
    }).toString()}`)
  })

  /** ลบไฟล์ด้วยตนเอง (เช่น เก็บผิด หรือมีข้อมูลอ่อนไหว) */
  router.post('/media/:id/delete', async (req: Request, res: Response) => {
    const row = await getMedia(Number(req.params.id))
    if (row) {
      await deleteMediaByMessageId(row.line_message_id, 'manual')
      setFlash(req, 'success', 'ลบไฟล์ออกจากระบบแล้ว')
    } else {
      setFlash(req, 'error', 'ไม่พบไฟล์')
    }
    res.redirect(`/media?group=${encodeURIComponent((req.body as Record<string, string>).groupId ?? '')}`)
  })

  // -------------------------------------------------------------------------
  // 9) ประวัติการส่งข้อความ
  // -------------------------------------------------------------------------
  router.get('/logs', async (_req: Request, res: Response) => {
    const logs = await listLogs(200)
    res.render('logs', { title: 'ประวัติการส่งข้อความ', logs })
  })

  // -------------------------------------------------------------------------
  // 10) เครื่องมือทดสอบ: จำลองข้อความเข้ากลุ่ม (ไม่ต้องมี LINE OA)
  // -------------------------------------------------------------------------
  router.get('/simulator', async (_req: Request, res: Response) => {
    res.render('simulator', { title: 'จำลองข้อความเข้ากลุ่ม' })
  })

  router.post('/simulator', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string>
    const groupId = str(body.groupId)
    const sender = str(body.sender) ?? 'ผู้ทดสอบ'
    const lines = (body.messages ?? '').split('\n').map((s) => s.trim()).filter(Boolean)

    if (!groupId || lines.length === 0) {
      setFlash(req, 'error', 'ต้องเลือกกลุ่มและใส่ข้อความอย่างน้อย 1 บรรทัด')
      res.redirect('/simulator')
      return
    }

    const now = Date.now()
    let saved = 0
    for (let i = 0; i < lines.length; i += 1) {
      const status = await saveMessage({
        lineMessageId: `sim-${now}-${i}`,
        groupId,
        userId: `Usim-${Buffer.from(sender).toString('hex').slice(0, 12)}`,
        displayName: sender,
        messageType: 'text',
        messageText: lines[i],
        sentAt: new Date(now + i * 1000)
      })
      if (status === 'inserted') saved += 1
    }
    await upsertGroup(groupId, { touchLastMessage: true })

    setFlash(req, 'success', `จำลองข้อความเข้ากลุ่มแล้ว ${saved} ข้อความ`)
    res.redirect(`/messages?group=${encodeURIComponent(groupId)}`)
  })

  // -------------------------------------------------------------------------
  // 11) API สำหรับกราฟ (ให้ frontend เรียกแบบ JSON)
  // -------------------------------------------------------------------------
  router.get('/api/stats', async (req: Request, res: Response) => {
    const group = str(req.query.group)
    const [daily, hourly, talkers, types] = await Promise.all([
      dailyCounts(Number(req.query.days ?? 14), group),
      hourlyActivity(group),
      topTalkers(5, group),
      messageTypeBreakdown(group)
    ])
    res.json({ daily, hourly, talkers, types })
  })

  return router
}
