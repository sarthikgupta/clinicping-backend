const axios = require('axios');
const supabase = require('../db/supabase');

const INTERAKT_BASE = 'https://api.interakt.ai/v1/public/message/';

const TEMPLATES = {
  token_assigned:       { name: 'clinicping_token_assigned' },
  call_in:              { name: 'clinicping_call_in' },
  medicine_reminder:    { name: 'clinicping_medicine_reminder' },
  appointment_reminder: { name: 'clinicping_appointment_reminder' },
  lab_reminder:         { name: 'clinicping_lab_reminder' },
  wellness_check:       { name: 'clinicping_wellness_chk' },
  prescription:         { name: 'clinicping_prescription' },
};

// ── Core send function ────────────────────────────────────────────────────────
async function sendWhatsAppTemplate(phone, templateName, params, clinicId) {
  const formattedPhone = formatPhone(phone);

  const payload = {
    countryCode: '+91',
    phoneNumber: formattedPhone,
    callbackData: `clinicping_${clinicId}`,
    type: 'Template',
    template: {
      name: templateName,
      languageCode: 'hi',
      bodyValues: params,
    },
  };

  try {
    const response = await axios.post(INTERAKT_BASE, payload, {
      headers: {
        Authorization: `Basic ${process.env.INTERAKT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 8000,
    });

    await supabase.from('whatsapp_logs').insert({
      clinic_id: clinicId,
      patient_phone: formattedPhone,
      message_type: templateName,
      message_body: JSON.stringify(params),
      interakt_message_id: response.data?.id || null,
      status: 'sent',
    });

    return { success: true, messageId: response.data?.id };
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error('WhatsApp send error:', errMsg);

    await supabase.from('whatsapp_logs').insert({
      clinic_id: clinicId,
      patient_phone: formattedPhone,
      message_type: templateName,
      message_body: JSON.stringify(params),
      status: 'failed',
    });

    return { success: false, error: errMsg };
  }
}

// ── Specific message senders ──────────────────────────────────────────────────

async function sendTokenAssigned({ patient, tokenNumber, waitMinutes, clinicName, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, TEMPLATES.token_assigned.name,
    [patient.name, String(tokenNumber), String(waitMinutes), clinicName], clinicId);
}

async function sendCallIn({ patient, doctorName, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, TEMPLATES.call_in.name,
    [patient.name, doctorName], clinicId);
}

async function sendMedicineReminder({ patient, doctorName, clinicPhone, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, TEMPLATES.medicine_reminder.name,
    [patient.name, doctorName, clinicPhone], clinicId);
}

async function sendAppointmentReminder({ patient, appointmentDate, appointmentTime, doctorName, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, TEMPLATES.appointment_reminder.name,
    [patient.name, appointmentDate, appointmentTime, doctorName], clinicId);
}

async function sendLabReminder({ patient, doctorName, clinicName, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, TEMPLATES.lab_reminder.name,
    [patient.name, doctorName, clinicName], clinicId);
}

async function sendWellnessCheck({ patient, doctorName, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, TEMPLATES.wellness_check.name,
    [patient.name, doctorName], clinicId);
}

// ── Prescription sender ───────────────────────────────────────────────────────
async function sendPrescription({ patient, consultation, doctorName, clinicPhone, clinicId }) {
  if (!patient.phone || !patient.phone.trim()) {
    return { success: false, error: 'No phone number' };
  }

  const date = new Date().toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric'
  });

  // Format medicines
  const DOSE_MAP = {
    'morning': 'Subah',
    'afternoon': 'Dopahar',
    'evening': 'Shaam',
    'night': 'Raat',
  };

  const meds = (consultation.medicines || [])
    .filter(m => m.name)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const medsText = meds.length > 0
    ? meds.map((m, i) => {
        const doseStr = m.dose || '';
        const durStr = m.duration ? `(${m.duration})` : '';
        return `${i + 1}. ${m.name} — ${doseStr} ${durStr}`.trim();
      }).join(' | ')
    : 'Doctor se poochhen';

  // Format tests
  const tests = (consultation.tests_ordered || []).map(t => t.name).filter(Boolean);
  const testsText = tests.length > 0 ? tests.join(', ') : 'Koi nahi';

  // Format next appointment
  let apptText = 'Zaroorat padne par aayein';
  if (consultation.next_appointment_date) {
    const apptDate = new Date(consultation.next_appointment_date).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
    const apptTime = consultation.next_appointment_time
      ? `, ${consultation.next_appointment_time}`
      : '';
    const apptNote = consultation.next_appointment_note
      ? ` (${consultation.next_appointment_note})`
      : '';
    apptText = `${apptDate}${apptTime}${apptNote}`;
  }

  const diagnosis = consultation.diagnosis || consultation.symptoms || 'General checkup';
  const firstName = patient.name.split(' ')[0];

  return sendWhatsAppTemplate(
    patient.phone,
    TEMPLATES.prescription.name,
    [
      firstName,           // {{1}} patient name
      doctorName,          // {{2}} doctor name
      date,                // {{3}} date
      diagnosis,           // {{4}} diagnosis
      medsText,            // {{5}} medicines
      testsText,           // {{6}} tests
      apptText,            // {{7}} next appointment
      clinicPhone || '',   // {{8}} clinic phone
    ],
    clinicId
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatPhone(phone) {
  return phone.replace(/[\s\-\+]/g, '').replace(/^91/, '');
}

function estimateWaitTime(position, avgConsultMinutes = 10) {
  return position * avgConsultMinutes;
}

module.exports = {
  sendTokenAssigned,
  sendCallIn,
  sendMedicineReminder,
  sendAppointmentReminder,
  sendLabReminder,
  sendWellnessCheck,
  sendPrescription,
  estimateWaitTime,
  TEMPLATES,
};
