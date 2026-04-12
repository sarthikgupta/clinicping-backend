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
router.post('/', async (req, res) => {
  const clinicId = req.clinic.id;
  const { patient_id, token_id, type, scheduled_at, appointment_date, appointment_time } = req.body;

  if (!patient_id || !type || !scheduled_at) {
    return res.status(400).json({ error: 'patient_id, type, scheduled_at required' });
  }

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
    .select('name, phone, clinic_address, city')
    .eq('id', clinicId)
    .single();

  const patient = fu.patients;

  if (!patient?.phone || !patient.phone.trim()) {
    return res.status(400).json({ error: 'Patient has no phone number' });
  }

  const doctorName = await getTreatingDoctorName(fu.patient_id, clinicId, clinic?.name || '');
  const clinicPhone = clinic?.phone || '';
  const clinicAddress = clinic?.clinic_address || clinic?.city || '';
  const clinicName = clinic?.name || '';

  let result = { success: false };

  try {
    switch (fu.type) {
      case 'medicine':
        result = await wa.sendMedicineReminder({
          patient, doctorName, clinicPhone, clinicId,
        });
        break;

      case 'appointment': {
        const apptData = safeJSON(fu.message);
        const apptDate = apptData.date
          ? new Date(apptData.date + 'T00:00:00+05:30').toLocaleDateString('en-IN', {
              timeZone: 'Asia/Kolkata',
              day: 'numeric', month: 'long', year: 'numeric'
            })
          : '';
        result = await wa.sendAppointmentReminder({
          patient,
          appointmentDate: apptDate,
          appointmentTime: apptData.time || '',
          doctorName,
          clinicAddress,
          clinicPhone,
          clinicId,
        });
        break;
      }

      case 'lab':
        result = await wa.sendLabReminder({
          patient, doctorName, clinicName, clinicPhone, clinicId,
        });
        break;

      case 'wellness':
        result = await wa.sendWellnessCheck({
          patient, doctorName, clinicPhone, clinicId,
        });
        break;

      default:
        return res.status(400).json({ error: `Unknown follow-up type: ${fu.type}` });
    }

    await supabase
      .from('followups')
      .update({
        status: result.success ? 'sent' : 'failed',
        sent_at: result.success ? new Date().toISOString() : null,
      })
      .eq('id', id);

    console.log(`[Followups] send-now ${fu.type} → ${patient.name} → ${result.success ? '✓' : '✗'}`);
    res.json({ success: result.success, error: result.error });

  } catch (err) {
    console.error('[Followups] send-now crash:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/followups/:id ────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  await supabase
    .from('followups')
    .update({ status: 'cancelled' })
    .eq('id', req.params.id)
    .eq('clinic_id', req.clinic.id);
  res.json({ message: 'Cancelled' });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getTreatingDoctorName(patientId, clinicId, fallback) {
  try {
    const { data: token } = await supabase
      .from('queue_tokens')
      .select('doctor_id')
      .eq('clinic_id', clinicId)
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!token?.doctor_id) return fallback;

    const { data: doctor } = await supabase
      .from('clinic_users')
      .select('name')
      .eq('id', token.doctor_id)
      .single();

    return doctor?.name || fallback;
  } catch {
    return fallback;
  }
}

function safeJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

module.exports = router;
