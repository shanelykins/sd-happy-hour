const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const happyHoursPath = path.join(rootDir, 'data', 'happy-hours.json');
const submissionsPath = path.join(rootDir, 'data', 'submissions.json');
const usersPath = path.join(rootDir, 'data', 'users.json');
const validDays = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const validSavedStatuses = new Set(['favorite', 'want-to-try', 'been-to']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function isTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function hasString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(hasString);
}

function validateListing(listing, label, { requireId = true, requireCoordinates = true } = {}) {
  const errors = [];
  if (requireId && !Number.isInteger(listing.id)) errors.push(`${label}: id must be an integer.`);
  if (!hasString(listing.name)) errors.push(`${label}: name is required.`);
  if (!hasString(listing.neighborhood)) errors.push(`${label}: neighborhood is required.`);
  if (!hasString(listing.address)) errors.push(`${label}: address is required.`);
  if (requireCoordinates && !Number.isFinite(listing.lat)) errors.push(`${label}: lat is required.`);
  if (requireCoordinates && !Number.isFinite(listing.lng)) errors.push(`${label}: lng is required.`);
  if (Number.isFinite(listing.lat) && (listing.lat < -90 || listing.lat > 90)) errors.push(`${label}: lat is out of range.`);
  if (Number.isFinite(listing.lng) && (listing.lng < -180 || listing.lng > 180)) errors.push(`${label}: lng is out of range.`);
  if (!hasStringArray(listing.days) || listing.days.some(day => !validDays.has(day))) errors.push(`${label}: days must contain valid day names.`);
  if (!isTime(listing.startTime)) errors.push(`${label}: startTime must be HH:MM.`);
  if (!isTime(listing.endTime)) errors.push(`${label}: endTime must be HH:MM.`);
  if (!hasStringArray(listing.deals)) errors.push(`${label}: deals must be a non-empty string array.`);
  if (!hasString(listing.vibe)) errors.push(`${label}: vibe is required.`);
  if (!isUrl(listing.website)) errors.push(`${label}: website must be an http(s) URL.`);
  if (typeof listing.verified !== 'boolean') errors.push(`${label}: verified must be boolean.`);
  if (!('lastVerifiedAt' in listing)) errors.push(`${label}: lastVerifiedAt is required, even when null.`);
  if (!isUrl(listing.sourceUrl)) errors.push(`${label}: sourceUrl must be an http(s) URL.`);
  if (!hasStringArray(listing.dealTypes)) errors.push(`${label}: dealTypes must be a non-empty string array.`);
  if (!hasStringArray(listing.features)) errors.push(`${label}: features must be a non-empty string array.`);
  return errors;
}

const errors = [];
const happyHours = readJson(happyHoursPath);
const ids = new Set();

if (!Array.isArray(happyHours)) {
  errors.push('happy-hours.json must contain an array.');
} else {
  happyHours.forEach((listing, index) => {
    errors.push(...validateListing(listing, `happy-hours[${index}]`));
    if (ids.has(listing.id)) errors.push(`happy-hours[${index}]: duplicate id ${listing.id}.`);
    ids.add(listing.id);
  });
}

const submissions = readJson(submissionsPath);
if (!Array.isArray(submissions)) {
  errors.push('submissions.json must contain an array.');
} else {
  submissions.forEach((submission, index) => {
    const label = `submissions[${index}]`;
    if (!hasString(submission.id)) errors.push(`${label}: id is required.`);
    if (!['pending', 'approved', 'denied'].includes(submission.status)) errors.push(`${label}: status is invalid.`);
    if (!submission.contact || !hasString(submission.contact.contactName)) errors.push(`${label}: contactName is required.`);
    if (!submission.contact || !hasString(submission.contact.contactEmail)) errors.push(`${label}: contactEmail is required.`);
    if (!submission.listing) {
      errors.push(`${label}: listing is required.`);
    } else {
      errors.push(...validateListing(submission.listing, `${label}.listing`, {
        requireId: false,
        requireCoordinates: false
      }));
    }
  });
}

const users = readJson(usersPath);
const emails = new Set();
const shareIds = new Set();
if (!Array.isArray(users)) {
  errors.push('users.json must contain an array.');
} else {
  users.forEach((user, index) => {
    const label = `users[${index}]`;
    if (!hasString(user.id)) errors.push(`${label}: id is required.`);
    if (!hasString(user.name)) errors.push(`${label}: name is required.`);
    if (!hasString(user.email)) errors.push(`${label}: email is required.`);
    if (emails.has(user.email)) errors.push(`${label}: duplicate email ${user.email}.`);
    emails.add(user.email);
    const hasPassword = hasString(user.passwordSalt) && hasString(user.passwordHash);
    const hasGoogle = hasString(user.googleId);
    if (!hasPassword && !hasGoogle) errors.push(`${label}: password credentials or googleId are required.`);
    if (!hasString(user.shareId)) errors.push(`${label}: shareId is required.`);
    if (shareIds.has(user.shareId)) errors.push(`${label}: duplicate shareId ${user.shareId}.`);
    shareIds.add(user.shareId);
    if (!Array.isArray(user.savedSpots)) {
      errors.push(`${label}: savedSpots must be an array.`);
    } else {
      const savedIds = new Set();
      user.savedSpots.forEach((saved, savedIndex) => {
        const savedLabel = `${label}.savedSpots[${savedIndex}]`;
        if (!Number.isInteger(saved.spotId)) errors.push(`${savedLabel}: spotId must be an integer.`);
        if (Number.isInteger(saved.spotId) && !ids.has(saved.spotId)) errors.push(`${savedLabel}: spotId ${saved.spotId} does not exist.`);
        if (savedIds.has(saved.spotId)) errors.push(`${savedLabel}: duplicate spotId ${saved.spotId}.`);
        savedIds.add(saved.spotId);
        if (!validSavedStatuses.has(saved.status)) errors.push(`${savedLabel}: status is invalid.`);
        if (typeof saved.note !== 'string') errors.push(`${savedLabel}: note must be a string.`);
      });
    }
  });
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Data ok: ${happyHours.length} listings, ${submissions.length} submissions, ${users.length} users.`);
