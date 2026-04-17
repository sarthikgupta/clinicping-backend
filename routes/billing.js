const router = require('express').Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const supabase = require('../db/supabase');
const { authMiddleware: auth } = require('../middleware/auth');
const { checkPatientLimit, incrementPatientCount, ensureMonthlyCounterFresh } = require('./planMiddleware');

let razorpay;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
} else {
  console.warn('[Billing] Razorpay keys not configured');
}

// ── Plan definitions ──────────────────────────────────────────────────────────
const PLANS = {
  free: {
    name: 'Free',
    price: 0,
    patients_per_month: 30,
    max_doctors: 1,
    whatsapp: false,
    followups: false,
    analytics: 'basic',
  },
  growth: {
    name: 'Growth',
    price: 79900, // paise = ₹799
    patients_per_month: Infinity,
    max_doctors: 1,
    whatsapp: true,
    followups: true,
    analytics: 'full',
    razorpay_plan_id: process.env.RAZORPAY_PLAN_GROWTH_ID,
  },
  clinic: {
    name: 'Clinic',
    price: 149900, // paise = ₹1499
    patients_per_month: Infinity,
    max_doctors: 3,
    whatsapp: true,
    followups: true,
    analytics: 'full',
    razorpay_plan_id: process.env.RAZORPAY_PLAN_CLINIC_ID,
  },
};

// Apply auth middleware to all routes
router.use(auth);

// ── Helper: get current plan for a clinic ────────────────────────────────────
async function getClinicPlan(clinicId) {
  const { data } = await supabase
    .from('clinics')
    .select('plan, plan_expires_at, patients_this_month, patients_month_year')
    .eq('id', clinicId)
    .single();

  if (!data) return PLANS.free;

  // Check if paid plan has expired
  const plan = data.plan || 'free';
  if (plan !== 'free' && data.plan_expires_at) {
    if (new Date(data.plan_expires_at) < new Date()) {
      // Plan expired — downgrade to free
      await supabase.from('clinics').update({ plan: 'free', plan_expires_at: null }).eq('id', clinicId);
      return { ...PLANS.free, patients_this_month: data.patients_this_month, patients_month_year: data.patients_month_year };
    }
  }

  return { ...PLANS[plan] || PLANS.free, patients_this_month: data.patients_this_month, patients_month_year: data.patients_month_year };
}



// ── Middleware: check WhatsApp access ─────────────────────────────────────────
async function checkWhatsAppAccess(req, res, next) {
  const clinicId = req.clinic?.id;
  if (!clinicId) return next();

  try {
    const planData = await getClinicPlan(clinicId);
    if (!planData.whatsapp) {
      // Don't block — just skip WhatsApp silently
      req.whatsappBlocked = true;
    }
    next();
  } catch {
    next();
  }
}


