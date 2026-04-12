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

// ── Core send ─────────────────────────────────────────────────────────────────
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
      bodyValues: params.map(p => clean(p)),
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

    try {
      await supabase.from('whatsapp_logs').insert({
        clinic_id: clinicId,
        patient_phone: formattedPhone,
        message_type: templateName,
        message_body: JSON.stringify(params),
        status: 'sent',
      });
    } catch (_) {}

    console.log(`[WhatsApp] ${templateName} → ${formattedPhone} ✓`);
    return { success: true };
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error(`[WhatsApp] ${templateName} failed:`, JSON.stringify(errMsg));

    try {
      await supabase.from('whatsapp_logs').insert({
        clinic_id: clinicId,
        patient_phone: formattedPhone,
        message_type: templateName,
        message_body: JSON.stringify(params),
        status: 'failed',
      });
    } catch (_) {}

    return { success: false, error: errMsg };
  }
}

// ── Template senders ──────────────────────────────────────────────────────────

// {{1}} name, {{2}} token, {{3}} wait minutes, {{4}} clinic name
async function sendTokenAssigned({ patient, tokenNumber, waitMinutes, clinicName, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, TEMPLATES.token_assigned.name, [
    firstName(patient.name),
    String(tokenNumber),
    String(waitMinutes),
    clinicName,
  ], clinicId);
}

// {{1}} name, {{2}} doctor name
async function sendCallIn({ patient, doctorName, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, TEMPLATES.call_in.name, [
    firstName(patient.name),
    doctorName,
  ], clinicId);
}

// {{1}} name, {{2}} doctor name, {{3}} clinic phone
async function sendMedicineReminder({ patient, doctorName, clinicPhone, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, TEMPLATES.medicine_reminder.name, [
    firstName(patient.name),
    doctorName,
    clinicPhone || '',
  ], clinicId);
}

// {{1}} name, {{2}} date, {{3}} time (Hindi), {{4}} doctor, {{5}} address, {{6}} phone
async function sendAppointmentReminder({ patient, appointmentDate, appointmentTime, doctorName, clinicAddress, clinicPhone, clinicId }) {
  const hindiTime = toHindiTime(appointmentTime);
  return sendWhatsAppTemplate(patient.phone, TEMPLATES.appointment_reminder.name, [
    firstName(patient.name),
    appointmentDate || '',
    hindiTime,
    doctorName || '',
    clinicAddress || '',
    clinicPhone || '',
  ], clinicId);
}

// {{1}} name, {{2}} doctor name, {{3}} clinic name, {{4}} clinic phone
async function sendLabReminder({ patient, doctorName, clinicName, clinicPhone, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, TEMPLATES.lab_reminder.name, [
    firstName(patient.name),
    doctorName || '',
    clinicName || '',
    clinicPhone || '',
  ], clinicId);
}

// {{1}} name, {{2}} doctor name, {{3}} clinic phone
async function sendWellnessCheck({ patient, doctorName, clinicPhone, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, TEMPLATES.wellness_check.name, [
    firstName(patient.name),
    doctorName || '',
    clinicPhone || '',
  ], clinicId);
}

// Prescription slip
async function sendPrescription({ patient, consultation, doctorName, clinicPhone, clinicId }) {
  if (!patient.phone || !patient.phone.trim()) return { success: false };

  const date = new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric'
  });

  const meds = (consultation.medicines || [])
    .filter(m => m.name)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const medsText = meds.length > 0
    ? meds.map((m, i) => `${i + 1}. ${m.name} — ${m.dose || ''} ${m.duration ? '(' + m.duration + ')' : ''}`.trim()).join(' | ')
    : 'Doctor se poochhen';

  const tests = (consultation.tests_ordered || []).map(t => t.name).filter(Boolean);
  const testsText = tests.length > 0 ? tests.join(', ') : 'Koi nahi';

  let apptText = 'Zaroorat padne par aayein';
  if (consultation.next_appointment_date) {
    const apptDate = new Date(consultation.next_appointment_date).toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric', month: 'long', year: 'numeric'
    });
    const apptTime = consultation.next_appointment_time
      ? ` — ${toHindiTime(consultation.next_appointment_time)}`
      : '';
    apptText = `${apptDate}${apptTime}`;
  }

  const diagnosis = consultation.diagnosis || consultation.symptoms || 'General checkup';

  return sendWhatsAppTemplate(patient.phone, TEMPLATES.prescription.name, [
    firstName(patient.name),
    doctorName || '',
    date,
    diagnosis,
    medsText,
    testsText,
    apptText,
    clinicPhone || '',
  ], clinicId);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function firstName(name) {
  return (name || '').split(' ')[0] || name || '';
}

function formatPhone(phone) {
  return (phone || '').replace(/[\s\-\+]/g, '').replace(/^91/, '');
}

// Remove tabs, newlines, excessive spaces (Interakt requirement)
function clean(str) {
  return String(str || '')
    .replace(/[\t\n\r]/g, ' ')
    .replace(/\s{3,}/g, '  ')
    .trim();
}

// Convert 24hr time to Hindi natural language
// e.g. "10:00" → "subah 10 baje"
// e.g. "14:30" → "dopahar 2:30 baje"
// e.g. "19:00" → "sham 7 baje"
function toHindiTime(timeStr) {
  if (!timeStr) return '';

  // Handle both "HH:MM" and "HH:MM AM/PM" formats
  let hours, minutes;

  if (timeStr.includes('AM') || timeStr.includes('PM')) {
    const [timePart, period] = timeStr.split(' ');
    const [h, m] = timePart.split(':').map(Number);
    hours = period === 'PM' && h !== 12 ? h + 12 : (period === 'AM' && h === 12 ? 0 : h);
    minutes = m || 0;
  } else {
    [hours, minutes] = timeStr.split(':').map(Number);
  }

  // Determine time period in Hindi
  let prefix;
  if (hours >= 5 && hours < 12) prefix = 'subah';
  else if (hours === 12) prefix = 'dopahar';
  else if (hours >= 12 && hours < 16) prefix = 'dopahar';
  else if (hours >= 16 && hours < 19) prefix = 'sham';
  else prefix = 'raat';

  // Convert to 12-hour format
  const h12 = hours % 12 || 12;
  const minStr = minutes > 0 ? `:${String(minutes).padStart(2, '0')}` : '';

  return `${prefix} ${h12}${minStr} baje`;
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
  toHindiTime,
};
