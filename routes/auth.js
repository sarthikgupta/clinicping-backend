const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const supabase = require('../db/supabase');

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
// Creates a clinic + the first admin user
router.post('/signup', [
  body('clinic_name').trim().notEmpty().withMessage('Clinic name required'),
  body('name').trim().notEmpty().withMessage('Your name required'),
  body('email').isEmail().withMessage('Valid email required'),
  body('phone').trim().notEmpty().withMessage('Phone required'),
  body('password').isLength({ min: 6 }).withMessage('Password min 6 chars'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { clinic_name, name, email, phone, password, city } = req.body;

  try {
    // Check duplicate email in clinic_users
    const { data: existing } = await supabase
      .from('clinic_users')
      .select('id')
      .eq('email', email)
      .single();
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    // Create clinic
    const { data: clinic, error: cErr } = await supabase
      .from('clinics')
      .insert({ name: clinic_name, doctor_name: name, email, phone, password_hash: 'managed_by_users', city: city || '' })
      .select('id, name')
      .single();
    if (cErr) throw cErr;

    // Create first admin user
    const password_hash = await bcrypt.hash(password, 12);
    const { data: user, error: uErr } = await supabase
      .from('clinic_users')
      .insert({ clinic_id: clinic.id, name, email, password_hash, role: 'admin' })
      .select('id, name, email, role, clinic_id')
      .single();
    if (uErr) throw uErr;

    const token = makeToken(user, clinic);
    res.status(201).json({ token, user: safeUser(user), clinic });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', [
  body('email').isEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;

  try {
    const { data: user, error } = await supabase
      .from('clinic_users')
      .select('*, clinics(id, name, rx_template, rx_color, doctor_name, phone, clinic_address, clinic_timings, rx_footer_note, doctor_qualification, doctor_registration)')
      .eq('email', email)
      .eq('is_active', true)
      .single();

    if (error || !user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const clinic = user.clinics;
    const token = makeToken(user, clinic);
    res.json({ token, user: safeUser(user), clinic });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /api/auth/users ──────────────────────────────────────────────────────
// Admin creates a new user (doctor or receptionist) for their clinic
router.post('/users', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });

  let decoded;
  try { decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }

  if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { name, email, password, role, qualification, registration_no, speciality } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'name, email, password, role required' });

  try {
    const { data: existing } = await supabase.from('clinic_users').select('id').eq('email', email).single();
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    const password_hash = await bcrypt.hash(password, 12);
    const { data: user, error } = await supabase
      .from('clinic_users')
      .insert({ clinic_id: decoded.clinic_id, name, email, password_hash, role, qualification: qualification || '', registration_no: registration_no || '', speciality: speciality || '' })
      .select('id, name, email, role, qualification, registration_no, speciality, is_active, created_at')
      .single();

    if (error) throw error;
    res.status(201).json(user);
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ── GET /api/auth/users ───────────────────────────────────────────────────────
// Get all users in the clinic (admin only)
router.get('/users', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });

  let decoded;
  try { decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }

  const { data, error } = await supabase
    .from('clinic_users')
    .select('id, name, email, role, qualification, registration_no, speciality, is_active, created_at')
    .eq('clinic_id', decoded.clinic_id)
    .order('role')
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PATCH /api/auth/users/:id ─────────────────────────────────────────────────
router.patch('/users/:id', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });

  let decoded;
  try { decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }

  if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { name, qualification, registration_no, speciality, is_active } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (qualification !== undefined) updates.qualification = qualification;
  if (registration_no !== undefined) updates.registration_no = registration_no;
  if (speciality !== undefined) updates.speciality = speciality;
  if (is_active !== undefined) updates.is_active = is_active;

  const { data, error } = await supabase
    .from('clinic_users')
    .update(updates)
    .eq('id', req.params.id)
    .eq('clinic_id', decoded.clinic_id)
    .select('id, name, email, role, qualification, registration_no, speciality, is_active')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeToken(user, clinic) {
  return jwt.sign(
    {
      user_id: user.id,
      clinic_id: user.clinic_id,
      role: user.role,
      name: user.name,
      email: user.email,
    },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function safeUser(user) {
  const { password_hash, clinics, ...safe } = user;
  return safe;
}

module.exports = router;
