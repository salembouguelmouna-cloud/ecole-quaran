const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const qrcode = require('qrcode');
const path = require('path');
const db = require('./database');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const sess = {
  secret: 'quaran-school-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
};
if (process.env.DATABASE_URL) {
  const PgSession = require('connect-pg-simple')(session);
  sess.store = new PgSession({ conString: process.env.DATABASE_URL, createTableIfMissing: true });
}
app.use(session(sess));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  next();
}

// Express 5 handles async errors natively

app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'admin') return res.redirect('/admin/dashboard');
    return res.redirect('/parent/dashboard');
  }
  res.redirect('/login');
});

app.get('/offline', (req, res) => {
  res.render('offline');
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null, registered: req.query.registered || false });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  const admin = await db.get('SELECT * FROM admins WHERE username = ?', username);
  if (admin && bcrypt.compareSync(password, admin.password)) {
    req.session.user = {
      id: admin.id, name: admin.name, role: 'admin',
      username: admin.username, schoolName: admin.school_name || 'منارة حميم',
      phone: admin.phone || '', logo: admin.logo || ''
    };
    return res.redirect('/admin/dashboard');
  }

  const parent = await db.get('SELECT * FROM students WHERE parent_username = ?', username);
  if (parent && bcrypt.compareSync(password, parent.parent_password)) {
    req.session.user = { id: parent.id, name: parent.parent_name, role: 'parent', studentId: parent.id, studentName: parent.name };
    return res.redirect('/parent/dashboard');
  }

  res.render('login', { error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
});

