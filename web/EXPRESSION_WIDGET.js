// ============================================================================
// EXPRESSION WIDGET - Add to app.js
// ============================================================================

// Add this to the widget type list in normalizeLayoutPages() around line 2000
// In the switch statement after the mathop case:

      case 'expr':
        w.opts.title = w.opts.title ?? 'Expression';
        w.opts.exprIndex = Number.isInteger(w.opts.exprIndex) ? w.opts.exprIndex : 0;
        w.opts.showSource = (w.opts.showSource !== false);  // Show source code
        w.opts.showOutput = (w.opts.showOutput !== false);  // Show final output
        break;

// ============================================================================
// Add to the palette button section (around line 550):

      <button class="btn" data-add="expr">Expression</button>

// ============================================================================
// Add to the renderWidget() function (around line 750):

  if (w.type==='expr'){
    const idx = w.opts.exprIndex ?? 0;
    const exprData = latest.expr?.[idx];
    const showSource = w.opts.showSource !== false;
    const showOutput = w.opts.showOutput !== false;
    
    root.className = 'widget expr-widget';
    
    // Header with name and settings
    const header = el('header', {}, [
      el('span', {className:'title'}, w.opts.title || `Expr ${idx}`),
      el('span', {className:'spacer'}),
      el('span', {
        className:'icon',
        textContent:'⚙️',
        onclick:()=>openWidgetSettings(w)
      }),
      el('span', {
        className:'icon',
        textContent:'❌',
        onclick:()=>removeWidget(w)
      })
    ]);
    
    // Body
    const body = el('div', {className:'body'});
    
    if (!exprData) {
      body.append(el('div', {className:'expr-error'}, `Expression ${idx} not found`));
      root.append(header, body);
      return;
    }
    
    // Check if disabled or has error
    if (!exprData.enabled) {
      body.append(el('div', {className:'expr-disabled'}, 'Expression disabled'));
      root.append(header, body);
      return;
    }
    
    if (exprData.error) {
      body.append(
        el('div', {className:'expr-error'}, [
          el('div', {style:'font-weight:600;margin-bottom:4px'}, '⚠️ Error'),
          el('div', {style:'font-size:11px'}, exprData.error)
        ])
      );
      root.append(header, body);
      return;
    }
    
    // Parse and display expression with live values
    if (showSource && exprData.locals) {
      const sourceDiv = el('div', {className:'expr-source'});
      
      // Get expression text from config (we need to fetch it)
      // For now, show the variables and their values
      const locals = exprData.locals || {};
      const hwWrites = exprData.hw_writes || [];
      
      // Display local variables
      if (Object.keys(locals).length > 0) {
        const varsDiv = el('div', {className:'expr-vars'});
        
        for (const [name, value] of Object.entries(locals)) {
          const varRow = el('div', {className:'expr-var-row'}, [
            el('span', {className:'expr-var-name'}, name),
            el('span', {className:'expr-var-eq'}, '='),
            el('span', {className:'expr-var-value'}, formatValue(value))
          ]);
          varsDiv.append(varRow);
        }
        
        sourceDiv.append(varsDiv);
      }
      
      // Display hardware writes if any
      if (hwWrites.length > 0) {
        const hwDiv = el('div', {className:'expr-hw-writes'});
        const hwLabel = el('div', {
          style: 'font-size:10px;color:#9094a1;margin-top:6px;margin-bottom:2px'
        }, 'Hardware Writes:');
        hwDiv.append(hwLabel);
        
        for (const hw of hwWrites) {
          const hwRow = el('div', {className:'expr-hw-row'}, [
            el('span', {className:'expr-hw-type'}, hw.type.toUpperCase()),
            el('span', {className:'expr-hw-ch'}, `[${hw.channel}]`),
            el('span', {className:'expr-hw-eq'}, '←'),
            el('span', {
              className:'expr-hw-value',
              style: hw.type === 'do' ? `color:${hw.value ? '#2faa60' : '#d84a4a'}` : ''
            }, hw.type === 'do' ? (hw.value ? 'ON' : 'OFF') : formatValue(hw.value))
          ]);
          hwDiv.append(hwRow);
        }
        
        sourceDiv.append(hwDiv);
      }
      
      body.append(sourceDiv);
    }
    
    // Show final output value
    if (showOutput) {
      const outputDiv = el('div', {className:'expr-output'}, [
        el('span', {className:'expr-output-label'}, '► Output:'),
        el('span', {
          className:'expr-output-value',
          style: `color: ${getValueColor(exprData.output)}`
        }, formatValue(exprData.output))
      ]);
      body.append(outputDiv);
    }
    
    root.append(header, body);
    return;
  }

// ============================================================================
// Add to openWidgetSettings() function (around line 2520):

  if (w.type==='expr'){
    root.append(tableForm([
      ['Expression Index', inputNum(w.opts,'exprIndex',1)],
      ['Show Variables', inputChk(w.opts,'showSource')],
      ['Show Output', inputChk(w.opts,'showOutput')]
    ]));
  }

// ============================================================================
// Helper function to format values (add near other helper functions):

function formatValue(val) {
  if (val === null || val === undefined) return 'N/A';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') {
    if (Math.abs(val) < 0.01 || Math.abs(val) > 10000) {
      return val.toExponential(3);
    }
    return val.toFixed(3);
  }
  return String(val);
}

function getValueColor(val) {
  if (val === null || val === undefined || isNaN(val)) return '#d84a4a';  // Red for invalid
  if (val === 0) return '#9094a1';  // Gray for zero
  if (val > 0) return '#2faa60';  // Green for positive
  return '#ff9966';  // Orange for negative
}

// ============================================================================
// ENHANCED VERSION: Expression Widget with Source Code Display
// ============================================================================
// This version fetches the actual expression source and annotates it with values

