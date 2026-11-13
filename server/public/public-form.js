/**
 * Submit handler for the hosted lead-capture page (/f/:publicKey).
 *
 * Kept as a separate file, and configured through data-attributes on its own
 * <script> tag, so the hosted page needs no inline script and can keep a strict
 * Content-Security-Policy.
 */
(function () {
  var script = document.currentScript;
  var endpoint = script.getAttribute('data-endpoint');
  var successMessage = script.getAttribute('data-success') || 'Thank you.';
  var redirectUrl = script.getAttribute('data-redirect') || '';

  var form = document.getElementById('gvForm');
  var msg = document.getElementById('gvMsg');
  if (!form) return;

  function trackingParams() {
    var params = new URLSearchParams(window.location.search);
    var map = {
      utm_source: 'utmSource', utm_medium: 'utmMedium', utm_campaign: 'utmCampaign',
      utm_term: 'utmTerm', utm_content: 'utmContent', gclid: 'gclid', fbclid: 'fbclid'
    };
    var out = { landingPage: (document.referrer || window.location.href).slice(0, 400) };
    Object.keys(map).forEach(function (key) {
      if (params.get(key)) out[map[key]] = params.get(key);
    });
    return out;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var button = form.querySelector('button[type="submit"]');
    var label = button.textContent;

    msg.className = 'msg';
    msg.textContent = '';

    var missing = [];
    form.querySelectorAll('[required]').forEach(function (el) {
      var empty = el.type === 'checkbox' ? !el.checked : !String(el.value || '').trim();
      if (empty) {
        var labelEl = form.querySelector('label[for="' + el.id + '"]');
        missing.push(labelEl ? labelEl.textContent.replace(' *', '') : el.name);
      }
    });
    if (missing.length) {
      msg.className = 'msg err';
      msg.textContent = 'Please fill in: ' + missing.join(', ');
      return;
    }

    var data = trackingParams();
    new FormData(form).forEach(function (value, key) { data[key] = value; });

    button.disabled = true;
    button.textContent = 'Sending…';

    fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data)
    })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (result) {
        button.disabled = false;
        button.textContent = label;
        if (!result.ok) {
          msg.className = 'msg err';
          msg.textContent = (result.body && result.body.error && result.body.error.message)
            || 'Something went wrong. Please try again.';
          return;
        }
        form.reset();
        msg.className = 'msg ok';
        msg.textContent = (result.body.data && result.body.data.message) || successMessage;
        var target = (result.body.data && result.body.data.redirectUrl) || redirectUrl;
        if (target) setTimeout(function () { window.location.href = target; }, 900);
      })
      .catch(function () {
        button.disabled = false;
        button.textContent = label;
        msg.className = 'msg err';
        msg.textContent = 'Network error. Please try again.';
      });
  });
})();
