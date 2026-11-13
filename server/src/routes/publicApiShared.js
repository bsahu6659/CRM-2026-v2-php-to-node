/**
 * Inbound field normalisation for the public ingestion API — port of
 * api/publicApi.inc.php, kept in its own module so it can be reused (and
 * tested) without building the /api/v1 router.
 *
 * Most webhook senders speak snake_case and every ad platform names the same
 * field differently; this is the one place that knows all of it.
 */

export const PUBLIC_API_ALIASES = {
  first_name: 'firstName', firstname: 'firstName', fname: 'firstName', name: 'firstName',
  last_name: 'lastName', lastname: 'lastName', lname: 'lastName', surname: 'lastName',
  email_address: 'email', mail: 'email',
  phone_number: 'phone', mobile: 'phone', contact_number: 'phone', phone1: 'phone',
  alternate_phone: 'altPhone', phone2: 'altPhone',
  company_name: 'company', organisation: 'company', organization: 'company',
  job_title: 'jobTitle', designation: 'jobTitle', title: 'jobTitle',
  zip: 'pincode', zipcode: 'pincode', postal_code: 'pincode', pin_code: 'pincode',
  utm_source: 'utmSource', utm_medium: 'utmMedium', utm_campaign: 'utmCampaign',
  utm_term: 'utmTerm', utm_content: 'utmContent',
  landing_page: 'landingPage', page_url: 'landingPage',
  lead_source: 'sourceId', source: 'sourceId',
  campaign_code: 'campaignId', campaign: 'campaignId',
  expected_value: 'expectedValue', deal_value: 'expectedValue',
  // Real estate. Note `budget` maps to budgetMax, not expectedValue: on a
  // property enquiry "budget" is what the buyer will spend, which is the top
  // of their range, not a forecast of deal value.
  budget: 'budgetMax', budget_max: 'budgetMax', max_budget: 'budgetMax',
  budget_min: 'budgetMin', min_budget: 'budgetMin',
  project_name: 'project', property: 'project', property_name: 'project',
  configuration: 'configuration', unit_type: 'configuration', bhk: 'configuration',
  possession: 'possessionTimeline', possession_timeline: 'possessionTimeline',
  purpose: 'purpose', funding: 'funding', loan: 'funding',
  message: 'notes', comments: 'notes', remarks: 'notes', notes: 'notes',
};

/** PHP's empty(), which the original leaned on for "is this field filled in". */
function isEmpty(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '' || value === '0') {
    return true;
  }
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** Normalises an arbitrary inbound payload into lead input. */
export function publicApiNormalize(body) {
  const out = {};
  const source = body !== null && typeof body === 'object' ? body : {};
  for (const [rawKey, value] of Object.entries(source)) {
    if (value === null || value === undefined || value === '') continue;
    const lower = String(rawKey).toLowerCase();
    // An own-property check, not a bare lookup: `constructor` or `__proto__`
    // arriving as a field name must not resolve to Object.prototype members.
    const key = Object.prototype.hasOwnProperty.call(PUBLIC_API_ALIASES, lower) ? PUBLIC_API_ALIASES[lower] : rawKey;
    // defineProperty so a `__proto__` key stays a plain field, as it was in PHP.
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }
  // "John Doe" arriving in a single `name` field.
  if (
    !isEmpty(out.firstName) &&
    isEmpty(out.lastName) &&
    typeof out.firstName === 'string' &&
    out.firstName.includes(' ')
  ) {
    const parts = out.firstName.trim().split(/\s+/);
    out.firstName = parts.shift();
    out.lastName = parts.join(' ');
  }
  return out;
}