app.get('/register', (req, res) => {
  res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
  try {
    const { name, username, password, schoolName } = req.body;
    if (!name || !username || !password) {
      return res.render('register', { error: 'يرجى ملء جميع الحقول المطلوبة' });
    }
    const existing = await db.get('SELECT id FROM admins WHERE username = ?', username);
    if (existing) {
      return res.render('register', { error: 'اسم المستخدم موجود بالفعل' });
    }
    const hashed = bcrypt.hashSync(password, 10);
    await db.run('INSERT INTO admins (name, username, password, school_name) VALUES (?, ?, ?, ?)',
      name, username, hashed, schoolName || 'منارة حميم');
    res.redirect('/login?registered=1');
  } catch (err) {
    console.error('Register error:', err);
    res.render('register', { error: 'حدث خطأ أثناء التسجيل' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  const adminId = req.session.user.id;
  const students = await db.all(`
    SELECT s.*, p.date as last_date, p.presence as last_presence,
           p.memorization as last_memorization, p.revision as last_revision,
           p.behavior as last_behavior, p.notes as last_notes
    FROM students s
    LEFT JOIN (
      SELECT student_id, date, presence, memorization, revision, behavior, notes
      FROM progress
      WHERE id IN (SELECT MAX(id) FROM progress GROUP BY student_id)
    ) p ON s.id = p.student_id
    WHERE s.admin_id = ?
    ORDER BY s.name
  `, adminId);

  const allProgress = await db.all('SELECT p.presence FROM progress p JOIN students s ON p.student_id = s.id WHERE s.admin_id = ?', adminId);
  const totalSessions = allProgress.length;
  const presentSessions = allProgress.filter(p => p.presence).length;
  const attendanceRate = totalSessions > 0 ? Math.round(presentSessions / totalSessions * 100) : 0;

  const levels = [...new Set(students.map(s => s.level).filter(Boolean))];
  const recent = await db.get('SELECT p.date FROM progress p JOIN students s ON p.student_id = s.id WHERE s.admin_id = ? ORDER BY p.date DESC LIMIT 1', adminId);

  res.render('admin/dashboard', {
    admin: req.session.user,
    students,
    stats: {
      totalStudents: students.length,
      totalLevels: levels.length,
      attendanceRate,
      totalSessions,
      lastSessionDate: recent ? recent.date : null
    }
  });
});

app.get('/admin/students', requireAdmin, async (req, res) => {
  const students = await db.all('SELECT * FROM students WHERE admin_id = ? ORDER BY name', req.session.user.id);
  res.render('admin/students', { admin: req.session.user, students });
});

app.get('/admin/students/add', requireAdmin, (req, res) => {
  res.render('admin/add-student', { admin: req.session.user, error: null });
});

app.post('/admin/students/add', requireAdmin, upload.single('studentPhoto'), async (req, res) => {
  const { name, level, parentName, parentUsername, parentPassword, parentPhone } = req.body;
  const photo = req.file ? 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64') : '';

  const existing = await db.get('SELECT id FROM students WHERE parent_username = ?', parentUsername);
  if (existing) {
    return res.render('admin/add-student', { admin: req.session.user, error: 'اسم المستخدم موجود بالفعل' });
  }

  const hashed = bcrypt.hashSync(parentPassword, 10);
  await db.run('INSERT INTO students (admin_id, name, level, parent_name, parent_username, parent_password, parent_password_raw, parent_phone, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    req.session.user.id, name, level || '', parentName, parentUsername, hashed, parentPassword, parentPhone || '', photo);

  res.redirect('/admin/students');
});

app.get('/admin/students/edit/:id', requireAdmin, async (req, res) => {
  const student = await db.get('SELECT * FROM students WHERE id = ? AND admin_id = ?', req.params.id, req.session.user.id);
  if (!student) return res.redirect('/admin/students');
  res.render('admin/edit-student', { admin: req.session.user, student, error: null });
});

app.post('/admin/students/edit/:id', requireAdmin, upload.single('studentPhoto'), async (req, res) => {
  const { name, level, parentName, parentUsername, parentPassword, parentPhone } = req.body;
  const student = await db.get('SELECT * FROM students WHERE id = ? AND admin_id = ?', req.params.id, req.session.user.id);
  if (!student) return res.redirect('/admin/students');

  try {
    const photo = req.file ? 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64') : student.photo || '';
    if (parentPassword) {
      const hashed = bcrypt.hashSync(parentPassword, 10);
      await db.run('UPDATE students SET name=?, level=?, parent_name=?, parent_username=?, parent_password=?, parent_password_raw=?, parent_phone=?, photo=? WHERE id=? AND admin_id=?',
        name, level || '', parentName, parentUsername, hashed, parentPassword, parentPhone || '', photo, req.params.id, req.session.user.id);
    } else {
      await db.run('UPDATE students SET name=?, level=?, parent_name=?, parent_username=?, parent_phone=?, photo=? WHERE id=? AND admin_id=?',
        name, level || '', parentName, parentUsername, parentPhone || '', photo, req.params.id, req.session.user.id);
    }
    res.redirect('/admin/students/' + req.params.id);
  } catch (err) {
    console.error('Error editing student:', err);
    res.render('admin/edit-student', { admin: req.session.user, student, error: 'حدث خطأ أثناء التعديل' });
  }
});

app.get('/admin/students/delete/:id', requireAdmin, async (req, res) => {
  const student = await db.get('SELECT * FROM students WHERE id = ? AND admin_id = ?', req.params.id, req.session.user.id);
  if (!student) return res.redirect('/admin/students');
  await db.run('DELETE FROM progress WHERE student_id = ?', req.params.id);
  await db.run('DELETE FROM students WHERE id = ?', req.params.id);
  res.redirect('/admin/students');
});

app.get('/admin/students/:id', requireAdmin, async (req, res) => {
  const student = await db.get('SELECT * FROM students WHERE id = ? AND admin_id = ?', req.params.id, req.session.user.id);
  if (!student) return res.redirect('/admin/students');

  const progress = await db.all('SELECT * FROM progress WHERE student_id = ? ORDER BY date DESC', req.params.id);
  res.render('admin/student-detail', { admin: req.session.user, student, progress });
});

app.get('/admin/progress/add/:id', requireAdmin, async (req, res) => {
  const student = await db.get('SELECT * FROM students WHERE id = ? AND admin_id = ?', req.params.id, req.session.user.id);
  if (!student) return res.redirect('/admin/students');
  res.render('admin/add-progress', { admin: req.session.user, student, error: null });
});

app.post('/admin/progress/add/:id', requireAdmin, async (req, res) => {
  try {
    const { date, presence, memorization, revision, behavior, notes } = req.body;
    const student = await db.get('SELECT * FROM students WHERE id = ? AND admin_id = ?', req.params.id, req.session.user.id);
    if (!student) return res.redirect('/admin/students');

    await db.run('INSERT INTO progress (student_id, date, presence, memorization, revision, behavior, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      req.params.id, date || new Date().toISOString().split('T')[0], presence === 'on' ? 1 : 0, memorization || '', revision || '', behavior || '', notes || '');

    res.redirect('/admin/students/' + req.params.id);
  } catch (err) {
    console.error('Error adding progress:', err);
    res.status(500).send('Erreur lors de l\'ajout de la séance');
  }
});

app.get('/admin/progress/edit/:id', requireAdmin, async (req, res) => {
  const record = await db.get('SELECT p.*, s.name as student_name FROM progress p JOIN students s ON p.student_id = s.id WHERE p.id = ? AND s.admin_id = ?', req.params.id, req.session.user.id);
  if (!record) return res.redirect('/admin/students');
  res.render('admin/edit-progress', { admin: req.session.user, record });
});

app.post('/admin/progress/edit/:id', requireAdmin, async (req, res) => {
  try {
    const { date, presence, memorization, revision, behavior, notes } = req.body;
    const record = await db.get('SELECT p.* FROM progress p JOIN students s ON p.student_id = s.id WHERE p.id = ? AND s.admin_id = ?', req.params.id, req.session.user.id);
    if (!record) return res.redirect('/admin/students');

    await db.run('UPDATE progress SET date=?, presence=?, memorization=?, revision=?, behavior=?, notes=? WHERE id=?',
      date || record.date, presence === 'on' ? 1 : 0, memorization || '', revision || '', behavior || '', notes || '', req.params.id);

    res.redirect('/admin/students/' + record.student_id);
  } catch (err) {
    console.error('Error editing progress:', err);
    res.status(500).send('Erreur lors de la modification de la séance');
  }
});

app.get('/admin/progress/delete/:id', requireAdmin, async (req, res) => {
  const record = await db.get('SELECT p.* FROM progress p JOIN students s ON p.student_id = s.id WHERE p.id = ? AND s.admin_id = ?', req.params.id, req.session.user.id);
  if (record) {
    const studentId = record.student_id;
    await db.run('DELETE FROM progress WHERE id = ?', req.params.id);
    res.redirect('/admin/students/' + studentId);
  } else {
    res.redirect('/admin/students');
  }
});

app.get('/admin/settings', requireAdmin, async (req, res) => {
  const admin = await db.get('SELECT * FROM admins WHERE id = ?', req.session.user.id);
  res.render('admin/settings', { admin: req.session.user, profile: admin, error: null, success: null });
});

app.post('/admin/settings', requireAdmin, async (req, res) => {
  const { phone } = req.body;
  await db.run('UPDATE admins SET phone = ? WHERE id = ?', phone || '', req.session.user.id);
  req.session.user.phone = phone || '';
  const admin = await db.get('SELECT * FROM admins WHERE id = ?', req.session.user.id);
  res.render('admin/settings', { admin: req.session.user, profile: admin, error: null, success: 'تم حفظ الإعدادات' });
});

app.post('/admin/upload-logo', requireAdmin, upload.single('logo'), async (req, res) => {
  if (req.file) {
    const logoData = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
    await db.run('UPDATE admins SET logo = ? WHERE id = ?', logoData, req.session.user.id);
    req.session.user.logo = logoData;
  }
  res.redirect('/admin/settings');
});

app.get('/admin/card/:id', requireAdmin, async (req, res) => {
  const student = await db.get('SELECT * FROM students WHERE id = ? AND admin_id = ?', req.params.id, req.session.user.id);
  if (!student) return res.redirect('/admin/students');
  const adminInfo = await db.get('SELECT * FROM admins WHERE id = ?', req.session.user.id);
  const baseUrl = process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'));
  const loginUrl = baseUrl + '/login';
  const qrSvg = await qrcode.toString(loginUrl, { type: 'svg', margin: 0, width: 160, color: { dark: '#047857' } });
  res.render('admin/card', { admin: req.session.user, student, adminInfo, qrSvg });
});

app.get('/admin/qrcode/:id', requireAdmin, async (req, res) => {
  const student = await db.get('SELECT * FROM students WHERE id = ? AND admin_id = ?', req.params.id, req.session.user.id);
  if (!student) return res.redirect('/admin/students');
  const baseUrl = process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'));
  const url = baseUrl + '/login';
  try {
    const svg = await qrcode.toString(url, { type: 'svg', margin: 1, width: 300, color: { dark: '#047857' } });
    const html = `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>QR - ${student.name}</title><script>tailwind.config={darkMode:"class"};if(localStorage.getItem("dark")==="true")document.documentElement.classList.add("dark");</script><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-50 dark:bg-gray-900 min-h-screen flex items-center justify-center p-8"><div class="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8 text-center max-w-sm"><div class="text-3xl mb-4">🕌</div><h1 class="text-xl font-bold text-gray-800 dark:text-white mb-2">${student.name}</h1><p class="text-gray-500 dark:text-gray-400 text-sm mb-4">${student.level || ''}</p>${svg}<p class="text-gray-400 text-xs mt-4">امسح الرمز للوصول إلى منصة التتبع</p><p class="text-gray-500 text-xs mt-2">ثم أدخل اسم المستخدم وكلمة المرور</p></div></body></html>`;
    res.send(html);
  } catch (e) {
    res.status(500).send('خطأ في إنشاء الرمز');
  }
});

app.get('/admin/export/csv', requireAdmin, async (req, res) => {
  const students = await db.all('SELECT * FROM students WHERE admin_id = ? ORDER BY name', req.session.user.id);
  const baseUrl = process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'));
  const rows = [['الاسم', 'السورة', 'ولي الأمر', 'رقم الهاتف', 'اسم المستخدم', 'رابط الدخول']];
  students.forEach(s => rows.push([s.name, s.level, s.parent_name, s.parent_phone || '', s.parent_username, baseUrl + '/login']));

  const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
  const bom = '\uFEFF';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=students.csv');
  res.send(bom + csv);
});

app.get('/admin/ranking', requireAdmin, async (req, res) => {
  const students = await db.all(`
    SELECT s.*,
      (SELECT COUNT(*) FROM progress WHERE student_id = s.id) as session_count,
      (SELECT COUNT(*) FROM progress WHERE student_id = s.id AND presence = 1) as present_count,
      (SELECT COUNT(*) FROM progress WHERE student_id = s.id AND memorization != '') as memorization_count
    FROM students s WHERE s.admin_id = ?
    ORDER BY session_count DESC, present_count DESC
  `, req.session.user.id);
  res.render('admin/ranking', { admin: req.session.user, students });
});

app.get('/admin/calendar', requireAdmin, async (req, res) => {
  const adminId = req.session.user.id;
  const concatFn = db.isPG ? "STRING_AGG(s.name, '、')" : "GROUP_CONCAT(s.name, '、')";
  const sessions = await db.all(`
    SELECT p.date,
      SUM(CASE WHEN p.presence = 1 THEN 1 ELSE 0 END) as present,
      COUNT(*) as total,
      ${concatFn} as students
    FROM progress p JOIN students s ON p.student_id = s.id
    WHERE s.admin_id = ?
    GROUP BY p.date ORDER BY p.date DESC LIMIT 90
  `, adminId);
  const months = {};
  sessions.forEach(s => {
    const m = s.date.substring(0, 7);
    if (!months[m]) months[m] = [];
    months[m].push(s);
  });
  res.render('admin/calendar', { admin: req.session.user, months, sessions });
});

app.get('/admin/pdf/:id', requireAdmin, async (req, res) => {
  const PDFDocument = require('pdfkit');
  const student = await db.get('SELECT * FROM students WHERE id = ? AND admin_id = ?', req.params.id, req.session.user.id);
  if (!student) return res.redirect('/admin/students');
  const adminInfo = await db.get('SELECT * FROM admins WHERE id = ?', req.session.user.id);
  const progress = await db.all('SELECT * FROM progress WHERE student_id = ? ORDER BY date DESC', req.params.id);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${student.name}.pdf"`);
  doc.pipe(res);

  const schoolName = adminInfo.school_name || 'منارة حميم';
  doc.fontSize(24).font('Helvetica-Bold').text(schoolName, { align: 'center' });
  doc.fontSize(14).font('Helvetica').text('تقرير متابعة التلميذ', { align: 'center' });
  doc.moveDown();
  doc.fontSize(16).font('Helvetica-Bold').text(`الاسم: ${student.name}`, { align: 'right' });
  doc.fontSize(12).font('Helvetica').text(`السورة: ${student.level || '-'}`, { align: 'right' });
  doc.text(`ولي الأمر: ${student.parent_name}`, { align: 'right' });
  if (student.parent_phone) doc.text(`الهاتف: ${student.parent_phone}`, { align: 'right' });
  if (adminInfo.phone) doc.text(`هاتف الأستاذ: ${adminInfo.phone}`, { align: 'right' });

  doc.moveDown();
  doc.fontSize(14).font('Helvetica-Bold').text('سجل الحصص', { align: 'right' });
  doc.moveDown(0.5);

  const startX = 50, startY = doc.y;
  doc.fontSize(10).font('Helvetica-Bold');
  const cols = [120, 60, 150, 150, 80];
  const headers = ['التاريخ', 'الحضور', 'الحفظ', 'المراجعة', 'السلوك'];
  let x = doc.page.width - 50;
  headers.forEach((h, i) => { x -= cols[i]; doc.text(h, x, startY, { width: cols[i], align: 'right' }); });

  doc.moveDown(0.5);
  let y = doc.y;
  doc.fontSize(9).font('Helvetica');
  progress.forEach(p => {
    if (y > 700) { doc.addPage(); y = 50; }
    x = doc.page.width - 50;
    const vals = [p.date, p.presence ? 'حاضر' : 'غائب', p.memorization || '-', p.revision || '-', p.behavior || '-'];
    vals.forEach((v, i) => { x -= cols[i]; doc.text(v, x, y, { width: cols[i], align: 'right' }); });
    y += 18;
  });

  doc.end();
});

app.get('/parent/dashboard', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'parent') return res.redirect('/login');

  const student = await db.get('SELECT * FROM students WHERE id = ?', req.session.user.studentId);
  if (!student) {
    req.session.destroy();
    return res.redirect('/login');
  }

  const admin = await db.get('SELECT name, phone, school_name, logo FROM admins WHERE id = ?', student.admin_id);
  const progress = await db.all('SELECT * FROM progress WHERE student_id = ? ORDER BY date DESC LIMIT 30', req.session.user.studentId);

  res.render('parent/dashboard', { user: req.session.user, student, progress, admin });
});

const PORT = process.env.PORT || 3000;
db.ready.then(() => {
  app.listen(PORT, () => {
    console.log(`الخادم يعمل على http://localhost:${PORT}`);
  });
});