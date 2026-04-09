const router = require('express').Router();
const supabase = require('../db/supabase');
const bcrypt = require('bcryptjs');
const { authMiddleware: auth } = require('../middleware/auth');

router.use(auth);

// ── GET /api/settings ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('clinics')
    .select('name, doctor_name, doctor_qualification, doctor_registration, phone, email, city, clinic_address, clinic_timings, rx_template, rx_color, rx_footer_note')
    .eq('id', req.clinic.id)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PATCH /api/settings ───────────────────────────────────────────────────────
// Admin only — update clinic settings
router.patch('/', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const allowed = ['name', 'doctor_name', 'doctor_qualification', 'doctor_registration', 'phone', 'city', 'clinic_address', 'clinic_timings', 'rx_template', 'rx_color', 'rx_footer_note'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

  const { data, error } = await supabase
    .from('clinics')
    .update(updates)
    .eq('id', req.clinic.id)
    .select('name, doctor_name, doctor_qualification, doctor_registration, phone, email, city, clinic_address, clinic_timings, rx_template, rx_color, rx_footer_note')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/settings/profile ─────────────────────────────────────────────────
// Get current user's own profile (all roles)
router.get('/profile', async (req, res) => {
  const { data, error } = await supabase
    .from('clinic_users')
    .select('id, name, email, role, qualification, registration_no, speciality')
    .eq('id', req.user.id)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PATCH /api/settings/profile ───────────────────────────────────────────────
// Update own display name, qualification etc (all roles)
router.patch('/profile', async (req, res) => {
  const { name, qualification, registration_no, speciality } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const updates = { name: name.trim() };
  if (qualification !== undefined) updates.qualification = qualification;
  if (registration_no !== undefined) updates.registration_no = registration_no;
  if (speciality !== undefined) updates.speciality = speciality;

  const { data, error } = await supabase
    .from('clinic_users')
    .update(updates)
    .eq('id', req.user.id)
    .select('id, name, email, role, qualification, registration_no, speciality')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/settings/change-password ───────────────────────────────────────
// Change own password (all roles)
router.post('/change-password', async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  try {
    // Get current password hash
    const { data: user, error } = await supabase
      .from('clinic_users')
      .select('password_hash')
      .eq('id', req.user.id)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });

    // Verify current password
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

    // Hash and save new password
    const password_hash = await bcrypt.hash(new_password, 12);
    await supabase
      .from('clinic_users')
      .update({ password_hash })
      .eq('id', req.user.id);

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ── PATCH /api/settings/users/:id ────────────────────────────────────────────
// Admin edits any user's details
router.patch('/users/:id', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { name, qualification, registration_no, speciality, is_active } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (qualification !== undefined) updates.qualification = qualification;
  if (registration_no !== undefined) updates.registration_no = registration_no;
  if (speciality !== undefined) updates.speciality = speciality;
  if (is_active !== undefined) updates.is_active = is_active;

  const { data, error } = await supabase
    .from('clinic_users')
    .update(updates)
    .eq('id', req.params.id)
    .eq('clinic_id', req.clinic.id)
    .select('id, name, email, role, qualification, registration_no, speciality, is_active')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/settings/users/:id/reset-password ──────────────────────────────
// Admin resets another user's password
router.post('/users/:id/reset-password', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const password_hash = await bcrypt.hash(new_password, 12);
    await supabase
      .from('clinic_users')
      .update({ password_hash })
      .eq('id', req.params.id)
      .eq('clinic_id', req.clinic.id);

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