// ── GET /api/billing/plan ─────────────────────────────────────────────────────
router.get('/plan', async (req, res) => {
  const clinicId = req.clinic?.id;
  
  try {
    const currentCount = await ensureMonthlyCounterFresh(clinicId);
    const planData = await getClinicPlan(clinicId);


    const { data: clinic } = await supabase
      .from('clinics')
      .select('plan, plan_expires_at, razorpay_subscription_id')
      .eq('id', clinicId)
      .single();

    res.json({
      plan: clinic?.plan || 'free',
      plan_name: PLANS[clinic?.plan || 'free']?.name || 'Free',
      plan_expires_at: clinic?.plan_expires_at || null,
      patients_this_month: currentCount,
      patients_limit: planData.patients_per_month === Infinity ? null : planData.patients_per_month,
      features: {
        whatsapp: planData.whatsapp,
        followups: planData.followups,
        max_doctors: planData.max_doctors,
        analytics: planData.analytics,
      },
      plans: Object.entries(PLANS).map(([key, p]) => ({
        id: key,
        name: p.name,
        price: p.price,
        price_display: p.price === 0 ? 'Free' : `₹${p.price / 100}/month`,
        patients_per_month: p.patients_per_month === Infinity ? 'Unlimited' : p.patients_per_month,
        max_doctors: p.max_doctors,
        whatsapp: p.whatsapp,
        followups: p.followups,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/billing/subscribe ───────────────────────────────────────────────
// Create Razorpay subscription
router.post('/subscribe', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { plan_id } = req.body;
  const plan = PLANS[plan_id];

  if (!plan || plan_id === 'free') {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  if (!plan.razorpay_plan_id) {
    return res.status(500).json({ error: 'Razorpay plan not configured' });
  }

  try {
    const { data: clinic } = await supabase
      .from('clinics')
      .select('name, email, razorpay_customer_id')
      .eq('id', req.clinic.id)
      .single();

    // Create or reuse Razorpay customer
    let customerId = clinic.razorpay_customer_id;
    if (!customerId) {
      const customer = await razorpay.customers.create({
        name: clinic.name,
        email: clinic.email || req.user.email,
        notes: { clinic_id: req.clinic.id },
      });
      customerId = customer.id;
      await supabase.from('clinics').update({ razorpay_customer_id: customerId }).eq('id', req.clinic.id);
    }

    // Create subscription
    const subscription = await razorpay.subscriptions.create({
      plan_id: plan.razorpay_plan_id,
      customer_notify: 1,
      total_count: 12, // 12 months
      notes: { clinic_id: req.clinic.id, plan: plan_id },
    });

    // Save subscription ID
    await supabase.from('clinics')
      .update({ razorpay_subscription_id: subscription.id })
      .eq('id', req.clinic.id);

    res.json({
      subscription_id: subscription.id,
      razorpay_key: process.env.RAZORPAY_KEY_ID,
      plan_id,
      amount: plan.price,
      currency: 'INR',
    });
  } catch (err) {
    console.error('Subscription error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/billing/verify ──────────────────────────────────────────────────
// Verify Razorpay payment and activate plan
router.post('/verify', async (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, plan_id } = req.body;

  try {
    // Verify signature
    const body = razorpay_payment_id + '|' + razorpay_subscription_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // Activate plan — expires 31 days from now
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 31);

    await supabase.from('clinics').update({
      plan: plan_id,
      plan_expires_at: expiresAt.toISOString(),
      razorpay_subscription_id,
    }).eq('id', req.clinic.id);

    // Log payment
    await supabase.from('payments').insert({
      clinic_id: req.clinic.id,
      razorpay_payment_id,
      razorpay_subscription_id,
      amount: PLANS[plan_id]?.price || 0,
      plan: plan_id,
      status: 'captured',
    });

    res.json({ success: true, plan: plan_id, expires_at: expiresAt });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/billing/upi ─────────────────────────────────────────────────────
// Generate UPI payment link
router.post('/upi', async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { plan_id } = req.body;
  const plan = PLANS[plan_id];
  if (!plan || plan_id === 'free') return res.status(400).json({ error: 'Invalid plan' });

  try {
    const { data: clinic } = await supabase
      .from('clinics').select('name, email').eq('id', req.clinic.id).single();

    const paymentLink = await razorpay.paymentLink.create({
      amount: plan.price,
      currency: 'INR',
      accept_partial: false,
      description: `ClinicPing ${plan.name} Plan - ${clinic.name}`,
      customer: {
        name: clinic.name,
        email: clinic.email || req.user.email,
      },
      notify: { email: true },
      reminder_enable: true,
      notes: { clinic_id: req.clinic.id, plan: plan_id },
      callback_url: `${process.env.FRONTEND_URL}/settings?payment=success&plan=${plan_id}`,
      callback_method: 'get',
    });

    res.json({ payment_link: paymentLink.short_url, amount: plan.price });
  } catch (err) {
    console.error('UPI link error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/billing/webhook ─────────────────────────────────────────────────
// Razorpay webhook for subscription events
router.post('/webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const body = JSON.stringify(req.body);

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  if (signature !== expectedSignature) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const { event, payload } = req.body;

  try {
    if (event === 'subscription.charged') {
      const sub = payload.subscription.entity;
      const payment = payload.payment.entity;
      const clinicId = sub.notes?.clinic_id;
      const planId = sub.notes?.plan;

      if (clinicId && planId) {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 31);

        await supabase.from('clinics').update({
          plan: planId,
          plan_expires_at: expiresAt.toISOString(),
        }).eq('id', clinicId);

        await supabase.from('payments').insert({
          clinic_id: clinicId,
          razorpay_payment_id: payment.id,
          razorpay_subscription_id: sub.id,
          amount: payment.amount,
          plan: planId,
          status: 'captured',
        });

        console.log(`[Billing] Plan renewed: ${clinicId} → ${planId}`);
      }
    }

    if (event === 'subscription.cancelled' || event === 'subscription.expired') {
      const sub = payload.subscription.entity;
      const clinicId = sub.notes?.clinic_id;
      if (clinicId) {
        await supabase.from('clinics').update({
          plan: 'free',
          plan_expires_at: null,
          razorpay_subscription_id: null,
        }).eq('id', clinicId);
        console.log(`[Billing] Plan cancelled: ${clinicId}`);
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, checkPatientLimit, checkWhatsAppAccess, incrementPatientCount, getClinicPlan, PLANS };
