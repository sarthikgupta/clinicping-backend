const jwt = require('jsonwebtoken');

// Base auth — any valid user
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Support both old (clinic-level) and new (user-level) tokens
    req.clinic = {
      id: decoded.clinic_id || decoded.id,
      name: decoded.clinic_name || decoded.name,
      doctor_name: decoded.doctor_name || decoded.name,
      email: decoded.email,
      plan: decoded.plan || 'starter',
    };
    req.user = {
      id: decoded.user_id || decoded.id,
      clinic_id: decoded.clinic_id || decoded.id,
      role: decoded.role || 'admin',
      name: decoded.name,
      email: decoded.email,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Require specific roles
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Access denied. Required role: ${roles.join(' or ')}` });
    }
    next();
  };
}

// Doctors and admins only
const doctorOnly = requireRole('doctor', 'admin');

// Admin only
const adminOnly = requireRole('admin');

module.exports = { authMiddleware, requireRole, doctorOnly, adminOnly };
module.exports.default = authMiddleware;
