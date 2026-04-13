const axios = require('axios');
const supabase = require('../db/supabase');

const AISENSY_BASE = 'https://backend.aisensy.com/campaign/t1/api/v2';

// ── Campaign names — create these in AiSensy dashboard ────────────────────────
// AiSensy → Campaigns → Launch Campaign → API Campaign → name it exactly as below
const CAMPAIGNS = {
  token_assigned:       'clinicping_token_assigned',
  call_in:              'clinicping_call_in',
  medicine_reminder:    'clinicping_medicine_reminder',
  appointment_reminder: 'clinicping_appointment_reminder',
  lab_reminder:         'clinicping_lab_reminder',
  wellness_check:       'clinicping_wellness_chk',
  prescription:         'clinicping_prescription',
};

// ── Core send ─────────────────────────────────────────────────────────────────
async function sendWhatsAppTemplate(phone, campaignName, params, userName, clinicId) {
  const formattedPhone = formatPhone(phone);

  const payload = {
    apiKey: process.env.AISENSY_API_KEY,
    campaignName,
    destination: formattedPhone,
    userName: userName || 'ClinicPing User',
    source: 'ClinicPing',
    templateParams: params.map(p => clean(p)),
  };

  try {
    const response = await axios.post(AISENSY_BASE, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000,
    });

    try {
      await supabase.from('whatsapp_logs').insert({
        clinic_id: clinicId,
        patient_phone: formattedPhone,
        message_type: campaignName,
        message_body: JSON.stringify(params),
        status: 'sent',
      });
    } catch (_) {}

    console.log(`[WhatsApp] ${campaignName} → ${formattedPhone} ✓`);
    return { success: true };
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error(`[WhatsApp] ${campaignName} failed:`, JSON.stringify(errMsg));

    try {
      await supabase.from('whatsapp_logs').insert({
        clinic_id: clinicId,
        patient_phone: formattedPhone,
        message_type: campaignName,
        message_body: JSON.stringify(params),
        status: 'failed',
      });
    } catch (_) {}

    return { success: false, error: errMsg };
  }
}

// ── Template senders ──────────────────────────────────────────────────────────

// {{1}} name, {{2}} clinic name , {{3}} token, {{4}} wait minutes
async function sendTokenAssigned({ patient, clinicName, tokenNumber, waitMinutes, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, TEMPLATES.token_assigned.name, [
    firstName(patient.name),
    clinicName,
    String(tokenNumber),
    String(waitMinutes),
  ], clinicId);
}

// {{1}} name, {{2}} doctor name
async function sendCallIn({ patient, doctorName, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, CAMPAIGNS.call_in, [
    firstName(patient.name),
    doctorName,
  ], patient.name, clinicId);
}

// {{1}} name, {{2}} doctor name, {{3}} clinic phone
async function sendMedicineReminder({ patient, doctorName, clinicPhone, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, CAMPAIGNS.medicine_reminder, [
    firstName(patient.name),
    doctorName,
    clinicPhone || '',
  ], patient.name, clinicId);
}

// {{1}} name, {{2}} date, {{3}} time (Hindi), {{4}} doctor, {{5}} address, {{6}} phone
async function sendAppointmentReminder({ patient, appointmentDate, appointmentTime, doctorName, clinicAddress, clinicPhone, clinicId }) {
  const hindiTime = toHindiTime(appointmentTime);
  return sendWhatsAppTemplate(patient.phone, CAMPAIGNS.appointment_reminder, [
    firstName(patient.name),
    appointmentDate || '',
    hindiTime,
    doctorName || '',
    clinicAddress || '',
    clinicPhone || '',
  ], patient.name, clinicId);
}

// {{1}} name, {{2}} doctor name, {{3}} clinic name, {{4}} clinic phone
async function sendLabReminder({ patient, doctorName, clinicName, clinicPhone, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, CAMPAIGNS.lab_reminder, [
    firstName(patient.name),
    doctorName || '',
    clinicName || '',
    clinicPhone || '',
  ], patient.name, clinicId);
}

// {{1}} name, {{2}} doctor name, {{3}} clinic phone
async function sendWellnessCheck({ patient, doctorName, clinicPhone, clinicId }) {
  return sendWhatsAppTemplate(patient.phone, CAMPAIGNS.wellness_check, [
    firstName(patient.name),
    doctorName || '',
    clinicPhone || '',
  ], patient.name, clinicId);
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
    const apptDate = new Date(consultation.next_appointment_date + 'T00:00:00+05:30')
      .toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric', month: 'long', year: 'numeric'
      });
    const apptTime = consultation.next_appointment_time
      ? ` — ${toHindiTime(consultation.next_appointment_time)}`
      : '';
    apptText = `${apptDate}${apptTime}`;
  }

  const diagnosis = consultation.diagnosis || consultation.symptoms || 'General checkup';

  return sendWhatsAppTemplate(patient.phone, CAMPAIGNS.prescription, [
    firstName(patient.name),
    doctorName || '',
    date,
    diagnosis,
    medsText,
    testsText,
    apptText,
    clinicPhone || '',
  ], patient.name, clinicId);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function firstName(name) {
  return (name || '').split(' ')[0] || name || '';
}

function formatPhone(phone) {
  const digits = (phone || '').replace(/[\s\-\+]/g, '');
  // AiSensy needs full number with country code
  if (digits.startsWith('91') && digits.length === 12) return digits;
  if (digits.length === 10) return '91' + digits;
  return digits;
}

function clean(str) {
  return String(str || '')
    .replace(/[\t\n\r]/g, ' ')
    .replace(/\s{3,}/g, '  ')
    .trim();
}

function toHindiTime(timeStr) {
  if (!timeStr) return '';

  let hours, minutes;
  if (timeStr.includes('AM') || timeStr.includes('PM')) {
    const [timePart, period] = timeStr.split(' ');
    const [h, m] = timePart.split(':').map(Number);
    hours = period === 'PM' && h !== 12 ? h + 12 : (period === 'AM' && h === 12 ? 0 : h);
    minutes = m || 0;
  } else {
    [hours, minutes] = timeStr.split(':').map(Number);
  }

  let prefix;
  if (hours >= 5 && hours < 12) prefix = 'subah';
  else if (hours >= 12 && hours < 16) prefix = 'dopahar';
  else if (hours >= 16 && hours < 19) prefix = 'sham';
  else prefix = 'raat';

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
