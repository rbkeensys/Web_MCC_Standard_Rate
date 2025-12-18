// ADD THIS FUNCTION TO app.js AFTER openPidForm() (around line 2209)

async function openMotorEditor(){
  const motor_data = await (await fetch('/api/motors')).json();
  const motors = motor_data.motors || [];
  
  // Fetch available COM ports
  let ports = [];
  try {
    const portsResp = await fetch('/api/motors/ports');
    const portsData = await portsResp.json();
    ports = portsData.ports || [];
  } catch(e) {
    console.warn('Failed to fetch COM ports:', e);
  }

  const root = el('div', {});
  const title = el('h2', {}, 'Motor Controllers');
  
  // Load from file button
  const loadBtn = el('button', {
    className: 'btn',
    onclick: () => {
      const inp = el('input', {type: 'file', accept: '.json'});
      inp.onchange = async () => {
        const f = inp.files?.[0];
        if (!f) return;
        try {
          const text = await f.text();
          const loaded = JSON.parse(text);
          Object.assign(motor_data, loaded);
          alert('Motor config loaded! Close and reopen to see changes, or click Save to apply.');
        } catch(e) {
          alert('Failed to load motor config: ' + e.message);
        }
      };
      inp.click();
    }
  }, '📁 Load from File');

  // Build form for each motor
  const table = el('table', {className:'form'});
  const thead = el('thead');
  thead.append(el('tr', {}, [
    el('th', {}, 'Motor #'),
    el('th', {}, 'Include'),
    el('th', {}, 'Enabled'),
    el('th', {}, 'Name'),
    el('th', {}, 'COM Port'),
    el('th', {}, 'Baudrate'),
    el('th', {}, 'Address'),
    el('th', {}, 'Min RPM'),
    el('th', {}, 'Max RPM'),
    el('th', {}, 'Input Src'),
    el('th', {}, 'Input Ch'),
    el('th', {}, 'Input Min'),
    el('th', {}, 'Input Max'),
    el('th', {}, 'Scale'),
    el('th', {}, 'Offset'),
    el('th', {}, 'CW+')
  ]));
  
  const tbody = el('tbody');
  
  // Ensure at least 4 motor slots
  while (motors.length < 4) {
    motors.push({
      name: `Motor${motors.length}`,
      port: 'COM1',
      baudrate: 9600,
      address: 1,
      min_rpm: 0,
      max_rpm: 2500,
      input_source: 'ai',
      input_channel: 0,
      input_min: 0,
      input_max: 10,
      scale_factor: 250,
      offset: 0,
      cw_positive: true,
      enabled: false,
      include: false
    });
  }

  motors.forEach((M, idx) => {
    const portSelect = el('select', {});
    if (ports.length > 0) {
      ports.forEach(p => {
        portSelect.append(el('option', {value: p.port}, `${p.port} - ${p.description}`));
      });
    } else {
      // Fallback COM ports if query failed
      for (let i = 1; i <= 20; i++) {
        portSelect.append(el('option', {value: `COM${i}`}, `COM${i}`));
      }
    }
    portSelect.value = M.port || 'COM1';
    portSelect.onchange = () => M.port = portSelect.value;

    const srcSelect = selectEnum(['ai', 'ao'], M.input_source || 'ai', v => M.input_source = v);

    const tr = el('tr', {}, [
      el('td', {}, `${idx}`),
      el('td', {}, chk(M, 'include')),
      el('td', {}, chk(M, 'enabled')),
      el('td', {}, txt(M, 'name')),
      el('td', {}, portSelect),
      el('td', {}, num(M, 'baudrate', 1)),
      el('td', {}, num(M, 'address', 1)),
      el('td', {}, num(M, 'min_rpm', 1)),
      el('td', {}, num(M, 'max_rpm', 1)),
      el('td', {}, srcSelect),
      el('td', {}, num(M, 'input_channel', 1)),
      el('td', {}, num(M, 'input_min', 0.01)),
      el('td', {}, num(M, 'input_max', 0.01)),
      el('td', {}, num(M, 'scale_factor', 0.1)),
      el('td', {}, num(M, 'offset', 0.1)),
      el('td', {}, chk(M, 'cw_positive'))
    ]);
    tbody.append(tr);
  });

  table.append(thead, tbody);

  const save = el('button', {
    className: 'btn',
    onclick: async() => {
      try {
        await fetch('/api/motors', {
          method:'PUT',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({motors: motors})
        });
        alert('Saved');
      } catch(e) {
        alert('Save failed: ' + e.message);
      }
    }
  }, 'Save');

  root.append(
    title,
    el('div', {style: 'display:flex;gap:8px;margin-bottom:12px'}, [loadBtn]),
    el('div', {style: 'margin:12px 0'}, [
      el('p', {}, 'Configure Rattmotor YPMC-750W servo controllers:'),
      el('p', {style: 'font-size:12px;color:var(--muted)'}, 
        'RPM Command = ((Input - Input Min) / (Input Max - Input Min)) * Scale + Offset. Negative RPM reverses motor.')
    ]),
    el('div', {style: 'overflow:auto;max-height:60vh'}, table),
    el('div', {style:'margin-top:8px'}, save)
  );
  showModal(root, ()=>{ renderPage(); });
}