async function renderExprWidgetEnhanced(w, root, latest) {
  const idx = w.opts.exprIndex ?? 0;
  const exprData = latest.expr?.[idx];
  const showSource = w.opts.showSource !== false;
  const showOutput = w.opts.showOutput !== false;
  
  root.className = 'widget expr-widget';
  
  // Header
  const header = el('header', {}, [
    el('span', {className:'title'}, w.opts.title || `Expr ${idx}`),
    el('span', {className:'spacer'}),
    el('span', {
      className:'icon',
      textContent:'⚙️',
      onclick:()=>openWidgetSettings(w)
    }),
    el('span', {
      className:'icon',
      textContent:'❌',
      onclick:()=>removeWidget(w)
    })
  ]);
  
  // Body
  const body = el('div', {className:'body'});
  
  if (!exprData) {
    body.append(el('div', {className:'expr-error'}, `Expression ${idx} not found`));
    root.append(header, body);
    return;
  }
  
  if (!exprData.enabled) {
    body.append(el('div', {className:'expr-disabled'}, 'Expression disabled'));
    root.append(header, body);
    return;
  }
  
  if (exprData.error) {
    body.append(
      el('div', {className:'expr-error'}, [
        el('div', {style:'font-weight:600;margin-bottom:4px'}, '⚠️ Error'),
        el('div', {style:'font-size:11px'}, exprData.error)
      ])
    );
    root.append(header, body);
    return;
  }
  
  // Fetch expression source from API
  try {
    const resp = await fetch('/api/expressions');
    const data = await resp.json();
    const expressions = data.expressions || [];
    
    if (idx < expressions.length) {
      const expr = expressions[idx];
      const sourceCode = expr.expression || '';
      const locals = exprData.locals || {};
      
      if (showSource && sourceCode) {
        const sourceDiv = el('div', {className:'expr-source-annotated'});
        
        // Parse and annotate each line
        const lines = sourceCode.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          
          // Skip empty lines and comments
          if (!trimmed || trimmed.startsWith('//')) {
            sourceDiv.append(el('div', {
              className:'expr-line expr-comment',
              textContent: line
            }));
            continue;
          }
          
          // Check if it's an assignment: name = expr
          const assignMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
          if (assignMatch) {
            const [, varName, expr] = assignMatch;
            const value = locals[varName];
            
            const lineDiv = el('div', {className:'expr-line expr-assignment'}, [
              el('span', {className:'expr-var-name'}, varName),
              el('span', {className:'expr-eq'}, ' = '),
              el('span', {className:'expr-expr'}, expr),
              el('span', {className:'expr-arrow'}, ' → '),
              el('span', {
                className:'expr-value',
                style: `color: ${getValueColor(value)}`
              }, formatValue(value))
            ]);
            sourceDiv.append(lineDiv);
            continue;
          }
          
          // Static assignment: static.name = expr
          const staticMatch = trimmed.match(/^static\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
          if (staticMatch) {
            const [, varName, expr] = staticMatch;
            // Would need to fetch global vars to show value
            const lineDiv = el('div', {className:'expr-line expr-assignment'}, [
              el('span', {className:'expr-static'}, 'static.'),
              el('span', {className:'expr-var-name'}, varName),
              el('span', {className:'expr-eq'}, ' = '),
              el('span', {className:'expr-expr'}, expr)
            ]);
            sourceDiv.append(lineDiv);
            continue;
          }
          
          // Just display as-is
          sourceDiv.append(el('div', {
            className:'expr-line',
            textContent: line
          }));
        }
        
        body.append(sourceDiv);
      }
      
      // Display hardware writes
      const hwWrites = exprData.hw_writes || [];
      if (hwWrites.length > 0) {
        const hwDiv = el('div', {className:'expr-hw-writes'});
        const hwLabel = el('div', {
          className:'expr-section-label'
        }, '⚡ Hardware Writes');
        hwDiv.append(hwLabel);
        
        for (const hw of hwWrites) {
          const hwRow = el('div', {className:'expr-hw-row'}, [
            el('span', {className:'expr-hw-type'}, hw.type.toUpperCase()),
            el('span', {className:'expr-hw-ch'}, `[${hw.channel}]`),
            el('span', {className:'expr-hw-eq'}, ' ← '),
            el('span', {
              className:'expr-hw-value',
              style: hw.type === 'do' ? `color:${hw.value ? '#2faa60' : '#d84a4a'}` : `color: ${getValueColor(hw.value)}`
            }, hw.type === 'do' ? (hw.value ? 'ON' : 'OFF') : formatValue(hw.value))
          ]);
          hwDiv.append(hwRow);
        }
        
        body.append(hwDiv);
      }
    }
  } catch (e) {
    console.error('Failed to fetch expression source:', e);
    // Fall back to simple display
    if (showSource && exprData.locals) {
      const varsDiv = el('div', {className:'expr-vars'});
      for (const [name, value] of Object.entries(exprData.locals)) {
        varsDiv.append(el('div', {className:'expr-var-row'}, [
          el('span', {className:'expr-var-name'}, name),
          el('span', {}, ' = '),
          el('span', {
            style: `color: ${getValueColor(value)}`
          }, formatValue(value))
        ]));
      }
      body.append(varsDiv);
    }
  }
  
  // Show final output
  if (showOutput) {
    const outputDiv = el('div', {className:'expr-output'}, [
      el('span', {className:'expr-output-label'}, '► Output: '),
      el('span', {
        className:'expr-output-value',
        style: `color: ${getValueColor(exprData.output)};font-weight:700;font-size:16px`
      }, formatValue(exprData.output))
    ]);
    body.append(outputDiv);
  }
  
  root.append(header, body);
}
