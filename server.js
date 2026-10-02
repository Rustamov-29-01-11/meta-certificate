/* global process */
import express from 'express'
import multer from 'multer'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'

const root = path.dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'server', 'data')
const uploadDir = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(root, 'server', 'uploads')
const databasePath = process.env.DATABASE_PATH || path.join(dataDir, 'portfolio.db')

fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(uploadDir, { recursive: true })

const db = new Database(databasePath)

db.exec(`CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  organization TEXT NOT NULL,
  date TEXT NOT NULL,
  category TEXT NOT NULL,
  pdf TEXT NOT NULL,
  thumbnail TEXT,
  accent TEXT,
  mark TEXT
)`) 

if (!db.prepare('PRAGMA table_info(certificates)').all().some(column => column.name === 'thumbnail')) {
  db.exec('ALTER TABLE certificates ADD COLUMN thumbnail TEXT')
}

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_, file, done) => {
    const extension = path.extname(file.originalname).toLowerCase()
    const isSupported = file.mimetype === 'application/pdf' || file.mimetype === 'image/png' || file.mimetype === 'image/jpeg' || ['.pdf', '.png', '.jpg', '.jpeg'].includes(extension)
    done(isSupported ? null : new Error('Only PDF, PNG, or JPG files are allowed.'), isSupported)
  },
})

const app = express()
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  next()
})
app.use(express.json())
app.use('/uploads', express.static(uploadDir))

app.get('/', (_, res) => res.json({ status: 'ok', service: 'meta-certificate-api' }))
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'meta-certificate-api' }))
app.get('/api/certificates', (_, res) => res.json(db.prepare('SELECT * FROM certificates ORDER BY id DESC').all()))
app.get('/api/certificates/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id)
  if (!item) return res.status(404).json({ error: 'Certificate not found.' })
  res.json(item)
})
app.post('/api/certificates', upload.single('pdf'), async (req, res, next) => {
  if (!req.file || !req.body.title) return res.status(400).json({ error: 'Title and PDF file are required.' })
  try {
    const extension = path.extname(req.file.originalname).toLowerCase()
    let filename = req.file.filename
    let thumbnail = null

    if (extension !== '.pdf') {
      const imageBytes = fs.readFileSync(req.file.path)
      thumbnail = `/uploads/${req.file.filename}${extension}`
      fs.renameSync(req.file.path, path.join(uploadDir, `${req.file.filename}${extension}`))

      const pdf = await PDFDocument.create()
      const image = extension === '.png' ? await pdf.embedPng(imageBytes) : await pdf.embedJpg(imageBytes)
      const page = pdf.addPage([842, 595])
      const scale = Math.min(800 / image.width, 553 / image.height)
      page.drawImage(image, { x: (842 - image.width * scale) / 2, y: (595 - image.height * scale) / 2, width: image.width * scale, height: image.height * scale })

      filename = `${req.file.filename}.pdf`
      fs.writeFileSync(path.join(uploadDir, filename), await pdf.save())
    }

    const accent = ['coral', 'cyan', 'lime', 'violet'][Math.floor(Math.random() * 4)]
    const result = db.prepare('INSERT INTO certificates (title, organization, date, category, pdf, thumbnail, accent, mark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.body.title.trim(),
      req.body.organization?.trim() || 'Unknown organization',
      req.body.date?.trim() || new Date().toISOString().slice(0, 10),
      req.body.category?.trim() || 'Other',
      extension === '.pdf' ? `/uploads/${req.file.filename}.pdf` : `/uploads/${filename}`,
      thumbnail,
      accent,
      req.body.mark?.trim() || accent[0]?.toUpperCase() || 'C'
    )

    res.status(201).json(db.prepare('SELECT * FROM certificates WHERE id = ?').get(result.lastInsertRowid))
  } catch (error) {
    next(error)
  }
})

app.delete('/api/certificates/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id)
  if (!item) return res.status(404).json({ error: 'Certificate not found.' })

  if (item.pdf.startsWith('/uploads/')) fs.rmSync(path.join(uploadDir, path.basename(item.pdf)), { force: true })
  if (item.thumbnail?.startsWith('/uploads/')) fs.rmSync(path.join(uploadDir, path.basename(item.thumbnail)), { force: true })

  db.prepare('DELETE FROM certificates WHERE id = ?').run(req.params.id)
  res.status(204).end()
})

app.use((error, _, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'PDF file must be smaller than 25 MB.' })
  if (error) return res.status(400).json({ error: error.message || 'Upload failed.' })
  next()
})

const port = Number(process.env.PORT) || 3001
app.listen(port, '0.0.0.0', () => console.log(`Portfolio API running on port ${port}`))
