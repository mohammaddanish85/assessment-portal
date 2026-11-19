const form = document.getElementById('request');
  const status = document.getElementById('request-status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.className = '';
    if (!form.checkValidity()) {
      status.textContent = 'Fill in the institute name, your name, a valid email and a phone number.';
      status.className = 'bad';
      form.querySelector(':invalid').focus();
      return;
    }
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const res = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'The request could not be sent. Try again in a minute.');
      form.reset();
      status.textContent = 'Request sent. We will contact you on the email or phone you gave.';
      status.className = 'ok';
    } catch (err) {
      status.textContent = err.message;
      status.className = 'bad';
    } finally {
      button.disabled = false;
    }
  });
