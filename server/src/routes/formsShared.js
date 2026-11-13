/**
 * Web-form definitions shared between the admin route (routes/forms.js) and
 * the public capture surface (routes/publicCapture.js) — port of
 * api/forms.inc.php. Kept in its own module because importing a route file
 * for its helpers would also build that file's router.
 */

import config from '../config/index.js';
import { badRequest } from '../lib/errors.js';
import { camelize, safeJson } from '../lib/util.js';

export const FORMS_FIELD_TYPES = ['text', 'email', 'tel', 'number', 'textarea', 'select', 'checkbox', 'hidden'];

/**
 * Lead columns a form field may map onto. Anything else becomes a custom field
 * value or is ignored — a form can never write to ownerId, score, etc.
 */
export const FORMS_MAPPABLE = [
  'firstName', 'lastName', 'email', 'phone', 'altPhone', 'company', 'jobTitle', 'website',
  'country', 'state', 'city', 'address', 'pincode', 'notes', 'expectedValue',
  'utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent', 'medium', 'landingPage',
];

/**
 * PHP's empty(). The field definitions arrive as untrusted JSON, and "0", an
 * empty list and an empty object all counted as missing in the PHP edition.
 */
function isEmpty(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '' || value === '0') {
    return true;
  }
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** A PHP array is either a list or a map; a JSON object decodes to the latter. */
function asList(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return Object.values(value);
  return null;
}

export function formsValidateFields(fields) {
  const list = asList(fields);
  if (list === null || list.length === 0) {
    // PHP's array type hint turned a non-list payload into a 500; a malformed
    // definition is the caller's mistake, so it is reported as one.
    if (list === null && !isEmpty(fields)) {
      throw badRequest('Every field needs a key, label, and a supported type');
    }
    throw badRequest('A form needs at least one field');
  }

  const seen = new Set();
  for (const raw of list) {
    const field = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (isEmpty(field.key) || isEmpty(field.label) || !FORMS_FIELD_TYPES.includes(field.type ?? null)) {
      throw badRequest('Every field needs a key, label, and a supported type');
    }
    const seenKey = String(field.key);
    if (seen.has(seenKey)) {
      throw badRequest(`Duplicate field key: ${field.key}`);
    }
    seen.add(seenKey);
    if (!isEmpty(field.mapTo) && !FORMS_MAPPABLE.includes(field.mapTo)) {
      throw badRequest(`"${field.mapTo}" is not a field a form may write to.`);
    }
    if ((field.type ?? null) === 'select' && isEmpty(field.options)) {
      throw badRequest(`Field "${field.label}" is a dropdown but has no options.`);
    }
  }

  const mapped = list
    .filter((f) => f !== null && typeof f === 'object' && Object.prototype.hasOwnProperty.call(f, 'mapTo'))
    .map((f) => f.mapTo)
    .filter((m) => !isEmpty(m));
  if (!mapped.includes('firstName')) {
    throw badRequest('One field must map to firstName.');
  }
  if (!mapped.includes('email') && !mapped.includes('phone')) {
    throw badRequest('A form must collect at least an email address or a phone number.');
  }
}

/** Adds the embed/hosted/API snippets the admin UI shows next to each form. */
export function formsShape(form) {
  const f = camelize(form);
  // From the raw row, not the camelized copy: the definitions are client data
  // whose keys must come back exactly as they were saved.
  f.fields = safeJson(form.fields ?? '[]', []);
  const appUrl = config.appUrl;
  f.embedScript = `<script src="${appUrl}/embed/${form.public_key}.js" async></script>\n<div id="growvanta-form-${form.public_key}"></div>`;
  f.iframeEmbed = `<iframe src="${appUrl}/f/${form.public_key}" style="width:100%;max-width:560px;height:640px;border:0" title="${form.name}"></iframe>`;
  f.hostedUrl = `${appUrl}/f/${form.public_key}`;
  f.apiEndpoint = `${appUrl}/api/public/forms/${form.public_key}/submit`;
  return f;
}
