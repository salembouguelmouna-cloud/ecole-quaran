const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./database');

const app = express();

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: 'quaran-school-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  next();
}

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
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (admin && bcrypt.compareSync(password, admin.password)) {
    req.session.user = { id: admin.id, name: admin.name, role: 'admin', username: admin.username };
    return res.redirect('/admin/dashboard');
  }

  const parent = db.prepare('SELECT * FROM students WHERE parent_username = ?').get(username);
  if (parent && bcrypt.compareSync(password, parent.parent_password)) {
    req.session.user = { id: parent.id, name: parent.parent_name, role: 'parent', studentId: parent.id, studentName: parent.name };
    return res.redirect('/parent/dashboard');
  }

  res.render('login', { error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/admin/dashboard', requireAdmin, (req, res) => {
  const students = db.prepare(`
    SELECT s.*, p.date as last_date, p.presence as last_presence,
           p.memorization as last_memorization, p.revision as last_revision,
           p.behavior as last_behavior, p.notes as last_notes
    FROM students s
    LEFT JOIN (
      SELECT student_id, date, presence, memorization, revision, behavior, notes
      FROM progress
      WHERE id IN (SELECT MAX(id) FROM progress GROUP BY student_id)
    ) p ON s.id = p.student_id
    ORDER BY s.name
  `).all();

  res.render('admin/dashboard', { admin: req.session.user, students });
});

app.get('/admin/students', requireAdmin, (req, res) => {
  const students = db.prepare('SELECT * FROM students ORDER BY name').all();
  res.render('admin/students', { admin: req.session.user, students });
});

app.get('/admin/students/add', requireAdmin, (req, res) => {
  res.render('admin/add-student', { admin: req.session.user, error: null });
});

app.post('/admin/students/add', requireAdmin, (req, res) => {
  const { name, level, parentName, parentUsername, parentPassword } = req.body;

  const existing = db.prepare('SELECT id FROM students WHERE parent_username = ?').get(parentUsername);
  if (existing) {
    return res.render('admin/add-student', { admin: req.session.user, error: 'اسم المستخدم موجود بالفعل' });
  }

  const hashed = bcrypt.hashSync(parentPassword, 10);
  db.prepare('INSERT INTO students (name, level, parent_name, parent_username, parent_password) VALUES (?, ?, ?, ?, ?)')
    .run(name, level || '', parentName, parentUsername, hashed);

  res.redirect('/admin/students');
});

app.get('/admin/students/:id', requireAdmin, (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.redirect('/admin/students');

  const progress = db.prepare('SELECT * FROM progress WHERE student_id = ? ORDER BY date DESC').all(req.params.id);
  res.render('admin/student-detail', { admin: req.session.user, student, progress });
});

app.get('/admin/progress/add/:id', requireAdmin, (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.redirect('/admin/students');
  res.render('admin/add-progress', { admin: req.session.user, student, error: null });
});

app.post('/admin/progress/add/:id', requireAdmin, (req, res) => {
  const { date, presence, memorization, revision, behavior, notes } = req.body;
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.redirect('/admin/students');

  db.prepare('INSERT INTO progress (student_id, date, presence, memorization, revision, behavior, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.params.id, date || new Date().toISOString().split('T')[0], presence === 'on' ? 1 : 0, memorization || '', revision || '', behavior || '', notes || '');

  res.redirect('/admin/students/' + req.params.id);
});

app.get('/admin/progress/edit/:id', requireAdmin, (req, res) => {
  const record = db.prepare('SELECT p.*, s.name as student_name FROM progress p JOIN students s ON p.student_id = s.id WHERE p.id = ?').get(req.params.id);
  if (!record) return res.redirect('/admin/students');
  res.render('admin/edit-progress', { admin: req.session.user, record });
});

app.post('/admin/progress/edit/:id', requireAdmin, (req, res) => {
  const { date, presence, memorization, revision, behavior, notes } = req.body;
  const record = db.prepare('SELECT * FROM progress WHERE id = ?').get(req.params.id);
  if (!record) return res.redirect('/admin/students');

  db.prepare('UPDATE progress SET date=?, presence=?, memorization=?, revision=?, behavior=?, notes=? WHERE id=?')
    .run(date || record.date, presence === 'on' ? 1 : 0, memorization || '', revision || '', behavior || '', notes || '', req.params.id);

  res.redirect('/admin/students/' + record.student_id);
});

app.get('/admin/progress/delete/:id', requireAdmin, (req, res) => {
  const record = db.prepare('SELECT * FROM progress WHERE id = ?').get(req.params.id);
  if (record) {
    const studentId = record.student_id;
    db.prepare('DELETE FROM progress WHERE id = ?').run(req.params.id);
    res.redirect('/admin/students/' + studentId);
  } else {
    res.redirect('/admin/students');
  }
});

app.get('/parent/dashboard', requireAuth, (req, res) => {
  if (req.session.user.role !== 'parent') return res.redirect('/login');

  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.session.user.studentId);
  if (!student) {
    req.session.destroy();
    return res.redirect('/login');
  }

  const progress = db.prepare('SELECT * FROM progress WHERE student_id = ? ORDER BY date DESC LIMIT 30').all(req.session.user.studentId);

  res.render('parent/dashboard', { user: req.session.user, student, progress });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`الخادم يعمل على http://localhost:${PORT}`);
});
