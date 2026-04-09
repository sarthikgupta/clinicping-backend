const router = require('express').Router();
const supabase = require('../db/supabase');
const wa = require('../services/whatsapp');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// ── GET /api/followups ───────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const clinicId = req.clinic.id;
  const { status = 'pending' } = req.query;

  const { data, error } = await supabase
    .from('followups')
    .select(`*, patients(id, name, phone)`)
    .eq('clinic_id', clinicId)
    .eq('status', status)
    .order('scheduled_at', { ascending: true })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/followups ──────────────────────────────────────────────────────
// Schedule a follow-up
router.post('/', async (req, res) => {
  const clinicId = req.clinic.id;
  const { patient_id, token_id, type, scheduled_at, appointment_date, appointment_time } = req.body;

  if (!patient_id || !type || !scheduled_at) {
    return res.status(400).json({ error: 'patient_id, type, scheduled_at required' });
  }

  // Build message content (stored for reference/custom types)
  let message = type;
  if (type === 'appointment' && appointment_date) {
    message = JSON.stringify({ date: appointment_date, time: appointment_time || '' });
  }

  const { data, error } = await supabase
    .from('followups')
    .insert({
      clinic_id: clinicId,
      patient_id,
      token_id: token_id || null,
      type,
      message,
      scheduled_at,
      status: 'pending',
    })
    .select(`*, patients(id, name, phone)`)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ── POST /api/followups/:id/send-now ─────────────────────────────────────────
// Send immediately instead of waiting for scheduler
router.post('/:id/send-now', async (req, res) => {
  const clinicId = req.clinic.id;
  const { id } = req.params;

  const { data: fu, error } = await supabase
    .from('followups')
    .select(`*, patients(id, name, phone)`)
    .eq('id', id)
    .eq('clinic_id', clinicId)
    .single();

  if (error || !fu) return res.status(404).json({ error: 'Follow-up not found' });

  const { data: clinic } = await supabase
    .from('clinics')
    .select('doctor_name, name, phone')
    .eq('id', clinicId)
    .single();

  const patient = fu.patients;
  let result = { success: false };

  try {
    switch (fu.type) {
      case 'medicine':
        result = await wa.sendMedicineReminder({ patient, doctorName: clinic.doctor_name, clinicPhone: clinic.phone, clinicId });
        break;
      case 'appointment':
        const d = safeJSON(fu.message);
        result = await wa.sendAppointmentReminder({ patient, appointmentDate: d.date || '', appointmentTime: d.time || '', doctorName: clinic.doctor_name, clinicId });
        break;
      case 'lab':
        result = await wa.sendLabReminder({ patient, doctorName: clinic.doctor_name, clinicName: clinic.name, clinicId });
        break;
      case 'wellness':
        result = await wa.sendWellnessCheck({ patient, doctorName: clinic.doctor_name, clinicId });
        break;
    }

    await supabase
      .from('followups')
      .update({ status: result.success ? 'sent' : 'failed', sent_at: result.success ? new Date().toISOString() : null })
      .eq('id', id);

    res.json({ success: result.success, followup: fu });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/followups/:id ────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  await supabase.from('followups').update({ status: 'cancelled' }).eq('id', req.params.id).eq('clinic_id', req.clinic.id);
  res.json({ message: 'Cancelled' });
});

function safeJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

module.exports = router;
