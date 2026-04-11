const cron = require('node-cron');
const supabase = require('../db/supabase');
const wa = require('./whatsapp');

function startFollowUpScheduler() {
  cron.schedule('*/5 * * * *', async () => {
    console.log('[Scheduler] Checking pending follow-ups...');

    const now = new Date().toISOString();

    const { data: followups, error } = await supabase
      .from('followups')
      .select(`
        *,
        patients (id, name, phone),
        clinics (id, name, phone, clinic_address, city)
      `)
      .eq('status', 'pending')
      .lte('scheduled_at', now)
      .limit(50);

    if (error) {
      console.error('[Scheduler] Error fetching follow-ups:', error);
      return;
    }

    if (!followups || followups.length === 0) {
      console.log('[Scheduler] No follow-ups due.');
      return;
    }

    console.log(`[Scheduler] Sending ${followups.length} follow-up(s)...`);

    for (const fu of followups) {
      const patient = fu.patients;
      const clinic = fu.clinics;
      if (!patient || !clinic) continue;
      if (!patient.phone || !patient.phone.trim()) {
        // No phone — mark as failed silently
        await supabase.from('followups').update({ status: 'failed' }).eq('id', fu.id);
        continue;
      }

      let result = { success: false };

      try {
        // ── Get actual treating doctor for this patient ────────────────────
        const doctorName = await getTreatingDoctorName(fu.patient_id, fu.clinic_id, clinic.name);
        const clinicAddress = clinic.clinic_address || clinic.city || '';
        const clinicPhone = clinic.phone || '';

        switch (fu.type) {
          case 'medicine':
            result = await wa.sendMedicineReminder({
              patient,
              doctorName,
              clinicPhone,
              clinicId: clinic.id,
            });
            break;

          case 'appointment': {
            const apptData = safeParseJSON(fu.message);
            const apptDate = apptData.date
              ? new Date(apptData.date).toLocaleDateString('en-IN', {
                  timeZone: 'Asia/Kolkata',
                  day: 'numeric', month: 'long', year: 'numeric'
                })
              : formatDate(fu.scheduled_at);
            const apptTime = apptData.time || '10:00 AM';

            result = await wa.sendAppointmentReminder({
              patient,
              appointmentDate: apptDate,
              appointmentTime: apptTime,
              doctorName,
              clinicAddress,
              clinicPhone,
              clinicId: clinic.id,
            });
            break;
          }

          case 'lab':
            result = await wa.sendLabReminder({
              patient,
              doctorName,
              clinicName: clinic.name,
              clinicPhone,
              clinicId: clinic.id,
            });
            break;

          case 'wellness':
            result = await wa.sendWellnessCheck({
              patient,
              doctorName,
              clinicId: clinic.id,
            });
            break;
        }

        await supabase
          .from('followups')
          .update({
            status: result.success ? 'sent' : 'failed',
            sent_at: result.success ? now : null,
          })
          .eq('id', fu.id);

        console.log(`[Scheduler] Follow-up ${fu.id} (${fu.type}) → ${result.success ? 'sent ✓' : 'failed ✗'}`);

      } catch (err) {
        console.error(`[Scheduler] Failed to send follow-up ${fu.id}:`, err.message);
        await supabase.from('followups').update({ status: 'failed' }).eq('id', fu.id);
      }
    }
  });

  console.log('[Scheduler] Follow-up scheduler started (every 5 min)');
}

// ── Get the actual doctor who treated this patient ────────────────────────────
async function getTreatingDoctorName(patientId, clinicId, fallbackName) {
  try {
    // Find most recent queue token for this patient → get doctor_id
    const { data: token } = await supabase
      .from('queue_tokens')
      .select('doctor_id')
      .eq('clinic_id', clinicId)
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!token?.doctor_id) return fallbackName;

    // Fetch doctor name from clinic_users
    const { data: doctor } = await supabase
      .from('clinic_users')
      .select('name')
      .eq('id', token.doctor_id)
      .single();

    return doctor?.name || fallbackName;
  } catch {
    return fallbackName;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

function formatDate(dateStr) {
  if (!dateStr) return 'scheduled date';
  return new Date(dateStr).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

module.exports = { startFollowUpScheduler };
