// ADD THIS TO normalizeLayoutPages() function in app.js
// Around line 2005, in the switch statement after the pidpanel case

      case 'motor':
        w.opts.title = w.opts.title ?? 'Motor';
        w.opts.motorIndex = Number.isInteger(w.opts.motorIndex) ? w.opts.motorIndex : 0;
        w.opts.showControls = (w.opts.showControls !== false);
        break;
