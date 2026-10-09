// Shared input validation helpers.

// Requires: local part, "@", a domain with at least one dot, and an
// alphabetic TLD of 2+ characters. Rejects "user@domain", "a@b.", "a@.com".
const EMAIL_REGEX = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/;

export function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_REGEX.test(email);
}

// Emails are case-insensitive in practice; store and compare them lowercased
// so "QA@test.com" and "qa@test.com" cannot become two accounts.
export function normalizeEmail(email) {
  return email.trim().toLowerCase();
}
